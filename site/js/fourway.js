// BLHeli 4-way interface client (the protocol behind MSP_SET_PASSTHROUGH).
// Same framing as Rotorflight/Betaflight io/serial_4way.c and the AM32
// configurator: host frames start with 0x2F, FC frames with 0x2E, CRC16-XMODEM.

export const FW_CMD = {
  TestAlive: 0x30,
  ProtocolGetVersion: 0x31,
  InterfaceGetName: 0x32,
  InterfaceGetVersion: 0x33,
  InterfaceExit: 0x34,
  DeviceReset: 0x35,
  DeviceInitFlash: 0x37,
  DevicePageErase: 0x39,
  DeviceRead: 0x3a,
  DeviceWrite: 0x3b,
  InterfaceSetMode: 0x3f,
};

const ACK_TEXT = {
  0x02: "invalid command",
  0x03: "CRC error",
  0x04: "verify error",
  0x08: "invalid ESC number",
  0x09: "invalid parameter",
  0x0f: "ESC did not respond",
};

export const IF_MODE_ARM = 4;

export function crc16xmodem(bytes, crc = 0) {
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export class FourWayError extends Error {
  constructor(message, ack) {
    super(message);
    this.ack = ack;
  }
}

export class FourWayClient {
  constructor(transport) {
    this.transport = transport;
    this.rx = [];
    this.pending = null;
    this.queue = Promise.resolve();
    this.unsubscribe = transport.onData((chunk) => this.feed(chunk));
  }

  dispose() {
    this.unsubscribe?.();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new FourWayError("Connection closed"));
      this.pending = null;
    }
  }

  static encode(cmd, address, params) {
    const p = params.length ? params : [0];
    if (p.length > 256) throw new Error("4-way frame too long");
    const frame = [0x2f, cmd, (address >> 8) & 0xff, address & 0xff, p.length === 256 ? 0 : p.length, ...p];
    const crc = crc16xmodem(frame);
    frame.push(crc >> 8, crc & 0xff);
    return Uint8Array.from(frame);
  }

  feed(chunk) {
    for (const b of chunk) this.rx.push(b);
    for (;;) {
      const start = this.rx.indexOf(0x2e);
      if (start < 0) {
        this.rx.length = 0;
        return;
      }
      if (start > 0) this.rx.splice(0, start);
      if (this.rx.length < 5) return;
      const len = this.rx[4] === 0 ? 256 : this.rx[4];
      const total = 5 + len + 3;
      if (this.rx.length < total) return;
      const frame = this.rx.splice(0, total);
      const crc = crc16xmodem(frame.slice(0, total - 2));
      if (((frame[total - 2] << 8) | frame[total - 1]) !== crc) continue; // corrupt, drop
      this.dispatch({
        cmd: frame[1],
        address: (frame[2] << 8) | frame[3],
        params: Uint8Array.from(frame.slice(5, 5 + len)),
        ack: frame[5 + len],
      });
    }
  }

  dispatch(reply) {
    const p = this.pending;
    if (!p || p.cmd !== reply.cmd) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(reply);
  }

  // One command on the wire at a time. Resolves with the reply; throws on a NACK.
  request(cmd, address = 0, params = [], { timeoutMs = 2000, retries = 0 } = {}) {
    const run = async () => {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const reply = await this.requestOnce(cmd, address, params, timeoutMs);
          if (reply.ack !== 0) {
            throw new FourWayError(`4-way command 0x${cmd.toString(16)} failed: ${ACK_TEXT[reply.ack] ?? `ack ${reply.ack}`}`, reply.ack);
          }
          return reply;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  requestOnce(cmd, address, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new FourWayError(`4-way command 0x${cmd.toString(16)} timed out`));
      }, timeoutMs);
      this.pending = { cmd, resolve, reject, timer };
      this.transport.write(FourWayClient.encode(cmd, address, params)).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      });
    });
  }

  // ---- commands ------------------------------------------------------------

  async interfaceName() {
    const r = await this.request(FW_CMD.InterfaceGetName);
    return String.fromCharCode(...r.params);
  }

  // Connects to ESC `index`'s bootloader. Returns { signature, bootPin, mode }.
  async initFlash(index) {
    // The FC probes the bootloader before answering; this takes about a second.
    const r = await this.request(FW_CMD.DeviceInitFlash, 0, [index], { timeoutMs: 3000, retries: 3 });
    const [lo, hi, pin, mode] = r.params;
    return { signature: (hi << 8) | lo, flashCode: hi, bootPin: pin, mode };
  }

  async read(address, count) {
    if (count < 1 || count > 256) throw new Error("read size must be 1..256");
    const r = await this.request(FW_CMD.DeviceRead, address, [count === 256 ? 0 : count], { timeoutMs: 3000, retries: 2 });
    return r.params.slice(0, count);
  }

  // Writes up to 256 bytes. No retry here: the caller decides how to recover,
  // because the AM32 bootloader erases a page when a write starts on its boundary.
  async write(address, data) {
    await this.request(FW_CMD.DeviceWrite, address, Array.from(data), { timeoutMs: 4000 });
  }

  // Starts the ESC application (leaves the bootloader).
  async reset(index) {
    await this.request(FW_CMD.DeviceReset, 0, [index], { timeoutMs: 3000 });
  }

  // Leaves 4-way mode; the FC goes back to MSP on the same port.
  async exit() {
    await this.request(FW_CMD.InterfaceExit, 0, [0], { timeoutMs: 2000 });
  }
}
