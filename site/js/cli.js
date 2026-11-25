// Rotorflight CLI driver: sends one line at a time and waits for the "# " prompt.

const PROMPT = "\n# ";
const decoder = new TextDecoder();

// Lines from a `dump all` that must not be replayed: comments, the read-only
// MCU id, the per-board signature and the trailing save (sent separately).
export function prepareCliScript(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .filter((l) => !/^(mcu_id|signature)(\s|$)/.test(l))
    .filter((l) => l !== "save");
  // Start from a clean, known state regardless of what was on the FC before.
  return ["defaults nosave", ...lines];
}

export class CliSession {
  constructor(transport, { settleMs = 8 } = {}) {
    this.transport = transport;
    this.settleMs = settleMs;
    this.buffer = "";
    this.waiter = null;
    this.closed = false;
    this.unsubData = transport.onData((chunk) => this.onData(chunk));
    this.unsubClose = transport.onClose(() => {
      this.closed = true;
      this.waiter?.onClose?.();
    });
  }

  dispose() {
    this.unsubData?.();
    this.unsubClose?.();
  }

  onData(chunk) {
    this.buffer += decoder.decode(chunk, { stream: true });
    this.waiter?.onData?.();
  }

  waitFor(predicate, timeoutMs, { settle = this.settleMs, onClose } = {}) {
    return new Promise((resolve, reject) => {
      let settleTimer = null;
      const finish = (fn, value) => {
        clearTimeout(timer);
        clearTimeout(settleTimer);
        this.waiter = null;
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("CLI did not respond in time")), timeoutMs);
      const check = () => {
        clearTimeout(settleTimer);
        if (predicate(this.buffer)) {
          // The prompt can be followed by more output in the same burst (e.g. "# saving"),
          // so only accept it once the line has been quiet for a moment.
          settleTimer = setTimeout(() => {
            if (predicate(this.buffer)) finish(resolve, this.buffer);
          }, settle);
        }
      };
      this.waiter = {
        onData: check,
        onClose: () => (onClose ? finish(resolve, onClose(this.buffer)) : finish(reject, new Error("Connection closed"))),
      };
      check();
    });
  }

  async enter() {
    this.buffer = "";
    await this.transport.write(new TextEncoder().encode("#"));
    try {
      await this.waitFor((b) => b.endsWith(PROMPT), 3000, { settle: 50 });
    } catch {
      // Some FCs need a second nudge after a fresh USB connection.
      this.buffer = "";
      await this.transport.write(new TextEncoder().encode("\n"));
      await this.waitFor((b) => b.endsWith(PROMPT), 3000, { settle: 50 });
    }
  }

  async command(line, { timeoutMs = 3000 } = {}) {
    this.buffer = "";
    await this.transport.write(new TextEncoder().encode(line + "\n"));
    const out = await this.waitFor((b) => b.endsWith(PROMPT), timeoutMs);
    const body = out.slice(0, -PROMPT.length);
    const errors = body
      .split(/\r?\n/)
      .filter((l) => l.includes("###ERROR"))
      .map((l) => l.trim());
    return { output: body, errors };
  }

  // Runs a script; onProgress(i, total, line). Returns the list of errors.
  async run(lines, { onProgress, onError, signal } = {}) {
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const line = lines[i];
      const timeoutMs = /^defaults/.test(line) ? 15000 : 3000;
      const { errors: lineErrors } = await this.command(line, { timeoutMs });
      for (const e of lineErrors) {
        const entry = { line, error: e };
        errors.push(entry);
        onError?.(entry);
      }
      onProgress?.(i + 1, lines.length, line);
    }
    return errors;
  }

  // Saves and lets the FC reboot. Resolves true once the save was acknowledged.
  // Inside a batch the firmware refuses to save if any line failed; see saveAnyway().
  async save() {
    this.buffer = "";
    await this.transport.write(new TextEncoder().encode("save\n"));
    const out = await this.waitFor(
      (b) => /Rebooting/i.test(b) || /PLEASE FIX ERRORS/.test(b),
      8000,
      { settle: 50, onClose: (b) => b },
    ).catch(() => this.buffer);
    if (/PLEASE FIX ERRORS/.test(out)) {
      throw new Error("The flight controller refused to save: " + out.trim().split(/\r?\n/).filter((l) => l.includes("###")).join(" "));
    }
    if (!/saving/i.test(out) && !this.closed) {
      throw new Error("The flight controller did not confirm the save.");
    }
    return true;
  }

  // Ends the batch (clearing its error flag) and saves what was applied.
  async saveAnyway() {
    await this.command("batch end");
    return this.save();
  }

  // Leaves the CLI without saving; the FC reboots and discards all changes.
  async discard() {
    await this.transport.write(new TextEncoder().encode("exit\n"));
  }
}
