// Offline tests: node test/unit.test.mjs
//  - HEX parsing + custom-defaults insertion match rotorflight-configurator byte for byte
//    (set CONFIGURATOR_DIR to a rotorflight-configurator checkout to enable)
//  - DFU flasher against a simulated STM32 DfuSe bootloader
//  - AM32 ESC flash + EEPROM init + config against a simulated 4-way interface and AM32 bootloader
//  - CLI script preparation
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseHex, insertConfig, buildCustomDefaults } from "../site/js/hex.js";
import { DfuDevice, parseFlashDescriptor } from "../site/js/dfu.js";
import { MspClient, MSP } from "../site/js/msp.js";
import { Am32Updater, buildFirmwareImage, summarizeSettings } from "../site/js/esc.js";
import { FourWayClient, crc16xmodem } from "../site/js/fourway.js";
import { prepareCliScript } from "../site/js/cli.js";
import { SETUP } from "../site/js/setup-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = (p) => path.join(here, "..", "site", p);
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.stack}`);
    process.exitCode = 1;
  }
}

const hexText = await readFile(site(SETUP.firmware.hex), "utf8");
const configText = await readFile(site(SETUP.firmware.targetConfig), "utf8");
const defaults = buildCustomDefaults(configText, {
  configName: SETUP.firmware.targetConfigName,
  boardName: SETUP.board.name,
  manufacturerId: SETUP.board.manufacturer,
  commitInfo: SETUP.firmware.targetsCommit,
});

// ---------------------------------------------------------------------------
await test("custom defaults string", () => {
  assert.ok(defaults.startsWith("## Rotorflight Custom Defaults\n"));
  assert.match(defaults, /^board_name GOOSKY_F4MINI$/m);
  assert.match(defaults, /^resource MOTOR 1 C08$/m);
  assert.doesNotMatch(defaults, /\r/);
});

await test("firmware image builds and has room for the defaults", () => {
  const hex = insertConfig(parseHex(hexText), defaults);
  assert.equal(hex.data[0].address, 0x08000000);
  const last = hex.data[hex.data.length - 1];
  assert.ok(last.address + last.bytes <= 0x08100000, "fits in 1 MB");
});

const CONFIGURATOR_DIR = process.env.CONFIGURATOR_DIR;
if (CONFIGURATOR_DIR && existsSync(CONFIGURATOR_DIR)) {
  await test("HEX + config identical to rotorflight-configurator", async () => {
    // hex_parser.js is a worker script: run it with a captured postMessage.
    const parserSrc = await readFile(path.join(CONFIGURATOR_DIR, "src/js/workers/hex_parser.js"), "utf8");
    let theirs;
    const run = new Function("postMessage", "close", "console", parserSrc + "\nreturn read_hex_file;");
    run((r) => (theirs = r), () => {}, { time() {}, timeEnd() {}, log() {} })(hexText);
    const { ConfigInserter } = await import(pathToFileURL(path.join(CONFIGURATOR_DIR, "src/js/ConfigInserter.js")));
    const quiet = { time: console.time, timeEnd: console.timeEnd };
    console.time = console.timeEnd = () => {};
    new ConfigInserter().insertConfig(theirs, defaults);
    Object.assign(console, quiet);

    const ours = insertConfig(parseHex(hexText), defaults);
    assert.equal(ours.bytes_total, theirs.bytes_total);
    assert.equal(ours.data.length, theirs.data.length);
    ours.data.forEach((b, i) => {
      assert.equal(b.address, theirs.data[i].address);
      assert.deepEqual(b.data, theirs.data[i].data);
    });
  });
} else {
  console.log("skip HEX comparison with rotorflight-configurator (set CONFIGURATOR_DIR)");
}

// ---------------------------------------------------------------------------
// Simulated STM32 ROM DFU bootloader (DfuSe), F405 layout, 1 MB.
class FakeDfu {
  constructor({ transferSize = 2048 } = {}) {
    this.vendorId = 0x0483;
    this.productId = 0xdf11;
    this.opened = false;
    this.configuration = null;
    this.layout = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg";
    this.parsed = parseFlashDescriptor(this.layout);
    this.flash = new Uint8Array(this.parsed.totalSize).fill(0x00); // "old firmware"
    this.transferSize = transferSize;
    this.state = 2;
    this.pending = null;
    this.addr = 0x08000000;
    this.left = false;
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() { this.configuration = {}; }
  async claimInterface() {}
  async releaseInterface() {}
  async selectAlternateInterface() {}
  str(s) {
    const b = [2 + s.length * 2, 3];
    for (const c of s) b.push(c.charCodeAt(0), 0);
    return b;
  }
  configDescriptor() {
    const iface = (alt, iStr) => [9, 4, 0, alt, 0, 0xfe, 1, 2, iStr];
    const func = [9, 0x21, 0x0b, 0xff, 0x00, this.transferSize & 0xff, this.transferSize >> 8, 0x1a, 0x01];
    const body = [...iface(0, 4), ...iface(1, 5), ...func];
    const total = 9 + body.length;
    return [9, 2, total & 0xff, total >> 8, 1, 1, 0, 0xc0, 50, ...body];
  }
  reply(bytes, length) {
    const u8 = Uint8Array.from(bytes.slice(0, length));
    return { status: "ok", data: new DataView(u8.buffer) };
  }
  async controlTransferIn(setup, length) {
    if (setup.requestType === "standard") {
      const type = setup.value >> 8;
      const index = setup.value & 0xff;
      if (type === 2) return this.reply(this.configDescriptor(), length);
      if (type === 3 && index === 0) return this.reply([4, 3, 0x09, 0x04], length);
      if (type === 3 && index === 4) return this.reply(this.str(this.layout), length);
      if (type === 3 && index === 5) return this.reply(this.str("@Option Bytes  /0x1FFFC000/01*016 e"), length);
      return { status: "stall" };
    }
    switch (setup.request) {
      case 3: { // GETSTATUS executes the pending download
        if (this.pending) {
          if (this.state !== 4) {
            this.state = 4; // dfuDNBUSY
            return this.reply([0, 2, 0, 0, this.state, 0], length);
          }
          const ok = this.execute(this.pending);
          this.pending = null;
          this.state = ok ? 5 : 10;
          return this.reply([ok ? 0 : 3, 0, 0, 0, this.state, 0], length);
        }
        return this.reply([0, 0, 0, 0, this.state, 0], length);
      }
      case 2: { // UPLOAD
        if (this.state !== 2 && this.state !== 9) throw new Error(`UPLOAD in state ${this.state}`);
        this.state = 9;
        const start = this.addr - 0x08000000 + (setup.value - 2) * this.transferSize;
        return this.reply(Array.from(this.flash.slice(start, start + length)), length);
      }
      default:
        return { status: "stall" };
    }
  }
  async controlTransferOut(setup, data) {
    const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    switch (setup.request) {
      case 1: // DNLOAD
        if (bytes.length === 0) {
          this.left = true;
          return { status: "ok" };
        }
        this.pending = { block: setup.value, data: Uint8Array.from(bytes) };
        this.state = 3;
        return { status: "ok" };
      case 4: // CLRSTATUS
      case 6: // ABORT
        this.state = 2;
        this.pending = null;
        return { status: "ok" };
      default:
        return { status: "stall" };
    }
  }
  execute({ block, data }) {
    const le = (d) => (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
    if (block === 0) {
      if (data[0] === 0x21) {
        this.addr = le(data);
        return true;
      }
      if (data[0] === 0x41) {
        const a = le(data) - 0x08000000;
        const sector = this.parsed.sectors.find((s) => a >= s.startAddress - 0x08000000 && a < s.startAddress - 0x08000000 + s.totalSize);
        const off = sector.startAddress - 0x08000000 + Math.floor((a - (sector.startAddress - 0x08000000)) / sector.pageSize) * sector.pageSize;
        this.flash.fill(0xff, off, off + sector.pageSize);
        return true;
      }
      return false;
    }
    const start = this.addr - 0x08000000 + (block - 2) * this.transferSize;
    for (let i = 0; i < data.length; i++) this.flash[start + i] &= data[i]; // flash can only clear bits
    return true;
  }
}

await test("DFU: erase, write, verify, leave against a simulated F405 bootloader", async () => {
  const hex = insertConfig(parseHex(hexText), defaults);
  const dev = new FakeDfu();
  const dfu = new DfuDevice(dev);
  await dfu.open();
  assert.equal(dfu.memory.totalSize, 1024 * 1024);
  assert.equal(dfu.transferSize, 2048);
  const phases = [];
  await dfu.flash(hex, { onPhase: (p) => phases.push(p) });
  assert.deepEqual(phases, ["erase", "write", "verify"]);
  const expected = new Uint8Array(dev.flash.length).fill(0xff);
  for (const b of hex.data) expected.set(b.data, b.address - 0x08000000);
  assert.ok(Buffer.from(dev.flash).equals(Buffer.from(expected)), "flash content matches image");
  await dfu.leave();
  assert.ok(dev.left, "device told to leave DFU");
});

await test("DFU: verify catches a bad write", async () => {
  const hex = insertConfig(parseHex(hexText), defaults);
  const dev = new FakeDfu();
  const realExecute = dev.execute.bind(dev);
  let n = 0;
  dev.execute = (p) => {
    if (p.block >= 2 && ++n === 40) p.data[100] ^= 0xff; // corrupt one chunk
    return realExecute(p);
  };
  const dfu = new DfuDevice(dev);
  await dfu.open();
  await assert.rejects(dfu.flash(hex), /Verification failed/);
});

// ---------------------------------------------------------------------------
// Simulated FC 4-way interface (io/serial_4way.c) with AM32 F421 bootloaders
// (AM32-bootloader main.c + Mcu/f421 save_flash_nolib) behind it.
class FakeAm32Esc {
  constructor({ tag = "GOOSKY_3S_F421", oldEeprom = null, blVersion = 12 } = {}) {
    this.flash = new Uint8Array(0x8000).fill(0xff);
    this.blVersion = blVersion;
    const t = new TextEncoder().encode(tag);
    this.flash.set(t, 0x7be0);
    for (let i = t.length; i < 32; i++) this.flash[0x7be0 + i] = 0;
    if (oldEeprom) this.flash.set(oldEeprom, 0x7c00);
    this.failWriteAt = null; // address whose first write fails
  }
  write(addr, data) {
    if (addr < 0x1000 || (addr & 3) || (data.length & 3)) return false;
    if (this.failWriteAt === addr) {
      this.failWriteAt = null;
      return false;
    }
    const buf = Uint8Array.from(data);
    if (addr === 0x7c00 && buf.length > 2) buf[2] = this.blVersion;
    if (addr % 0x400 === 0) this.flash.fill(0xff, addr, addr + 0x400); // page erase
    for (let i = 0; i < buf.length; i++) this.flash[addr + i] &= buf[i];
    for (let i = 0; i < buf.length; i++) if (this.flash[addr + i] !== buf[i]) return false;
    return true;
  }
}

function fake4WayFc(escs) {
  const listeners = new Set();
  const st = { mode: "msp", resets: [], exited: false };
  const rx = [];
  const emit = (bytes) => setTimeout(() => listeners.forEach((fn) => fn(Uint8Array.from(bytes))), 1);
  const mspReply = (code, payload) => {
    let ck = payload.length ^ code;
    for (const b of payload) ck ^= b;
    emit([0x24, 0x4d, 0x3e, payload.length, code, ...payload, ck]);
  };
  const fwReply = (cmd, addr, params, ack) => {
    const p = params.length ? params : [0];
    const f = [0x2e, cmd, addr >> 8, addr & 0xff, p.length === 256 ? 0 : p.length, ...p, ack];
    const crc = crc16xmodem(f);
    emit([...f, crc >> 8, crc & 0xff]);
  };
  let selected = -1;
  const handle4 = (cmd, addr, params) => {
    const esc = escs[selected];
    switch (cmd) {
      case 0x32:
        return fwReply(cmd, addr, [...new TextEncoder().encode("m4wFCIntf")], 0);
      case 0x37:
        if (params[0] >= escs.length) return fwReply(cmd, addr, [0], 0x08);
        selected = params[0];
        return fwReply(cmd, 0, [0x06, 0x1f, 0x22, 4], 0);
      case 0x3a: {
        const n = params[0] === 0 ? 256 : params[0];
        return fwReply(cmd, addr, Array.from(esc.flash.slice(addr, addr + n)), 0);
      }
      case 0x3b:
        return fwReply(cmd, addr, [0], esc.write(addr, params) ? 0 : 0x0f);
      case 0x35:
        st.resets.push(params[0]);
        return fwReply(cmd, addr, [0], 0);
      case 0x34:
        st.mode = "msp";
        st.exited = true;
        return fwReply(cmd, addr, [0], 0);
      default:
        return fwReply(cmd, addr, [0], 0x02);
    }
  };
  return {
    st,
    transport: {
      onData(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      onClose() {
        return () => {};
      },
      async close() {},
      async write(bytes) {
        rx.push(...bytes);
        for (;;) {
          if (st.mode === "msp") {
            const i = rx.indexOf(0x24);
            if (i < 0 || rx.length < i + 6) return;
            rx.splice(0, i);
            const size = rx[3];
            if (rx.length < 6 + size) return;
            const f = rx.splice(0, 6 + size);
            if (f[4] === MSP.SET_PASSTHROUGH) {
              mspReply(f[4], [escs.length]);
              st.mode = "4way";
            } else mspReply(f[4], []);
          } else {
            const i = rx.indexOf(0x2f);
            if (i < 0 || rx.length < i + 5) return;
            rx.splice(0, i);
            const len = rx[4] === 0 ? 256 : rx[4];
            if (rx.length < 5 + len + 2) return;
            const f = rx.splice(0, 5 + len + 2);
            const crc = crc16xmodem(f.slice(0, 5 + len));
            if (((f[5 + len] << 8) | f[6 + len]) !== crc) {
              fwReply(f[1], 0, [0], 0x03);
              continue;
            }
            handle4(f[1], (f[2] << 8) | f[3], f.slice(5, 5 + len));
          }
        }
      },
    },
  };
}

const mainFile = new Uint8Array(await readFile(site(SETUP.escs[0].file)));
const tailFile = new Uint8Array(await readFile(site(SETUP.escs[1].file)));
const escHex = parseHex(await readFile(site(SETUP.escFirmware.hex), "utf8"));
const escFw = { ...SETUP.escFirmware, ...buildFirmwareImage(escHex) };

await test(".ecf files are AM32 2.19 / EEPROM v3 images", () => {
  const f0 = SETUP.escFirmware;
  for (const f of [mainFile, tailFile]) {
    assert.equal(f.length, 48);
    assert.deepEqual([f[0], f[1], f[3], f[4]], [1, f0.eepromVersion, f0.fwMajor, f0.fwMinor]);
  }
  const main = Object.fromEntries(summarizeSettings(mainFile));
  assert.equal(main["Motor KV"], 500);
  assert.equal(main["Motor poles"], 24);
  assert.equal(main.Timing, "15.0°");
});

await test("ESC firmware image: AM32 app area only, tag matches", () => {
  assert.equal(escFw.tag, SETUP.escFirmware.tag);
  assert.equal(escFw.image.length, 0x7c00 - 0x1000);
  assert.equal(escFw.image.length % 0x400, 0);
});

async function runUpdate(escs, files) {
  const sim = fake4WayFc(escs);
  const msp = new MspClient(sim.transport);
  const reply = await msp.request(MSP.SET_PASSTHROUGH);
  msp.dispose();
  const fw = new FourWayClient(sim.transport);
  assert.equal(await fw.interfaceName(), "m4wFCIntf");
  const updater = new Am32Updater(fw, escFw, () => {});
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      results.push(await updater.update(i, files[i]).then((r) => r, (e) => e));
      await fw.reset(i);
    }
  } finally {
    await fw.exit();
    fw.dispose();
  }
  return { sim, reply, results };
}

function expectFlashed(esc, ecf) {
  const app = esc.flash.slice(0x1000, 0x7c00);
  assert.ok(Buffer.from(app).equals(Buffer.from(escFw.image)), "firmware matches image");
  const e = esc.flash.slice(0x7c00, 0x7c00 + 192);
  assert.deepEqual(Array.from(e.slice(0, 5)), [1, 3, esc.blVersion, 2, 19], "identity bytes");
  assert.deepEqual(Array.from(e.slice(5, 48)), Array.from(ecf.slice(5)), "settings from .ecf");
  assert.ok(e.slice(48).every((b) => b === 0xff), "tune + CAN blank");
}

await test("ESC update: flash, init, configure both ESCs via 4-way", async () => {
  // Old factory EEPROM (layout v1, AM32 2.10) with unrelated settings.
  const old = new Uint8Array(192).fill(0x33);
  old.set([1, 1, 12, 2, 10], 0);
  const escs = [new FakeAm32Esc({ oldEeprom: old }), new FakeAm32Esc({ blVersion: 9 })];
  escs[0].flash.fill(0x00, 0x1000, 0x7000); // old firmware
  const { sim, reply, results } = await runUpdate(escs, [mainFile, tailFile]);
  assert.deepEqual(Array.from(reply), [2]);
  results.forEach((r) => assert.ok(!(r instanceof Error), r?.stack));
  expectFlashed(escs[0], mainFile);
  expectFlashed(escs[1], tailFile);
  assert.equal(results[0].before.firmware, "2.10");
  assert.equal(results[0].after.firmware, "2.19");
  assert.deepEqual(sim.st.resets, [0, 1]);
  assert.ok(sim.st.exited, "left 4-way mode");
});

await test("ESC update: a failed page write is retried from the page start", async () => {
  const escs = [new FakeAm32Esc()];
  escs[0].failWriteAt = 0x1100; // second chunk of the first page
  const { results } = await runUpdate(escs, [mainFile]);
  assert.ok(!(results[0] instanceof Error), results[0]?.stack);
  expectFlashed(escs[0], mainFile);
});

await test("ESC update: refuses an ESC with a different AM32 target", async () => {
  const escs = [new FakeAm32Esc({ tag: "OTHER_ESC_G071" })];
  const before = Uint8Array.from(escs[0].flash);
  const { results } = await runUpdate(escs, [mainFile]);
  assert.ok(results[0] instanceof Error && /OTHER_ESC_G071/.test(results[0].message));
  assert.ok(Buffer.from(escs[0].flash).equals(Buffer.from(before)), "nothing written");
});

await test("ESC update: settings failure leaves the ESC in its bootloader", async () => {
  const escs = [new FakeAm32Esc()];
  const esc = escs[0];
  const realWrite = esc.write.bind(esc);
  let eepromWrites = 0;
  // EEPROM writes: 1 = blank, 2 = init, 3 = settings (fails)
  esc.write = (addr, data) => (addr === 0x7c00 && ++eepromWrites === 3 ? false : realWrite(addr, data));
  const { results } = await runUpdate(escs, [mainFile]);
  assert.ok(results[0] instanceof Error);
  assert.notEqual(esc.flash[0x7c00], 0x01, "boot byte not set, ESC will not start");
});

await test("4-way frame encoding (CRC16-XMODEM)", () => {
  const f = FourWayClient.encode(0x32, 0, []);
  assert.deepEqual(Array.from(f.slice(0, 6)), [0x2f, 0x32, 0, 0, 1, 0]);
  assert.equal(crc16xmodem([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]), 0x31c3);
});

// ---------------------------------------------------------------------------
await test("CLI script preparation", async () => {
  const lines = prepareCliScript(await readFile(site(SETUP.cliDump), "utf8"));
  assert.equal(lines[0], "defaults nosave");
  assert.equal(lines[1], "batch start");
  assert.ok(!lines.some((l) => l.startsWith("#") || l === "save" || l.startsWith("mcu_id") || l.startsWith("signature")));
  assert.ok(lines.includes("board_name GOOSKY_F4MINI"));
  assert.ok(lines.includes("set name = Bo105_Zi"));
});

await test("MSP frame encoding", () => {
  assert.deepEqual(Array.from(MspClient.encode(1)), [0x24, 0x4d, 0x3c, 0, 1, 1]);
  assert.deepEqual(Array.from(MspClient.encode(244, [1])), [0x24, 0x4d, 0x3c, 1, 244, 1, 1 ^ 244 ^ 1]);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
