// Replays the CLI dump against Rotorflight SITL using the site's own MSP and CLI
// code. Start SITL (same firmware commit) first, then:
//   node test/sitl-cli.test.mjs [--save]
// SITL has no real board resources, so hardware lines (resource/timer/dma/
// board_name/...) are expected to fail there; every other line must apply.
import { readFile } from "node:fs/promises";
import { MspClient } from "../site/js/msp.js";
import { CliSession, prepareCliScript } from "../site/js/cli.js";
import { connectTcp } from "./tcp-transport.mjs";

const HARDWARE_ONLY = /^(resource|timer|dma|board_name|board_design|manufacturer_id)\b/;

const transport = await connectTcp();
const msp = new MspClient(transport);
const before = await msp.identify();
console.log("SITL:", before);
msp.dispose();

const text = await readFile(new URL("../site/config/RTFL_cli_Bo105_Zi_20261125_213215.txt", import.meta.url), "utf8");
// board identity lines halt SITL (its board_name is "SITL"); the web tool checks identity over MSP instead.
const lines = prepareCliScript(text).filter((l) => !/^(board_name|board_design|manufacturer_id)\b/.test(l));
console.log(`Script: ${lines.length} lines`);

const cli = new CliSession(transport);
await cli.enter();
const t0 = Date.now();
const errors = await cli.run(lines, { onProgress: (i, n, l) => process.env.TRACE && console.log(i, l) });
console.log(`Applied in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const hardware = errors.filter((e) => HARDWARE_ONLY.test(e.line));
const real = errors.filter((e) => !HARDWARE_ONLY.test(e.line));
console.log(`Errors on hardware-only lines (expected in SITL): ${hardware.length}`);
for (const e of hardware.slice(0, 5)) console.log("   ", e.line, "->", e.error);
console.log(`Errors on other lines: ${real.length}`);
for (const e of real) console.log("  !", e.line, "->", e.error);

// Spot-check that values landed.
for (const probe of ["get gov_mode", "get swash_type", "get main_rotor_dir", "get name"]) {
  const { output } = await cli.command(probe);
  console.log(probe, "=>", output.split(/\r?\n/).filter((l) => / = /.test(l)).join(" | "));
}

if (process.argv.includes("--save")) {
  // SITL always has (expected) errors, so the plain save must be refused...
  const refused = await cli.save().then(() => false, (e) => /refused/.test(e.message));
  console.log("plain save refused because of batch errors:", refused);
  // ...and the explicit "save anyway" path must go through.
  await cli.saveAnyway();
  console.log("save anyway acknowledged");
}
cli.dispose();
await transport.close();
process.exit(real.length ? 1 : 0);
