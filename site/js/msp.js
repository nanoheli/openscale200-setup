// Minimal MSP v1 client (all commands used here are < 255).

export const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  NAME: 10,
  SET_REBOOT: 68,
  SET_PASSTHROUGH: 245,
  STATUS: 101,
};

export const REBOOT = { FIRMWARE: 0, BOOTLOADER_ROM: 1, BOOTLOADER_FLASH: 4 };

export class MspError extends Error {}

export class MspClient {
  constructor(transport) {
    this.transport = transport;
    this.pending = null; // { code, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.state = 0;
    this.unsubscribe = transport.onData((chunk) => this.feed(chunk));
  }

  dispose() {
    this.unsubscribe?.();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new MspError("Connection closed"));
      this.pending = null;
    }
  }

  static encode(code, payload = []) {
    const size = payload.length;
    const frame = new Uint8Array(6 + size);
    frame.set([0x24, 0x4d, 0x3c, size, code]); // "$M<"
    let checksum = size ^ code;
    for (let i = 0; i < size; i++) {
      frame[5 + i] = payload[i];
      checksum ^= payload[i];
    }
    frame[5 + size] = checksum;
    return frame;
  }

  feed(chunk) {
    for (const b of chunk) {
      switch (this.state) {
        case 0:
          this.state = b === 0x24 ? 1 : 0; // $
          break;
        case 1:
          this.state = b === 0x4d ? 2 : 0; // M
          break;
        case 2:
          if (b === 0x3e || b === 0x21) {
            // > or !
            this.isError = b === 0x21;
            this.state = 3;
          } else this.state = 0;
          break;
        case 3:
          this.size = b;
          this.checksum = b;
          this.state = 4;
          break;
        case 4:
          this.code = b;
          this.checksum ^= b;
          this.payload = new Uint8Array(this.size);
          this.offset = 0;
          this.state = this.size > 0 ? 5 : 6;
          break;
        case 5:
          this.payload[this.offset++] = b;
          this.checksum ^= b;
          if (this.offset >= this.size) this.state = 6;
          break;
        case 6:
          this.state = 0;
          if (b === this.checksum) this.dispatch(this.code, this.payload, this.isError);
          break;
      }
    }
  }

  dispatch(code, payload, isError) {
    const p = this.pending;
    if (!p || p.code !== code) return;
    clearTimeout(p.timer);
    this.pending = null;
    if (isError) p.reject(new MspError(`FC rejected MSP command ${code}`));
    else p.resolve(payload);
  }

  // Requests are serialized: one command on the wire at a time.
  request(code, payload = [], { timeoutMs = 1500, retries = 2 } = {}) {
    const run = async () => {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.requestOnce(code, payload, timeoutMs);
        } catch (err) {
          lastError = err;
          if (!(err instanceof MspError) || !/timed out/.test(err.message)) throw err;
        }
      }
      throw lastError;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  requestOnce(code, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new MspError(`MSP command ${code} timed out`));
      }, timeoutMs);
      this.pending = { code, resolve, reject, timer };
      this.transport.write(MspClient.encode(code, payload)).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      });
    });
  }

  // Fire and forget, for commands after which the FC drops the link (reboot).
  async send(code, payload = []) {
    await this.transport.write(MspClient.encode(code, payload));
  }

  // ---- helpers -------------------------------------------------------------

  async identify() {
    const ascii = (bytes) => String.fromCharCode(...bytes).replace(/\0.*$/, "");
    const api = await this.request(MSP.API_VERSION);
    const variant = ascii(await this.request(MSP.FC_VARIANT));
    const ver = await this.request(MSP.FC_VERSION);
    const build = await this.request(MSP.BUILD_INFO);
    const board = await this.request(MSP.BOARD_INFO);
    let name = "";
    try {
      name = ascii(await this.request(MSP.NAME));
    } catch {
      /* optional */
    }

    // BOARD_INFO: id[4] hwrev u16, type u8, capabilities u8,
    // targetName (len+str), boardName (len+str), design, manufacturer...
    const boardId = ascii(board.slice(0, 4));
    const capabilities = board[7];
    const strings = [];
    for (let off = 8; off < board.length && strings.length < 4; ) {
      const len = board[off];
      strings.push(ascii(board.slice(off + 1, off + 1 + len)));
      off += 1 + len;
    }
    const [targetName = "", boardName = "", , manufacturerId = ""] = strings;

    const revision = ascii(build.slice(19, 26));
    let versionString = `${ver[0]}.${ver[1]}.${ver[2]}`;
    if (build.length > 26) {
      const len = build[26];
      versionString = ascii(build.slice(27, 27 + len)) || versionString;
    }

    return {
      variant,
      apiVersion: [api[1], api[2]],
      apiString: `${api[1]}.${api[2]}`,
      version: versionString,
      revision,
      buildDate: ascii(build.slice(0, 11)),
      boardId,
      targetName,
      boardName,
      manufacturerId,
      craftName: name,
      hasFlashBootloader: (capabilities & (1 << 3)) !== 0,
    };
  }
}

export function apiAtLeast(have, want) {
  return have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]);
}
