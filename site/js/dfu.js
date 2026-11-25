// STM32 DfuSe flasher over WebUSB.
// Follows the same sequence as rotorflight-configurator's stm32usbdfu.js:
// full chip erase (page by page), write, read-back verify, leave DFU.

export const DFU_FILTERS = [{ vendorId: 0x0483, productId: 0xdf11 }];
export const usbSupported = () => "usb" in navigator;

const REQ = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };
const STATE = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };

// Known-good layout of the STM32F405 internal flash, used if the descriptor can't be read.
const F405_LAYOUT = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseFlashDescriptor(str) {
  const parts = str.replace(/[^\x20-\x7E]+/g, "").split("/");
  if (parts.length < 3 || !parts[0].startsWith("@")) return null;
  const type = parts[0].trim().replace("@", "");
  const start = parseInt(parts[1], 16);
  const sectors = [];
  let total = 0;
  for (const group of parts[2].split(",")) {
    const [count, size] = group.split("*");
    let pageSize = parseInt(size, 10);
    if (!pageSize || !count) return null;
    const unit = size.slice(-2, -1);
    if (unit === "M") pageSize *= 1024 * 1024;
    else if (unit === "K") pageSize *= 1024;
    const numPages = parseInt(count, 10);
    sectors.push({ numPages, startAddress: start + total, pageSize, totalSize: numPages * pageSize });
    total += numPages * pageSize;
  }
  return { type, startAddress: start, sectors, totalSize: total };
}

export class DfuDevice {
  constructor(device, log = () => {}) {
    this.device = device;
    this.log = log;
    this.transferSize = 2048;
  }

  static async request() {
    return navigator.usb.requestDevice({ filters: DFU_FILTERS });
  }

