import { SETUP } from "./setup-data.js";
import { SerialTransport, serialSupported } from "./serial.js";
import { MspClient, MSP, REBOOT, apiAtLeast } from "./msp.js";
import { CliSession, prepareCliScript } from "./cli.js";
import { DfuDevice, usbSupported } from "./dfu.js";
import { parseHex, insertConfig, buildCustomDefaults } from "./hex.js";
import { EscProgrammer, summarizeSettings } from "./esc.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------
const logLines = [];
function log(message, level = "info") {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = `${time}  ${level === "error" ? "ERROR " : level === "warn" ? "WARN  " : ""}${message}`;
  logLines.push(line);
  const pre = $("log");
  pre.textContent += line + "\n";
  pre.scrollTop = pre.scrollHeight;
  $("log-last").textContent = message;
  (level === "error" ? console.error : console.log)(message);
}

$("log-toggle").addEventListener("click", () => {
  const open = $("log-body").hidden;
  $("log-body").hidden = !open;
  $("log-toggle").setAttribute("aria-expanded", String(open));
});
$("log-copy").addEventListener("click", () => navigator.clipboard?.writeText(logLines.join("\n")));

function downloadLog() {
  const header = [
    `OpenScale 200 setup log, ${new Date().toISOString()}`,
    `Firmware target: Rotorflight ${SETUP.firmware.version} (${SETUP.firmware.commit})`,
    `Steps: ${JSON.stringify(state.status)}`,
    "",
  ];
  const blob = new Blob([header.concat(logLines).join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `openscale200-setup-${Date.now()}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// wizard state & navigation
// ---------------------------------------------------------------------------
const STEPS = ["welcome", "power", "escs", "firmware", "settings", "done"];
const TASKS = ["power", "escs", "firmware", "settings"];
const STATUS_TEXT = { pending: "", done: "Done", skipped: "Skipped", error: "Needs attention" };

const state = {
  current: "welcome",
  status: { power: "pending", escs: "pending", firmware: "pending", settings: "pending" },
  escDeferred: false,
  busy: false,
};

try {
  const saved = JSON.parse(sessionStorage.getItem("os200-setup") || "null");
  if (saved?.status) Object.assign(state.status, saved.status);
  if (saved?.escDeferred) state.escDeferred = true;
} catch {
  /* ignore */
}

function persist() {
  sessionStorage.setItem("os200-setup", JSON.stringify({ status: state.status, escDeferred: state.escDeferred }));
}

function setStatus(task, value) {
  state.status[task] = value;
  persist();
  renderStepper();
}

function renderStepper() {
  const ol = $("stepper");
  ol.textContent = "";
  STEPS.forEach((step, i) => {
    const section = document.querySelector(`.step[data-step="${step}"]`);
    const status = state.status[step] ?? (step === "done" && TASKS.every((t) => state.status[t] === "done") ? "done" : "pending");
    const li = document.createElement("li");
    li.dataset.status = status;
    li.dataset.current = String(state.current === step);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = state.busy;
    const bullet = document.createElement("span");
    bullet.className = "bullet";
    bullet.textContent = status === "done" ? "✓" : status === "error" ? "!" : String(i + 1);
    const text = document.createElement("span");
    text.textContent = section.dataset.title;
    const sub = document.createElement("span");
    sub.className = "step-sub";
    sub.textContent = STATUS_TEXT[status] ?? "";
    text.appendChild(sub);
    btn.append(bullet, text);
    btn.addEventListener("click", () => goTo(step));
    if (state.current === step) btn.setAttribute("aria-current", "step");
    li.appendChild(btn);
    ol.appendChild(li);
  });
}

function goTo(step) {
  if (state.busy) return;
  state.current = step;
  document.querySelectorAll(".step").forEach((s) => s.classList.toggle("active", s.dataset.step === step));
  renderStepper();
  window.scrollTo({ top: 0 });
  ENTER[step]?.();
}

function nextAfter(step) {
  const order = ["power", "escs", "firmware", "settings"];
  if (step === "settings" && state.escDeferred && state.status.escs !== "done") return "escs";
  if (step === "escs" && state.escDeferred && state.status.settings === "done") return "done";
  const i = order.indexOf(step);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : "done";
}

function setBusy(busy) {
  state.busy = busy;
  $("conn-button").disabled = busy;
  document.querySelectorAll("[id$='-skip'], #fw-dfu-direct").forEach((b) => (b.disabled = busy));
  renderStepper();
}

window.addEventListener("beforeunload", (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------------------------------------------------------------------------
// flight controller connection
// ---------------------------------------------------------------------------
const fc = { transport: null, msp: null, info: null };

function describeFc(info) {
  if (!info) return "Not connected";
  const board = info.boardName || info.targetName || info.boardId;
  return `${board} · Rotorflight ${info.version}${info.revision ? ` (${info.revision})` : ""}`;
}

function setConnUi(mode, text) {
  $("conn-pill").dataset.state = mode;
  $("conn-text").textContent = text;
  $("conn-button").textContent = fc.transport ? "Disconnect" : "Connect";
}

function attach(transport) {
  fc.transport = transport;
  fc.msp = new MspClient(transport);
  transport.onClose(() => {
    if (fc.transport !== transport) return;
    fc.msp?.dispose();
    fc.transport = fc.msp = fc.info = null;
    setConnUi("off", "Not connected");
    log("Flight controller disconnected");
  });
}

async function identify() {
  setConnUi("busy", "Reading flight controller…");
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      fc.info = await fc.msp.identify();
      break;
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  if (!fc.info) {
    await fc.transport?.close();
    throw new Error(`No Rotorflight flight controller answered (${lastErr?.message}).`);
  }
  if (fc.info.variant !== "RTFL") {
    const variant = fc.info.variant;
    await fc.transport?.close();
    throw new Error(`This flight controller runs "${variant}", not Rotorflight.`);
  }
  setConnUi("on", describeFc(fc.info));
  log(`Connected: ${describeFc(fc.info)}, MSP API ${fc.info.apiString}, craft "${fc.info.craftName}"`);
  return fc.info;
}

// Must be called from a click handler the first time (the browser asks which port).
async function ensureConnected() {
  if (fc.transport && fc.info) return fc.info;
  setConnUi("busy", "Connecting…");
  try {
    let transport = null;
    const known = (await navigator.serial.getPorts()).length > 0;
    if (known) transport = await SerialTransport.reconnect({ timeoutMs: 1500 });
    if (!transport) transport = await SerialTransport.request();
    attach(transport);
    return await identify();
  } catch (err) {
    setConnUi("off", "Not connected");
    if (err?.name === "NotFoundError") throw new Error("No port selected. Click again and choose the flight controller.");
    if (err?.name === "NetworkError" || err?.name === "InvalidStateError") {
      throw new Error("The flight controller's port is busy. Close Rotorflight Configurator or other programs using it, then try again.");
    }
    throw err;
  }
}

async function disconnect() {
  const t = fc.transport;
  if (!t) return;
  fc.msp?.dispose();
  fc.transport = fc.msp = fc.info = null;
  await t.close();
  setConnUi("off", "Not connected");
}

// After a reboot the FC may come up, re-initialise and reset once more
// (first boot after flashing), so wait until the link stays up.
async function reconnectAfterReboot(timeoutMs = 20000) {
  setConnUi("busy", "Waiting for the flight controller…");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await SerialTransport.reconnect({ timeoutMs: Math.max(1000, deadline - Date.now()) });
    if (!t) break;
    await sleep(2000);
    if (t.closed) continue;
    attach(t);
    try {
      return await identify();
    } catch {
      /* try again until the deadline */
    }
  }
  setConnUi("off", "Not connected");
  return null;
}

$("conn-button").addEventListener("click", async () => {
  try {
    if (fc.transport) await disconnect();
    else await ensureConnected();
    ENTER[state.current]?.();
  } catch (err) {
    log(err.message, "error");
  }
});

function checkBoard(info, { forCli = false } = {}) {
  const want = SETUP.board.name;
  if (info.boardName && info.boardName !== want) {
    throw new Error(
      `This flight controller is a "${info.boardName}", but this setup is for the ${want}. ` +
        (forCli ? "Applying the settings would halt it." : "Flashing it is not supported here."),
    );
  }
  if (!forCli && info.targetName && !info.targetName.includes("F405")) {
    throw new Error(`This flight controller has a ${info.targetName} processor; the firmware is for the ${SETUP.board.mcu}.`);
  }
}

// ---------------------------------------------------------------------------
// data files
// ---------------------------------------------------------------------------
const data = { escFiles: [], cliLines: null, firmware: null };

async function fetchOk(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return res;
}

async function loadSetupFiles() {
  data.escFiles = await Promise.all(
    SETUP.escs.map(async (esc) => new Uint8Array(await (await fetchOk(esc.file)).arrayBuffer())),
  );
  data.cliLines = prepareCliScript(await (await fetchOk(SETUP.cliDump)).text());
  $("cli-count").textContent = String(data.cliLines.length);
  renderEscCards();
}

async function loadFirmware() {
  if (data.firmware) return structuredClone(data.firmware);
  const [hexText, configText] = await Promise.all([
    fetchOk(SETUP.firmware.hex).then((r) => r.text()),
    fetchOk(SETUP.firmware.targetConfig).then((r) => r.text()),
  ]);
  const hex = parseHex(hexText);
  const defaults = buildCustomDefaults(configText, {
    configName: SETUP.firmware.targetConfigName,
    boardName: SETUP.board.name,
    manufacturerId: SETUP.board.manufacturer,
    commitInfo: SETUP.firmware.targetsCommit,
  });
  insertConfig(hex, defaults);
  log(`Firmware ready: ${hex.bytes_total} bytes incl. ${SETUP.board.name} defaults`);
  data.firmware = hex;
  return structuredClone(hex);
}

// ---------------------------------------------------------------------------
// bindings
// ---------------------------------------------------------------------------
const BIND = {
  fwVersion: SETUP.firmware.version,
  fwCommit: SETUP.firmware.commit,
  cliFile: SETUP.cliDump.split("/").pop(),
  craftName: SETUP.craftName,
};
document.querySelectorAll("[data-bind]").forEach((el) => (el.textContent = BIND[el.dataset.bind] ?? ""));
document.querySelectorAll("[data-bind-href]").forEach((el) => (el.href = SETUP.firmware.commitUrl));
$("fw-target").textContent = `${SETUP.firmware.version} (${SETUP.firmware.commit})`;

function show(id, text) {
  const el = $(id);
  if (text !== undefined) {
    el.textContent = "";
    const [title, ...rest] = Array.isArray(text) ? text : [text];
    const strong = document.createElement("strong");
    strong.textContent = title;
    el.appendChild(strong);
    for (const r of rest) {
      const span = document.createElement("span");
      span.textContent = r;
      el.appendChild(span);
    }
  }
  el.hidden = false;
}
const hide = (...ids) => ids.forEach((id) => ($(id).hidden = true));

// ---------------------------------------------------------------------------
// step: welcome / power
// ---------------------------------------------------------------------------
const browserOk = serialSupported() && usbSupported() && window.isSecureContext;
if (!browserOk) {
  $("browser-error").hidden = false;
  $("welcome-start").disabled = true;
}
$("welcome-start").addEventListener("click", () => goTo("power"));

$("power-confirm").checked = state.status.power === "done";
$("power-next").disabled = !$("power-confirm").checked;
$("power-confirm").addEventListener("change", (e) => ($("power-next").disabled = !e.target.checked));
$("power-next").addEventListener("click", () => {
  setStatus("power", "done");
  goTo("escs");
});

// ---------------------------------------------------------------------------
// step: ESCs
// ---------------------------------------------------------------------------
function renderEscCards() {
  const grid = $("esc-grid");
  grid.textContent = "";
  SETUP.escs.forEach((esc, i) => {
    const card = document.createElement("div");
    card.className = "esc-card";
    card.id = `esc-card-${i}`;
    card.dataset.state = "idle";
    card.innerHTML = `
      <div class="esc-head"><h3></h3><span class="esc-motor"></span></div>
      <div class="esc-status"><span class="esc-status-text">Ready</span></div>
      <dl class="esc-settings"></dl>
      <div class="esc-file"></div>`;
    card.querySelector("h3").textContent = esc.role;
    card.querySelector(".esc-motor").textContent = `Motor ${esc.motor}`;
    card.querySelector(".esc-file").textContent = esc.file.split("/").pop();
    const dl = card.querySelector(".esc-settings");
    for (const [k, v] of summarizeSettings(data.escFiles[i])) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    grid.appendChild(card);
  });
}

function setEscCard(i, cardState, text) {
  const card = $(`esc-card-${i}`);
  card.dataset.state = cardState;
  const status = card.querySelector(".esc-status");
  status.textContent = "";
  if (cardState === "busy") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    status.appendChild(sp);
  }
  const t = document.createElement("span");
  t.textContent = (cardState === "done" ? "✓ " : cardState === "error" ? "✕ " : "") + text;
  status.appendChild(t);
}

$("esc-run").addEventListener("click", async () => {
  hide("esc-error", "esc-old-fw");
  setBusy(true);
  $("esc-run").disabled = true;
  let ok = true;
  let programmer = null;
  try {
    const info = await ensureConnected();
    if (!apiAtLeast(info.apiVersion, SETUP.firmware.minEscApi)) {
      log(`MSP API ${info.apiString} has no ESC forward programming`, "warn");
      show("esc-old-fw");
      return;
    }
    programmer = new EscProgrammer(fc.msp, log);
    for (const [i, esc] of SETUP.escs.entries()) {
      setEscCard(i, "busy", "Connecting…");
      try {
        const res = await programmer.program(esc.index, data.escFiles[i], {
          onStatus: (s) => setEscCard(i, "busy", s),
        });
        setEscCard(i, "done", res.changed ? `Configured (AM32 ${res.esc.firmware})` : `Already configured (AM32 ${res.esc.firmware})`);
      } catch (err) {
        ok = false;
        setEscCard(i, "error", err.message);
        log(`${esc.role}: ${err.message}`, "error");
      }
    }
  } catch (err) {
    ok = false;
    show("esc-error", ["Could not configure the ESCs.", err.message]);
    log(err.message, "error");
  } finally {
    if (programmer) {
      log("Leaving ESC programming mode (the ESCs restart)");
      await programmer.deselect();
    }
    setBusy(false);
    $("esc-run").disabled = false;
  }
  if (!$("esc-old-fw").hidden) return;
  if (ok) {
    setStatus("escs", "done");
    $("esc-run").hidden = true;
    $("esc-next").hidden = false;
  } else {
    setStatus("escs", "error");
    $("esc-run").textContent = "Try again";
    if ($("esc-error").hidden) {
      show("esc-error", ["One or both ESCs could not be configured.", "Check the battery and the ESC signal wires, then try again."]);
    }
  }
});

$("esc-defer").addEventListener("click", () => {
  state.escDeferred = true;
  persist();
  goTo("firmware");
});
$("esc-next").addEventListener("click", () => goTo(nextAfter("escs")));
$("esc-skip").addEventListener("click", () => {
  if (state.status.escs !== "done") setStatus("escs", "skipped");
  goTo(nextAfter("escs"));
});

// ---------------------------------------------------------------------------
// step: firmware
// ---------------------------------------------------------------------------
const PHASES = ["prepare", "bootloader", "erase", "write", "verify", "restart"];
function setPhase(phase) {
  const idx = phase === "done" ? PHASES.length : PHASES.indexOf(phase);
  document.querySelectorAll("#fw-phases span").forEach((s) => {
    const i = PHASES.indexOf(s.dataset.phase);
    s.dataset.state = i < idx ? "done" : i === idx ? "active" : "";
  });
}
const fwProgress = (fraction, text) => {
  $("fw-bar").style.width = `${Math.round(fraction * 100)}%`;
  if (text !== undefined) $("fw-status").textContent = text;
};

let dfuPick = null; // resolver for the "select bootloader device" button

function waitForDfuPick() {
  show("fw-dfu");
  return new Promise((resolve) => (dfuPick = resolve));
}

$("fw-dfu-select").addEventListener("click", async () => {
  try {
    const device = await DfuDevice.request();
    hide("fw-dfu");
    dfuPick?.(device);
    dfuPick = null;
  } catch (err) {
    if (err?.name !== "NotFoundError") log(err.message, "error");
  }
});

async function findDfuDevice(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dev = await DfuDevice.findPermitted();
    if (dev) return dev;
    await sleep(500);
  }
  return null;
}

async function runFirmwareUpdate({ device: preselected = null } = {}) {
  const alreadyInDfu = preselected !== null;
  hide("fw-error", "fw-ok", "fw-next", "fw-dfu");
  show("fw-progress");
  setBusy(true);
  $("fw-run").disabled = true;
  let dfu = null;
  try {
    setPhase("prepare");
    fwProgress(0, "Loading firmware…");
    const hex = await loadFirmware();

    setPhase("bootloader");
    if (!alreadyInDfu) {
      const info = await ensureConnected();
      checkBoard(info);
      fwProgress(0, "Restarting the flight controller in bootloader mode…");
      const mode = info.hasFlashBootloader ? REBOOT.BOOTLOADER_FLASH : REBOOT.BOOTLOADER_ROM;
      log("Rebooting into the bootloader");
      await fc.msp.send(MSP.SET_REBOOT, [mode]).catch(() => {});
      await sleep(300);
      await disconnect();
      await sleep(1500);
    }

    fwProgress(0, "Looking for the bootloader device…");
    let device = preselected ?? (await findDfuDevice(5000));
    if (!device) {
      fwProgress(0, "Waiting for you to select the bootloader device…");
      device = await waitForDfuPick();
    }

    dfu = new DfuDevice(device, log);
    await dfu.open();
    const phaseText = { erase: "Erasing", write: "Writing", verify: "Verifying" };
    let currentPhase = "erase";
    await dfu.flash(hex, {
      onPhase: (p) => {
        currentPhase = p;
        setPhase(p);
        fwProgress(0, `${phaseText[p]}…`);
      },
      onProgress: (f) => fwProgress(f, `${phaseText[currentPhase]}… ${Math.round(f * 100)} %`),
    });

    setPhase("restart");
    fwProgress(1, "Starting the new firmware…");
    await dfu.leave();
    dfu = null;
    setStatus("firmware", "done");
    log(`Firmware ${SETUP.firmware.version} (${SETUP.firmware.commit}) flashed and verified`);

    const info = await reconnectAfterReboot(20000);
    setPhase("done");
    if (info) {
      $("fw-current").textContent = `${info.version} (${info.revision})`;
      if (info.revision !== SETUP.firmware.commit) {
        log(`FC reports revision ${info.revision}, expected ${SETUP.firmware.commit}`, "warn");
      }
      show("fw-ok", ["Firmware updated.", `The flight controller now runs Rotorflight ${info.version} (${info.revision}).`]);
    } else {
      show("fw-ok", ["Firmware updated and verified.", "The flight controller is restarting. You'll reconnect in the next step."]);
    }
    $("fw-run").hidden = true;
    $("fw-next").hidden = false;
  } catch (err) {
    setStatus("firmware", "error");
    show("fw-error", ["The firmware update did not finish.", err.message]);
    log(err.message, "error");
    $("fw-run").textContent = "Try again";
    await dfu?.close();
  } finally {
    hide("fw-dfu");
    dfuPick = null;
    setBusy(false);
    $("fw-run").disabled = false;
  }
}

$("fw-run").addEventListener("click", () => runFirmwareUpdate());
$("fw-dfu-direct").addEventListener("click", async () => {
  // Ask for the device right away, while the click still counts as a user gesture.
  try {
    const device = (await DfuDevice.findPermitted()) ?? (await DfuDevice.request());
    await runFirmwareUpdate({ device });
  } catch (err) {
    if (err?.name !== "NotFoundError") log(err.message, "error");
  }
});
$("fw-next").addEventListener("click", () => goTo(nextAfter("firmware")));
$("fw-skip").addEventListener("click", () => {
  if (state.status.firmware !== "done") setStatus("firmware", "skipped");
  goTo(nextAfter("firmware"));
});

// ---------------------------------------------------------------------------
// step: settings (CLI)
// ---------------------------------------------------------------------------
let cliDecision = null;

function waitForCliDecision() {
  return new Promise((resolve) => (cliDecision = resolve));
}
$("cli-save-anyway").addEventListener("click", () => cliDecision?.("save"));
$("cli-discard").addEventListener("click", () => cliDecision?.("discard"));

$("cli-run").addEventListener("click", async () => {
  hide("cli-error", "cli-ok", "cli-errors", "cli-next");
  setBusy(true);
  $("cli-run").disabled = true;
  let cli = null;
  try {
    const info = await ensureConnected();
    checkBoard(info, { forCli: true });
    if (info.revision !== SETUP.firmware.commit) {
      log(`Applying settings to firmware ${info.version} (${info.revision}); they were prepared for ${SETUP.firmware.commit}`, "warn");
    }

    show("cli-progress");
    const bar = (i, n, line) => {
      $("cli-bar").style.width = `${Math.round((i / n) * 100)}%`;
      $("cli-status").textContent = `${i} / ${n}  ${line}`;
    };
    bar(0, data.cliLines.length, "Entering CLI…");
    cli = new CliSession(fc.transport);
    await cli.enter();
    log(`Applying ${data.cliLines.length} settings commands`);
    const errors = await cli.run(data.cliLines, {
      onProgress: bar,
      onError: (e) => log(`${e.line}  ->  ${e.error}`, "warn"),
    });

    let saved = false;
    if (errors.length === 0) {
      $("cli-status").textContent = "Saving…";
      await cli.save();
      saved = true;
    } else {
      $("cli-error-list").textContent = errors.map((e) => `${e.line}\n  ${e.error}`).join("\n");
      show("cli-errors");
      setBusy(false);
      const choice = await waitForCliDecision();
      setBusy(true);
      hide("cli-errors");
      if (choice === "save") {
        $("cli-status").textContent = "Saving…";
        await cli.saveAnyway();
        saved = true;
        log(`Saved with ${errors.length} rejected command(s)`, "warn");
      } else {
        await cli.discard();
        log("Changes discarded; the flight controller restarts with its previous settings");
      }
    }
    cli.dispose();
    cli = null;

    $("cli-status").textContent = "Restarting the flight controller…";
    const after = await reconnectAfterReboot(20000);

    if (!saved) {
      setStatus("settings", "error");
      show("cli-error", ["Settings were not saved.", "Fix the problem and apply the settings again."]);
      $("cli-run").textContent = "Try again";
      return;
    }

    // Saved, either cleanly or because the user chose to keep the accepted commands.
    setStatus("settings", "done");
    if (after && after.craftName === SETUP.craftName) {
      $("cli-status").textContent = "Done";
      show("cli-ok", [
        errors.length ? "Settings saved, with some commands rejected." : "Settings applied and saved.",
        `The flight controller restarted as "${after.craftName}".`,
      ]);
    } else if (after) {
      show("cli-error", ["The settings were saved, but the flight controller reports an unexpected name.", `Expected "${SETUP.craftName}", got "${after.craftName}".`]);
    } else {
      show("cli-ok", ["Settings saved.", "The flight controller is restarting."]);
    }
    $("cli-run").hidden = true;
    $("cli-next").hidden = false;
  } catch (err) {
    setStatus("settings", "error");
    show("cli-error", ["The settings could not be applied.", err.message]);
    log(err.message, "error");
    $("cli-run").textContent = "Try again";
  } finally {
    cli?.dispose();
    cliDecision = null;
    hide("cli-errors");
    setBusy(false);
    $("cli-run").disabled = false;
  }
});
$("cli-next").addEventListener("click", () => goTo(nextAfter("settings")));
$("cli-skip").addEventListener("click", () => {
  if (state.status.settings !== "done") setStatus("settings", "skipped");
  goTo(nextAfter("settings"));
});

// ---------------------------------------------------------------------------
// step: done
// ---------------------------------------------------------------------------
const TASK_LABEL = {
  power: "Battery connected",
  escs: "ESCs configured (main + tail)",
  firmware: `Rotorflight ${SETUP.firmware.version} (${SETUP.firmware.commit}) installed`,
  settings: `Settings "${SETUP.craftName}" applied`,
};
const SUMMARY_TEXT = { done: "Done", skipped: "Skipped", error: "Not finished", pending: "Not done" };

$("done-log").addEventListener("click", downloadLog);
$("done-restart").addEventListener("click", () => {
  Object.keys(state.status).forEach((k) => (state.status[k] = "pending"));
  state.escDeferred = false;
  persist();
  location.reload();
});

// ---------------------------------------------------------------------------
// per-step refresh when a step is shown
// ---------------------------------------------------------------------------
const ENTER = {
  escs() {
    if (state.status.escs === "done") {
      $("esc-run").hidden = true;
      $("esc-next").hidden = false;
    }
  },
  firmware() {
    const info = fc.info;
    $("fw-current").textContent = info ? `${info.version} (${info.revision})` : "Connect to check";
    if (info?.revision === SETUP.firmware.commit && state.status.firmware !== "done" && !state.busy) {
      show("fw-ok", ["This firmware is already installed.", "You can continue, or install it again."]);
      $("fw-next").hidden = false;
      $("fw-run").textContent = "Install again";
    }
    if (state.status.firmware === "done") $("fw-next").hidden = false;
  },
  settings() {
    const info = fc.info;
    if (info && info.revision !== SETUP.firmware.commit) {
      show("cli-fw-warn", [
        `The flight controller runs Rotorflight ${info.version} (${info.revision}).`,
        `These settings are meant for ${SETUP.firmware.commit}. Update the firmware first for the best result.`,
      ]);
    } else hide("cli-fw-warn");
    if (state.status.settings === "done") $("cli-next").hidden = false;
  },
  done() {
    const ul = $("done-summary");
    ul.textContent = "";
    for (const task of TASKS) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = TASK_LABEL[task];
      const st = document.createElement("span");
      st.className = "st";
      st.dataset.s = state.status[task];
      st.textContent = SUMMARY_TEXT[state.status[task]];
      li.append(label, st);
      ul.appendChild(li);
    }
    const complete = TASKS.every((t) => state.status[t] === "done");
    document.querySelector(".done-hero").dataset.state = complete ? "complete" : "partial";
    document.querySelector(".done-badge").textContent = complete ? "✓" : "!";
    $("done-title").textContent = complete ? "Your OpenScale 200 is set up" : "Setup is not complete yet";
    renderStepper();
  },
};

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
renderStepper();
goTo("welcome");
loadSetupFiles().catch((err) => {
  log(err.message, "error");
  show("esc-error", ["Setup files could not be loaded.", err.message]);
});
log(`Setup assistant ready. Target: Rotorflight ${SETUP.firmware.version} (${SETUP.firmware.commit})`);
if (!browserOk) log("This browser does not support WebSerial/WebUSB", "error");
