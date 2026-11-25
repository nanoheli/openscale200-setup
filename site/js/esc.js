// AM32 ESC update over the flight controller's 4-way passthrough:
//   1. blank the EEPROM (boot byte cleared, so an interrupted flash leaves the
//      ESC safely in its bootloader)
//   2. flash the AM32 firmware image and read it back
//   3. init the EEPROM: boot byte 0x01, layout version, firmware version,
//      tune and CAN area blank (0xFF)
//   4. apply the .ecf settings (48 bytes) and read everything back
//
// Memory map of a 32 KB AM32 part (F051/F421 class, bootloader signature 0x1F06):
//   0x0000-0x0FFF bootloader | 0x1000-0x7BFF firmware (tag at 0x7BE0) | 0x7C00 EEPROM
// The AM32 bootloader erases a 1 KB page whenever a write starts on a page
// boundary, so the firmware is written page by page, in order, 256 bytes at a time.

import { IF_MODE_ARM } from "./fourway.js";

export const AM32 = {
  flashBase: 0x08000000,
  firmwareStart: 0x1000,
  eepromStart: 0x7c00,
  tagAddress: 0x7be0,
  tagLength: 32,
  pageSize: 0x400,
  chunk: 0x100,
  eepromSize: 192, // sizeof(EEprom_t): 48 settings + 128 tune + 16 CAN
  settingsSize: 48,
  flashCode32k: 0x1f,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tagString = (bytes) => {
  const end = bytes.findIndex((b) => b === 0 || b === 0xff);
  return String.fromCharCode(...bytes.slice(0, end < 0 ? bytes.length : end));
};

// Contiguous image from firmwareStart up to the EEPROM, gaps filled with 0xFF.
export function buildFirmwareImage(hex) {
  const start = AM32.flashBase + AM32.firmwareStart;
  const end = AM32.flashBase + AM32.eepromStart;
  const image = new Uint8Array(end - start).fill(0xff);
  for (const block of hex.data) {
    if (block.address < start || block.address + block.bytes > end) {
      throw new Error(
        `ESC firmware writes outside the application area (0x${block.address.toString(16)}). ` +
          "It is not an AM32 image for a 32 KB ESC.",
      );
    }
    image.set(block.data, block.address - start);
  }
  const tag = tagString(Array.from(image.slice(AM32.tagAddress - AM32.firmwareStart, AM32.tagAddress - AM32.firmwareStart + AM32.tagLength)));
  return { image, tag };
}

// Byte 2 (bootloader version) is replaced by the bootloader on every EEPROM
// write, so it is never compared.
const EEPROM_BOOTLOADER_BYTE = 2;

export function buildInitEeprom({ eepromVersion, fwMajor, fwMinor, bootloaderVersion = 0 }) {
  const e = new Uint8Array(AM32.eepromSize).fill(0xff);
  e.set([0x01, eepromVersion, bootloaderVersion, fwMajor, fwMinor], 0);
  return e;
}

export function buildConfigEeprom(init, ecf) {
  if (ecf.length !== AM32.settingsSize) throw new Error(`ESC config must be ${AM32.settingsSize} bytes`);
  const e = Uint8Array.from(init);
  e.set(ecf.slice(5), 5); // settings only; identity bytes 0-4 come from the init image
  return e;
}

export function sameExceptBootloaderByte(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (i !== EEPROM_BOOTLOADER_BYTE && a[i] !== b[i]) return false;
  return true;
}

export function describeEeprom(bytes) {
  return {
    valid: bytes[0] === 0x01,
    eepromVersion: bytes[1],
    bootloader: bytes[2],
    firmware: `${bytes[3]}.${String(bytes[4]).padStart(2, "0")}`,
  };
}

// Human-readable summary of the main settings in an AM32 EEPROM image.
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

export class Am32Updater {
  // fw: FourWayClient; firmware: { image, tag, eepromVersion, fwMajor, fwMinor }
  constructor(fw, firmware, log = () => {}) {
    this.fw = fw;
    this.firmware = firmware;
    this.log = log;
  }

  async readBlock(address, length) {
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += AM32.chunk) {
      const n = Math.min(AM32.chunk, length - off);
      out.set(await this.fw.read(address + off, n), off);
    }
    return out;
  }

  async writeEeprom(bytes) {
    // 192 bytes starting on the page boundary: the bootloader erases the page first.
    await this.fw.write(AM32.eepromStart, bytes);
    return this.readBlock(AM32.eepromStart, AM32.eepromSize);
  }

  // Writes one 1 KB page (first chunk erases it). Retried as a whole page.
  async writePage(pageOffset, attempts = 3) {
    const { image } = this.firmware;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        for (let off = pageOffset; off < pageOffset + AM32.pageSize && off < image.length; off += AM32.chunk) {
          await this.fw.write(AM32.firmwareStart + off, image.subarray(off, off + AM32.chunk));
        }
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Page 0x${(AM32.firmwareStart + pageOffset).toString(16)}: ${err.message}, retrying`);
        await sleep(100);
      }
    }
    throw lastErr;
  }

  // onStatus(phase, text), onProgress(fraction 0..1 over the whole job)
  async update(index, ecf, { onStatus = () => {}, onProgress = () => {} } = {}) {
    const { image, tag } = this.firmware;
    const name = `ESC ${index + 1}`;

    onStatus("connect", "Connecting to the ESC bootloader…");
    const dev = await this.fw.initFlash(index);
    if (dev.mode !== IF_MODE_ARM || dev.flashCode !== AM32.flashCode32k) {
      throw new Error(
        `Unexpected ESC (bootloader signature 0x${dev.signature.toString(16)}, mode ${dev.mode}). ` +
          "This update is only for the OpenScale 200's AM32 ESCs.",
      );
    }
    const oldEeprom = await this.readBlock(AM32.eepromStart, AM32.eepromSize);
    const oldTag = tagString(Array.from(await this.fw.read(AM32.tagAddress, AM32.tagLength)));
    const old = describeEeprom(oldEeprom);
    this.log(`${name}: bootloader v${oldEeprom[2]}, pin 0x${dev.bootPin.toString(16)}, ` +
      (old.valid ? `AM32 ${old.firmware} "${oldTag}", EEPROM layout v${old.eepromVersion}` : "no valid AM32 EEPROM"));
    const accepted = this.firmware.acceptTags ?? [tag];
    if (oldTag && /^[\x20-\x7e]+$/.test(oldTag) && !accepted.includes(oldTag)) {
      throw new Error(`${name} runs firmware for "${oldTag}", but the update is for "${tag}". Not flashing a different ESC target.`);
    }
    const total = image.length * 2 + 2 * AM32.eepromSize;
    let done = 0;
    const step = (n) => onProgress((done += n) / total);

    // 1. blank EEPROM: the bootloader no longer jumps to a half-written app
    onStatus("flash", "Clearing settings…");
    const blank = new Uint8Array(AM32.eepromSize).fill(0xff);
    const cleared = await this.writeEeprom(blank);
    if (!sameExceptBootloaderByte(cleared, blank)) throw new Error(`${name}: could not clear the EEPROM`);
    // The bootloader stamps its own version into byte 2 of every EEPROM write.
    const bootloaderVersion = cleared[EEPROM_BOOTLOADER_BYTE];

    // 2. firmware
    onStatus("flash", `Flashing AM32 ${this.firmware.fwMajor}.${this.firmware.fwMinor}…`);
    for (let page = 0; page < image.length; page += AM32.pageSize) {
      await this.writePage(page);
      step(Math.min(AM32.pageSize, image.length - page));
    }
    onStatus("verify", "Verifying firmware…");
    for (let off = 0; off < image.length; off += AM32.chunk) {
      const n = Math.min(AM32.chunk, image.length - off);
      const back = await this.fw.read(AM32.firmwareStart + off, n);
      for (let i = 0; i < n; i++) {
        if (back[i] !== image[off + i]) {
          throw new Error(`${name}: firmware verification failed at 0x${(AM32.firmwareStart + off + i).toString(16)}`);
        }
      }
      step(n);
    }
    this.log(`${name}: firmware written and verified (${image.length} bytes)`);

    try {
      // 3. init memory
      onStatus("init", "Initialising memory…");
      const init = buildInitEeprom({ ...this.firmware, bootloaderVersion });
      if (!sameExceptBootloaderByte(await this.writeEeprom(init), init)) throw new Error(`${name}: EEPROM init did not verify`);
      step(AM32.eepromSize);

      // 4. settings
      onStatus("config", "Applying settings…");
      const config = buildConfigEeprom(init, ecf);
      const after = await this.writeEeprom(config);
      if (!sameExceptBootloaderByte(after, config)) throw new Error(`${name}: settings did not verify`);
      step(AM32.eepromSize);
      this.log(`${name}: EEPROM initialised and settings applied`);
      return { before: old, after: describeEeprom(after), oldTag };
    } catch (err) {
      // Never leave the ESC able to start with half-written settings.
      await this.fw.write(AM32.eepromStart, blank).catch(() => {});
      throw err;
    }
  }
}
