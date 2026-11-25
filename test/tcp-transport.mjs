// Node TCP transport with the same shape as site/js/serial.js, for talking to
// Rotorflight SITL (UART1 is exposed on TCP 5761).
import net from "node:net";

export async function connectTcp(port = 5761, host = "127.0.0.1") {
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once("error", reject);
  });
  socket.setNoDelay(true);
  const dataListeners = new Set();
  const closeListeners = new Set();
  socket.on("data", (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const fn of dataListeners) fn(u8);
  });
  socket.on("close", () => {
    for (const fn of closeListeners) fn();
  });
  return {
    onData(fn) {
      dataListeners.add(fn);
      return () => dataListeners.delete(fn);
    },
    onClose(fn) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    write: (bytes) => new Promise((res, rej) => socket.write(Buffer.from(bytes), (e) => (e ? rej(e) : res()))),
    close: async () => socket.destroy(),
  };
}