  static async findPermitted() {
    const devices = await navigator.usb.getDevices();
    return devices.find((d) => d.vendorId === 0x0483 && d.productId === 0xdf11) ?? null;
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try {
        await d.claimInterface(0);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(300);
      }
    }
    if (lastErr) throw new Error("Could not claim the DFU interface: " + lastErr.message);
    try {
      await d.selectAlternateInterface(0, 0);
    } catch {
      /* alt 0 is the default */
    }
    await this.readDescriptors();
  }

  async close() {
    try {
      await this.device.releaseInterface(0);
    } catch {
      /* ignore */
    }
    try {
      await this.device.close();
    } catch {
      /* ignore */
    }
  }

  // ---- descriptors ---------------------------------------------------------

  async getDescriptor(type, index, length, langId = 0) {
    const r = await this.device.controlTransferIn(
      { requestType: "standard", recipient: "device", request: 6, value: (type << 8) | index, index: langId },
      length,
    );
    if (r.status !== "ok") throw new Error("descriptor read failed");
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async getString(index) {
    if (!index) return "";
    if (this.langId === undefined) {
      try {
        const l = await this.getDescriptor(3, 0, 255);
        this.langId = l.length >= 4 ? l[2] | (l[3] << 8) : 0x0409;
      } catch {
        this.langId = 0x0409;
      }
    }
    const s = await this.getDescriptor(3, index, 255, this.langId);
    let out = "";
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode(s[i] | (s[i + 1] << 8));
    return out;
  }

  async readDescriptors() {
    let layoutString = null;
    try {
      const head = await this.getDescriptor(2, 0, 9);
      const total = head[2] | (head[3] << 8);
      const cfg = await this.getDescriptor(2, 0, total);
      for (let i = 0; i < cfg.length; ) {
        const len = cfg[i];
        const type = cfg[i + 1];
        if (!len) break;
        if (type === 4 && cfg[i + 2] === 0 && cfg[i + 3] === 0) {
          // interface 0, alternate 0
          layoutString = await this.getString(cfg[i + 8]);
        } else if (type === 0x21 && len >= 7) {
          this.transferSize = cfg[i + 5] | (cfg[i + 6] << 8);
        }
        i += len;
      }
    } catch (err) {
      this.log(`Could not read DFU descriptors (${err.message}), using STM32F405 defaults.`);
    }
    this.layoutString = layoutString || F405_LAYOUT;
    this.memory = parseFlashDescriptor(this.layoutString);
    if (!this.memory || !/flash/i.test(this.memory.type) || this.memory.startAddress !== 0x08000000) {
      throw new Error(`Unexpected DFU memory layout: "${this.layoutString}"`);
    }
    if (!this.transferSize || this.transferSize > 4096) this.transferSize = 2048;
    this.log(`DFU device: ${this.memory.type}, ${this.memory.totalSize / 1024} KB, transfer size ${this.transferSize}`);
  }

  // ---- DFU requests --------------------------------------------------------

  async out(request, value, data = new Uint8Array(0)) {
    const r = await this.device.controlTransferOut(
      { requestType: "class", recipient: "interface", request, value, index: 0 },
      data,
    );
    if (r.status !== "ok") throw new Error(`DFU request ${request} failed (${r.status})`);
  }

  async in(request, value, length) {
    const r = await this.device.controlTransferIn(
      { requestType: "class", recipient: "interface", request, value, index: 0 },
      length,
    );
    if (r.status !== "ok") throw new Error(`DFU request ${request} failed (${r.status})`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async getStatus() {
    const d = await this.in(REQ.GETSTATUS, 0, 6);
    return { status: d[0], pollTimeout: d[1] | (d[2] << 8) | (d[3] << 16), state: d[4] };
  }

  // Same as the Configurator: CLRSTATUS until the device reports dfuIDLE. The
  // STM32 ROM bootloader keeps the address pointer across this.
  async clearStatus() {
    for (let i = 0; i < 10; i++) {
      const s = await this.getStatus();
      if (s.state === STATE.dfuIDLE) return;
      await sleep(s.pollTimeout);
      await this.out(REQ.CLRSTATUS, 0);
    }
    throw new Error("DFU device does not return to idle");
  }

  // After a DNLOAD, poll until the device has executed it.
  async waitDownload(what) {
    let s = await this.getStatus();
    for (let i = 0; s.state === STATE.dfuDNBUSY && i < 200; i++) {
      await sleep(Math.max(s.pollTimeout, 5));
      s = await this.getStatus();
    }
    if (s.state === STATE.dfuDNBUSY) {
      // Some bootloaders stay busy after the timeout; clearing gets them back to idle.
      await this.clearStatus();
      return;
    }
    if (s.state !== STATE.dfuDNLOAD_IDLE && s.state !== STATE.dfuIDLE) {
      throw new Error(`${what} failed (DFU state ${s.state}, status ${s.status})`);
    }
  }

  async command(bytes, what) {
    await this.out(REQ.DNLOAD, 0, new Uint8Array(bytes));
    await this.waitDownload(what);
  }

  le32(addr) {
    return [addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff];
  }

  async loadAddress(addr) {
    await this.command([0x21, ...this.le32(addr)], `Set address 0x${addr.toString(16)}`);
  }

  async erasePage(addr) {
    await this.command([0x41, ...this.le32(addr)], `Erase 0x${addr.toString(16)}`);
  }

  // ---- high level ------------------------------------------------------------

  async flash(hex, { onProgress = () => {}, onPhase = () => {} } = {}) {
    const flashEnd = this.memory.startAddress + this.memory.totalSize;
    for (const block of hex.data) {
      if (block.address < this.memory.startAddress || block.address + block.bytes > flashEnd) {
        throw new Error("Firmware does not fit into this flight controller's flash.");
      }
    }

    await this.clearStatus();

    // 1. full chip erase, page by page (also wipes the old configuration)
    onPhase("erase");
    const pages = [];
    for (const sector of this.memory.sectors) {
      for (let p = 0; p < sector.numPages; p++) pages.push(sector.startAddress + p * sector.pageSize);
    }
    for (let i = 0; i < pages.length; i++) {
      await this.erasePage(pages[i]);
      onProgress((i + 1) / pages.length);
    }
    this.log(`Erased ${this.memory.totalSize / 1024} KB`);

    // 2. write
    onPhase("write");
    const total = hex.bytes_total;
    let done = 0;
    for (const block of hex.data) {
      await this.loadAddress(block.address);
      let blockNum = 2;
      for (let off = 0; off < block.bytes; off += this.transferSize) {
        const chunk = block.data.slice(off, Math.min(off + this.transferSize, block.bytes));
        await this.out(REQ.DNLOAD, blockNum++, new Uint8Array(chunk));
        await this.waitDownload(`Write 0x${(block.address + off).toString(16)}`);
        done += chunk.length;
        onProgress(done / total);
      }
    }
    this.log(`Wrote ${total} bytes`);

    // 3. verify
    onPhase("verify");
    done = 0;
    for (const block of hex.data) {
      await this.clearStatus();
      await this.loadAddress(block.address);
      await this.clearStatus();
      let blockNum = 2;
      for (let off = 0; off < block.bytes; off += this.transferSize) {
        const len = Math.min(this.transferSize, block.bytes - off);
        const data = await this.in(REQ.UPLOAD, blockNum++, len);
        for (let i = 0; i < len; i++) {
          if (data[i] !== block.data[off + i]) {
            throw new Error(`Verification failed at 0x${(block.address + off + i).toString(16)}`);
          }
        }
        done += len;
        onProgress(done / total);
      }
    }
    this.log("Verified OK");
  }

  // Jump to the new firmware.
  async leave(address = 0x08000000) {
    try {
      await this.clearStatus();
      await this.loadAddress(address);
      await this.out(REQ.DNLOAD, 0, new Uint8Array(0));
      await this.getStatus();
    } catch {
      // The device usually drops off the bus here, which is expected.
    }
    await this.close();
  }
}
