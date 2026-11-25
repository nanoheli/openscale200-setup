// WebSerial transport. Any object with the same shape (write, onData, onClose,
// close) can be used instead, which is how the Node test harness talks to SITL.

const STM32_VCP = { usbVendorId: 0x0483, usbProductId: 0x5740 };
const PORT_FILTERS = [{ usbVendorId: 0x0483 }, { usbVendorId: 0x2e3c }]; // STM32, AT32

export const serialSupported = () => "serial" in navigator;

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.dataListeners = new Set();
    this.closeListeners = new Set();
    this.reader = null;
    this.closed = false;
  }

  static async request() {
    const port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    return SerialTransport.open(port);
  }

  // Reopens a flight controller this page was already allowed to use, e.g. after
  // a reboot. Returns null if none shows up in time.
  static async reconnect({ timeoutMs = 15000, preferred = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ports = await navigator.serial.getPorts();
      const candidates = ports.filter((p) => {
        const info = p.getInfo();
        if (preferred && info.usbVendorId === preferred.usbVendorId && info.usbProductId === preferred.usbProductId) return true;
        return info.usbVendorId === STM32_VCP.usbVendorId || info.usbVendorId === 0x2e3c;
      });
      for (const port of candidates) {
        try {
          return await SerialTransport.open(port);
        } catch {
          // not ready yet (still enumerating), try again
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  static async open(port) {
    await port.open({ baudRate: 115200, bufferSize: 65536 });
    const t = new SerialTransport(port);
    t.info = port.getInfo();
    t.readLoop();
    return t;
  }

  async readLoop() {
    try {
      while (this.port.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) for (const fn of this.dataListeners) fn(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch {
      // device lost (reboot, unplug)
    }
    this.handleClosed();
  }

  handleClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeListeners) fn();
    this.port.close().catch(() => {});
  }

  onData(fn) {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  async write(bytes) {
    if (this.closed || !this.port.writable) throw new Error("Flight controller is not connected");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } finally {
      writer.releaseLock();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
    for (const fn of this.closeListeners) fn();
  }
}
