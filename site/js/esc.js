// AM32 ESC configuration through Rotorflight's MSP forward-programming bridge
// (MSP_SET_4WIF_ESC_FWD_PROG + MSP_ESC_PARAMETERS / MSP_SET_ESC_PARAMETERS).
// Same handshake and timings as the Configurator's ESC programming tab
// (src/tabs/esc_programming, manufacturers/am32.js).
//
// MSP_ESC_PARAMETERS returns a 2-byte header [signature, version|flags]
// followed by the ESC's raw 48-byte AM32 EEPROM, which is exactly the format
// of an AM32 configurator .ecf file.

import { MSP } from "./msp.js";

export const AM32_SIGNATURE = 0xc2;
export const AM32_EEPROM_BYTES = 48;
const HEADER_RDONLY = 0x40;
const DESELECT = 100;

// EEPROM bytes that describe the ESC itself rather than settings. These are
// kept as the ESC reports them; only the settings are taken from the file.
const IDENTITY = { start: 0, eepromVersion: 1, bootloader: 2, fwMajor: 3, fwMinor: 4 };
const IDENTITY_BYTES = 5;

const TIMING = {
  preSwitchDelayMs: 800,
  switchReadDelayMs: 4000,
  pollIntervalMs: 600,
  detectTimeoutMs: 20000,
  switchRetries: 3,
  postSaveSettleMs: 1000,
  postSaveReturnMs: 1000,
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export function describeEeprom(bytes) {
  return {
    eepromVersion: bytes[IDENTITY.eepromVersion],
    bootloader: bytes[IDENTITY.bootloader],
    firmware: `${bytes[IDENTITY.fwMajor]}.${String(bytes[IDENTITY.fwMinor]).padStart(2, "0")}`,
  };
}

// Human-readable summary of the main settings in an AM32 EEPROM image
// (same field positions as the Configurator's AM32 definition).
export function summarizeSettings(b) {
  // AM32 >= 2.18 stores timing as 10 + degrees / 0.9375; older files use 0-3 (x 7.5°).
  const timing = b[23] >= 10 ? `${((b[23] - 10) * 0.9375).toFixed(1)}°` : `${b[23] * 7.5}°`;
  return [
    ["Direction", b[17] ? "Reversed" : "Normal"],
    ["Motor KV", b[26] * 40 + 20],
    ["Motor poles", b[27]],
    ["Timing", timing],
    ["PWM frequency", `${b[24]} kHz`],
    ["Startup power", `${b[25]} %`],
    ["Max ramp", b[5]],
    ["Temperature limit", b[43] > 140 ? "Off" : `${b[43]} °C`],
    ["Current limit", b[44] > 100 ? "Off" : `${b[44] * 2} A`],
  ];
}

export function buildWritePayload(current, file) {
  const eeprom = Uint8Array.from(file);
  for (let i = 0; i < IDENTITY_BYTES; i++) eeprom[i] = current[i];
  return Uint8Array.from([AM32_SIGNATURE, 0x00, ...eeprom]);
}

export class EscProgrammer {
  constructor(msp, log = () => {}, timing = {}) {
    this.msp = msp;
    this.log = log;
    this.t = { ...TIMING, ...timing };
  }

  async selectTarget(target) {
    // The FC blocks ~2.5 s entering the bootloader bridge before it answers.
    await this.msp.request(MSP.SET_4WIF_ESC_FWD_PROG, [target & 0xff], { timeoutMs: 8000, retries: 1 });
  }

  async deselect() {
    try {
      await this.selectTarget(DESELECT);
    } catch {
      /* best effort */
    }
  }

  async readOnce() {
    try {
      const resp = await this.msp.request(MSP.ESC_PARAMETERS, [], { timeoutMs: 3000, retries: 0 });
      return resp;
    } catch {
      return null;
    }
  }

  async poll(signal) {
    const deadline = Date.now() + this.t.detectTimeoutMs;
    while (Date.now() < deadline) {
      const resp = await this.readOnce();
      if (resp && resp.length >= 2 + AM32_EEPROM_BYTES && resp[0] === AM32_SIGNATURE) return resp;
      if (resp && resp.length >= 2 && resp[0] !== 0 && resp[0] !== AM32_SIGNATURE) {
        throw new Error(`This ESC is not running AM32 (signature 0x${resp[0].toString(16)}).`);
      }
      await sleep(this.t.pollIntervalMs, signal);
    }
    return null;
  }

  // Selects an ESC and returns its 50-byte parameter block.
  async connect(index, signal) {
    for (let attempt = 0; attempt <= this.t.switchRetries; attempt++) {
      await this.selectTarget(DESELECT).catch(() => {});
      await sleep(this.t.preSwitchDelayMs, signal);
      await this.selectTarget(index);
      await sleep(this.t.switchReadDelayMs, signal);
      const resp = await this.poll(signal);
      if (resp) return resp;
      this.log(`ESC ${index + 1}: no answer, retrying (${attempt + 1}/${this.t.switchRetries})`);
    }
    throw new Error(
      "The ESC did not answer. Check that the flight battery is connected and the ESC signal wire is plugged in.",
    );
  }

  // Writes `file` (48-byte .ecf) to ESC `index` and verifies it.
  // onStatus(text) reports progress; returns { before, after, changed }.
  async program(index, file, { onStatus = () => {}, signal } = {}) {
    if (file.length !== AM32_EEPROM_BYTES) throw new Error(`Config file must be ${AM32_EEPROM_BYTES} bytes.`);

    onStatus("Connecting to ESC…");
    const current = await this.connect(index, signal);
    if (current[1] & HEADER_RDONLY) throw new Error("The flight controller is armed. Disarm and try again.");
    const before = current.slice(2, 2 + AM32_EEPROM_BYTES);
    const esc = describeEeprom(before);
    const wanted = describeEeprom(file);
    this.log(`ESC ${index + 1}: AM32 ${esc.firmware}, EEPROM layout v${esc.eepromVersion}, bootloader v${esc.bootloader}`);

    if (esc.eepromVersion !== wanted.eepromVersion) {
      throw new Error(
        `This ESC uses AM32 settings layout v${esc.eepromVersion}, but the setup file was made for v${wanted.eepromVersion} ` +
          `(AM32 ${wanted.firmware}). Update the ESC firmware first.`,
      );
    }
    if (esc.firmware !== wanted.firmware) {
      this.log(`ESC ${index + 1}: note: file was saved from AM32 ${wanted.firmware}, ESC runs ${esc.firmware}`);
    }

    const payload = buildWritePayload(before, file);
    const expected = payload.slice(2);
    const changed = expected.some((v, i) => v !== before[i]);
    if (!changed) {
      onStatus("Already configured");
      this.log(`ESC ${index + 1}: settings already match, nothing to write`);
      return { before, after: before, changed: false, esc };
    }

    onStatus("Writing settings…");
    await this.msp.request(MSP.SET_ESC_PARAMETERS, Array.from(payload), { timeoutMs: 8000, retries: 0 });

    // The bridge is left in an undefined state after an EEPROM write: deselect
    // (which also flushes the pending write to the ESC), then select again.
    onStatus("Verifying…");
    await sleep(this.t.postSaveSettleMs, signal);
    await this.selectTarget(DESELECT).catch(() => {});
    await sleep(this.t.postSaveReturnMs, signal);
    const reread = await this.connect(index, signal);
    const after = reread.slice(2, 2 + AM32_EEPROM_BYTES);
    const mismatch = [];
    for (let i = IDENTITY_BYTES; i < AM32_EEPROM_BYTES; i++) if (after[i] !== expected[i]) mismatch.push(i);
    if (mismatch.length) {
      throw new Error(`The ESC did not keep ${mismatch.length} setting byte(s) (offsets ${mismatch.join(", ")}).`);
    }
    onStatus("Done");
    this.log(`ESC ${index + 1}: settings written and verified`);
    return { before, after, changed: true, esc };
  }
}
