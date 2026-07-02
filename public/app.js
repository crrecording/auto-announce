"use strict";

const form = document.querySelector("#streamForm");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const runState = document.querySelector("#runState");
const streamStats = document.querySelector("#streamStats");
const telemetryStats = document.querySelector("#telemetryStats");
const zonesEl = document.querySelector("#zones");
const zoneDetailsEl = document.querySelector("#zoneDetails");
const zoneDetailTitle = document.querySelector("#zoneDetailTitle");
const headerSource = document.querySelector("#headerSource");
const headerAnnouncement = document.querySelector("#headerAnnouncement");
const headerNetwork = document.querySelector("#headerNetwork");
const announcementSourceName = document.querySelector("#announcementSourceName");
const programSourceName = document.querySelector("#programSourceName");
const devicesEl = document.querySelector("#devices");
const refreshDevicesBtn = document.querySelector("#refreshDevicesBtn");
const deviceScanState = document.querySelector("#deviceScanState");
const setupTypeSelect = document.querySelector("#setupType");
const sourceSelect = document.querySelector("#sourceId");
const sourceLabel = document.querySelector("#sourceLabel");
const programSourceSelect = document.querySelector("#programSourceId");
const programModeFields = [
  document.querySelector("#programSourceField"),
  document.querySelector("#programLevelField"),
  document.querySelector("#programDuckField"),
];
const uiMessage = document.querySelector("#uiMessage");
const audioFileInput = document.querySelector("#mediaAudioFile") || document.querySelector("#audioFile");
const uploadAudioBtn = document.querySelector("#mediaUploadAudioBtn") || document.querySelector("#uploadAudioBtn");
const inputMeterEl = document.querySelector("#inputMeter");
const ambientMeterEl = document.querySelector("#ambientMeter");
const processingMeterEl = document.querySelector("#processingMeter");
const processingStateEl = document.querySelector("#processingState");
const ambientStateEl = document.querySelector("#ambientState");
const clipStateEl = document.querySelector("#clipState");
const calibrateAmbientBtn = document.querySelector("#calibrateAmbientBtn");
const setThresholdBtn = document.querySelector("#setThresholdBtn");
const inputSignalLed = document.querySelector("#inputSignalLed");
const holdLed = document.querySelector("#holdLed");
const sliderReadouts = [
  ["#inputTrimDb", "#inputTrimDbValue"],
  ["#programLevelDb", "#programLevelDbValue"],
  ["#programDuckDb", "#programDuckDbValue"],
  ["#targetMarginDb", "#targetMarginDbValue"],
  ["#maxAddedGainDb", "#maxAddedGainDbValue"],
];
const sliderDefaults = {
  inputTrimDb: 0,
  programLevelDb: 0,
  programDuckDb: 12,
  targetMarginDb: 12,
  maxAddedGainDb: 36,
};

let pendingAction = null;
let lastDeviceSignature = "";
let liveProcessingTimer = null;
let liveInputTimer = null;
let lastProcessing = null;
let lastState = null;
let zoneUpdateTimer = null;
let selectedZoneId = 1;
let editingZoneNameId = 0;
let systemInfoOpen = false;
let assignReceiverZoneId = 0;
let calibrateDelayZoneId = 0;
let zoneDetailsSignature = "";
const identifyingZones = new Set();
const identifyTimers = new Map();
const THRESHOLD_NOISE_MARGIN_DB = 6;

for (const [inputSelector, outputSelector] of sliderReadouts) {
  const input = document.querySelector(inputSelector);
  const output = document.querySelector(outputSelector);
  input.addEventListener("input", () => {
    output.value = formatNumber(Number(input.value));
    queueLiveUpdateForInput(input.id);
  });
}

for (const button of document.querySelectorAll("[data-reset-slider]")) {
  button.addEventListener("click", () => {
    const input = document.querySelector(`#${button.dataset.resetSlider}`);
    const defaultValue = sliderDefaults[button.dataset.resetSlider];
    input.value = defaultValue;
    syncSliderReadouts();
    queueLiveUpdateForInput(input.id);
  });
}

setupTypeSelect.addEventListener("change", () => {
  applySetupMode(setupTypeSelect.value);
  queueLiveInputUpdate();
});

programSourceSelect.addEventListener("change", () => {
  queueLiveInputUpdate();
});

for (const selector of ["#gateThresholdDb", "#holdMs", "#baselineAmbientDb", "#limiterCeilingDb"]) {
  document.querySelector(selector).addEventListener("change", () => {
    queueLiveProcessingUpdate();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (lastState?.stream?.running) {
    await postJson("/api/stream/stop", {}, "stop");
    return;
  }
  const body = Object.fromEntries(new FormData(form).entries());
  body.targetPort = Number(body.targetPort);
  body.zoneId = Number(body.zoneId);
  body.streamId = Number(body.streamId);
  body.frequencyHz = Number(body.frequencyHz);
  body.gain = Number(body.gain);
  body.setupType = String(body.setupType);
  body.programSourceId = String(body.programSourceId || "");
  body.programLevelDb = Number(body.programLevelDb);
  body.programDuckDb = Number(body.programDuckDb);
  body.inputTrimDb = Number(body.inputTrimDb);
  body.gateThresholdDb = Number(body.gateThresholdDb);
  body.holdMs = Number(body.holdMs);
  body.baselineAmbientDb = Number(body.baselineAmbientDb);
  body.targetMarginDb = Number(body.targetMarginDb);
  body.maxAddedGainDb = Number(body.maxAddedGainDb);
  body.limiterCeilingDb = Number(body.limiterCeilingDb);
  await postJson("/api/stream/start", body, "start");
});

if (stopBtn) {
  stopBtn.addEventListener("click", async () => {
    await postJson("/api/stream/stop", {}, "stop");
  });
}

calibrateAmbientBtn.addEventListener("click", async () => {
  await postJson("/api/processing/calibrate-ambient", {}, "calibrate");
});

setThresholdBtn.addEventListener("click", () => {
  const sourceRmsDb = Number(lastProcessing?.sourceRmsDb);
  const thresholdDb = clamp(
    (Number.isFinite(sourceRmsDb) ? sourceRmsDb : -90) + THRESHOLD_NOISE_MARGIN_DB,
    -90,
    0
  );
  setInputValue("#gateThresholdDb", Math.round(thresholdDb));
  queueLiveProcessingUpdate();
});

refreshDevicesBtn.addEventListener("click", async () => {
  await postJson("/api/audio-devices/refresh", {}, "refresh");
});

uploadAudioBtn.addEventListener("click", async () => {
  await uploadAudioFile();
});

zoneDetailsEl.addEventListener("change", (event) => {
  const control = event.target.closest("[data-zone-field]");
  if (!control) return;
  queueZoneUpdate(control.closest("[data-zone-id]"));
});

zoneDetailsEl.addEventListener("input", (event) => {
  const control = event.target.closest("[data-zone-field]");
  if (!control || control.type !== "range") return;
  const output = zoneDetailsEl.querySelector(`[data-zone-output="${control.dataset.zoneField}"]`);
  if (output) output.value = formatNumber(Number(control.value));
  if (control.dataset.zoneField === "delayOffsetMs") {
    const controls = control.closest("[data-zone-id]");
    const delayMs = Number(controls?.querySelector("[data-zone-field='delayMs']")?.value || 0);
    const delayTotal = delayMs + Number(control.value || 0);
    const delayReadout = zoneDetailsEl.querySelector("[data-zone-live='delayTotal']");
    if (delayReadout) delayReadout.textContent = `${formatNumber(delayTotal)} ms`;
  }
  queueZoneUpdate(control.closest("[data-zone-id]"));
});

zoneDetailsEl.addEventListener("keydown", (event) => {
  const nameInput = event.target.closest("[data-zone-field='name']");
  if (!nameInput) return;
  if (event.key === "Enter") {
    event.preventDefault();
    nameInput.blur();
    editingZoneNameId = 0;
    if (lastState) renderZoneDetails(lastState);
  }
  if (event.key === "Escape") {
    editingZoneNameId = 0;
    if (lastState) renderZoneDetails(lastState);
  }
});

zoneDetailsEl.addEventListener("click", (event) => {
  const closeAssignReceiverButton = event.target.closest("[data-zone-action='close-assign-receiver']");
  if (closeAssignReceiverButton) {
    assignReceiverZoneId = 0;
    if (lastState) renderZoneDetails(lastState);
    return;
  }

  const closeCalibrateDelayButton = event.target.closest("[data-zone-action='close-calibrate-delay']");
  if (closeCalibrateDelayButton) {
    calibrateDelayZoneId = 0;
    if (lastState) renderZoneDetails(lastState);
    return;
  }

  const systemInfoButton = event.target.closest("[data-zone-action='toggle-system-info']");
  if (systemInfoButton) {
    systemInfoOpen = !systemInfoOpen;
    if (lastState) renderZoneDetails(lastState);
    return;
  }

  const assignReceiverButton = event.target.closest("[data-zone-action='assign-receiver']");
  if (assignReceiverButton) {
    const controls = assignReceiverButton.closest("[data-zone-id]");
    const zoneId = Number(controls?.dataset.zoneId || 0);
    assignReceiverZoneId = assignReceiverZoneId === zoneId ? 0 : zoneId;
    if (lastState) renderZoneDetails(lastState);
    return;
  }

  const calibrateDelayButton = event.target.closest("[data-zone-action='calibrate-delay']");
  if (calibrateDelayButton) {
    const controls = calibrateDelayButton.closest("[data-zone-id]");
    const zoneId = Number(controls?.dataset.zoneId || 0);
    calibrateDelayZoneId = calibrateDelayZoneId === zoneId ? 0 : zoneId;
    if (lastState) renderZoneDetails(lastState);
    return;
  }

  const identifyButton = event.target.closest("[data-zone-action='identify']");
  if (identifyButton) {
    const controls = identifyButton.closest("[data-zone-id]");
    const zoneId = Number(controls?.dataset.zoneId || 0);
    startIdentifyFeedback(zoneId);
    return;
  }

  const editNameButton = event.target.closest("[data-zone-action='edit-name']");
  if (editNameButton) {
    const controls = editNameButton.closest("[data-zone-id]");
    editingZoneNameId = Number(controls.dataset.zoneId || 0);
    if (lastState) renderZoneDetails(lastState);
    setTimeout(() => zoneDetailsEl.querySelector("[data-zone-field='name']")?.focus(), 0);
    return;
  }

  const ambientBaselineButton = event.target.closest("[data-zone-action='calibrate-ambient']");
  if (ambientBaselineButton) {
    const controls = ambientBaselineButton.closest("[data-zone-id]");
    void postJson("/api/zones/calibrate-ambient", { zoneId: Number(controls.dataset.zoneId) }, "calibrate");
    return;
  }

  const muteButton = event.target.closest("[data-zone-action='mute']");
  if (muteButton) {
    const controls = muteButton.closest("[data-zone-id]");
    const zoneId = Number(controls.dataset.zoneId || 0);
    const body = zoneControlBody(controls);
    body.enabled = !body.enabled;
    const zone = lastState?.zones?.find((item) => item.id === zoneId);
    if (zone) {
      zone.enabled = body.enabled;
      render(lastState);
    }
    clearTimeout(zoneUpdateTimer);
    void postZoneConfig(body);
    return;
  }
});

document.addEventListener("click", (event) => {
  let changed = false;
  if (assignReceiverZoneId) {
    const isAssignClick = event.target.closest(".assign-receiver-panel")
      || event.target.closest("[data-zone-action='assign-receiver']");
    if (!isAssignClick) {
      assignReceiverZoneId = 0;
      changed = true;
    }
  }
  if (calibrateDelayZoneId) {
    const isDelayClick = event.target.closest(".calibrate-delay-panel")
      || event.target.closest("[data-zone-action='calibrate-delay']");
    if (!isDelayClick) {
      calibrateDelayZoneId = 0;
      changed = true;
    }
  }
  if (changed && lastState) renderZoneDetails(lastState);
});

zonesEl.addEventListener("pointerdown", (event) => {
  if (event.target.closest("input, button, select, textarea, summary, details")) return;
  const card = event.target.closest(".zone-card");
  if (!card) return;
  selectZoneCard(card);
});

zonesEl.addEventListener("click", (event) => {
  if (event.target.closest("input, button, select, textarea, summary, details")) return;
  const card = event.target.closest(".zone-card");
  if (!card) return;
  selectZoneCard(card);
});

async function postJson(url, body, action) {
  if (pendingAction) return;
  pendingAction = action;
  setUiMessage("");
  updatePendingControls();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    render(data);
  } catch (err) {
    setUiMessage(err.message || String(err));
  } finally {
    pendingAction = null;
    updatePendingControls();
  }
}

function processingFormBody() {
  return {
    inputTrimDb: Number(document.querySelector("#inputTrimDb").value),
    gateThresholdDb: Number(document.querySelector("#gateThresholdDb").value),
    holdMs: Number(document.querySelector("#holdMs").value),
    baselineAmbientDb: Number(document.querySelector("#baselineAmbientDb").value),
    targetMarginDb: Number(document.querySelector("#targetMarginDb").value),
    maxAddedGainDb: Number(document.querySelector("#maxAddedGainDb").value),
    limiterCeilingDb: Number(document.querySelector("#limiterCeilingDb").value),
  };
}

function inputFormBody() {
  return {
    setupType: setupTypeSelect.value,
    programSourceId: programSourceSelect.value,
    programLevelDb: Number(document.querySelector("#programLevelDb").value),
    programDuckDb: Number(document.querySelector("#programDuckDb").value),
  };
}

function queueLiveUpdateForInput(inputId) {
  if (inputId === "programLevelDb" || inputId === "programDuckDb") {
    queueLiveInputUpdate();
  } else {
    queueLiveProcessingUpdate();
  }
}

function queueLiveProcessingUpdate() {
  clearTimeout(liveProcessingTimer);
  liveProcessingTimer = setTimeout(() => {
    void postLiveProcessingUpdate();
  }, 80);
}

function queueLiveInputUpdate() {
  clearTimeout(liveInputTimer);
  liveInputTimer = setTimeout(() => {
    void postLiveInputUpdate();
  }, 80);
}

async function postLiveProcessingUpdate() {
  try {
    const res = await fetch("/api/processing/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(processingFormBody()),
    });
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    render(data);
  } catch (err) {
    setUiMessage(err.message || String(err));
  }
}

async function postLiveInputUpdate() {
  try {
    const res = await fetch("/api/input/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputFormBody()),
    });
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    render(data);
  } catch (err) {
    setUiMessage(err.message || String(err));
  }
}

function selectZoneCard(card) {
  selectedZoneId = Number(card.dataset.zoneId || 1);
  for (const item of zonesEl.querySelectorAll(".zone-card")) {
    item.classList.toggle("selected", Number(item.dataset.zoneId) === selectedZoneId);
  }
  if (lastState) renderZoneDetails(lastState);
}

function startIdentifyFeedback(zoneId) {
  if (!zoneId) return;
  if (identifyingZones.has(zoneId)) {
    identifyingZones.delete(zoneId);
    clearTimeout(identifyTimers.get(zoneId));
    identifyTimers.delete(zoneId);
    if (lastState) renderZoneDetails(lastState);
    return;
  }
  identifyingZones.add(zoneId);
  clearTimeout(identifyTimers.get(zoneId));
  identifyTimers.set(zoneId, setTimeout(() => {
    identifyingZones.delete(zoneId);
    identifyTimers.delete(zoneId);
    if (lastState) renderZoneDetails(lastState);
  }, 10000));
  if (lastState) renderZoneDetails(lastState);
}

function zoneControlBody(container) {
  const zoneId = Number(container.dataset.zoneId);
  const field = (name) => zoneDetailsEl.querySelector(`[data-zone-id="${zoneId}"] [data-zone-field='${name}']`);
  return {
    zoneId,
    name: field("name").value,
    enabled: field("enabled").checked,
    receiverHost: field("receiverHost").value,
    baselineAmbientDb: Number(field("baselineAmbientDb").value),
    delayMs: Number(field("delayMs").value),
    delayOffsetMs: Number(field("delayOffsetMs").value),
    outputTrimDb: Number(field("outputTrimDb").value),
  };
}

function queueZoneUpdate(container) {
  clearTimeout(zoneUpdateTimer);
  zoneUpdateTimer = setTimeout(() => {
    void postZoneUpdate(container);
  }, 120);
}

async function postZoneUpdate(container) {
  await postZoneConfig(zoneControlBody(container));
}

async function postZoneConfig(body) {
  try {
    const res = await fetch("/api/zones/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    render(data);
  } catch (err) {
    setUiMessage(err.message || String(err));
  }
}

async function uploadAudioFile() {
  if (pendingAction) return;
  const file = audioFileInput.files?.[0];
  if (!file) {
    setUiMessage("Choose an audio file first.");
    return;
  }

  pendingAction = "upload";
  setUiMessage("");
  updatePendingControls();
  try {
    const res = await fetch("/api/audio-file", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: await file.arrayBuffer(),
    });
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    render(data);
    if (data.uploadedSourceId) {
      sourceSelect.value = data.uploadedSourceId;
    }
    setUiMessage(`Loaded ${file.name}`);
  } catch (err) {
    setUiMessage(err.message || String(err));
  } finally {
    pendingAction = null;
    updatePendingControls();
  }
}

function render(state) {
  lastState = state;
  if (runState) {
    runState.textContent = state.stream.running ? "Running" : "Stopped";
    runState.classList.toggle("running", state.stream.running);
  }
  if (startBtn) {
    startBtn.textContent = state.stream.running ? "Stop System" : "Start System";
    startBtn.classList.toggle("danger-action", state.stream.running);
  }
  if (headerSource) headerSource.textContent = shortSourceName(state.stream.sourceName || state.stream.sourceId || "-");
  if (headerAnnouncement) headerAnnouncement.textContent = state.processing?.state || "Idle";
  const telemetryFresh = state.telemetry?.lastPacketAt
    ? Date.now() - Date.parse(state.telemetry.lastPacketAt) < 2500
    : false;
  if (headerNetwork) headerNetwork.textContent = telemetryFresh ? "Healthy" : "Waiting";
  if (announcementSourceName) {
    announcementSourceName.textContent = shortSourceName(state.stream.sourceName || state.stream.sourceId || "-");
  }
  if (programSourceName) {
    programSourceName.textContent = shortSourceName(state.input?.programSourceName || state.input?.programSourceId || "-");
  }

  setInputValue("#targetHost", state.stream.targetHost);
  setInputValue("#targetPort", state.stream.targetPort);
  setInputValue("#zoneId", state.stream.zoneId);
  setInputValue("#streamId", state.stream.streamId);
  setInputValue("#frequencyHz", state.stream.frequencyHz);
  setInputValue("#gain", state.stream.gain);
  setInputValue("#setupType", state.input?.setupType ?? "announcement-only");
  setInputValue("#programLevelDb", state.input?.programLevelDb ?? 0);
  setInputValue("#programDuckDb", state.input?.programDuckDb ?? 12);
  setInputValue("#inputTrimDb", state.processing?.inputTrimDb ?? 0);
  setInputValue("#gateThresholdDb", state.processing?.gateThresholdDb ?? -50);
  setInputValue("#holdMs", state.processing?.holdMs ?? 1000);
  setInputValue("#baselineAmbientDb", state.processing?.baselineAmbientDb ?? -60);
  setInputValue("#targetMarginDb", state.processing?.targetMarginDb ?? 12);
  setInputValue("#maxAddedGainDb", state.processing?.maxAddedGainDb ?? 36);
  setInputValue("#limiterCeilingDb", state.processing?.limiterCeilingDb ?? -1);
  applySetupMode(state.input?.setupType ?? "announcement-only");
  renderSourceOptions(sourceSelect, state.audioDevices, state.stream.sourceId);
  renderSourceOptions(programSourceSelect, state.audioDevices, state.input?.programSourceId || "", "Choose program source");
  renderMeters(state);
  renderZones(state);
  renderZoneDetails(state);
  syncSliderReadouts();
  updatePendingControls();

  setDl(streamStats, {
    "Setup type": setupLabel(state.input?.setupType),
    Target: `${state.stream.targetHost}:${state.stream.targetPort}`,
    "Announcement input": state.stream.sourceName || state.stream.sourceId,
    "Program input": state.input?.programSourceName || "-",
    Zone: state.stream.zoneId,
    Stream: state.stream.streamId,
    Sequence: state.stream.seq,
    Timestamp: state.stream.timestamp,
    "Packets sent": state.stream.packetsSent,
    "Capture received": state.stream.captureFramesReceived ?? "-",
    "Capture queue": state.stream.captureQueueFrames ?? "-",
    "Capture drops": state.stream.captureDrops ?? "-",
    "Capture underflows": state.stream.captureUnderflows ?? "-",
    "Capture repeats": state.stream.captureRepeats ?? "-",
    Started: state.stream.startedAt || "-",
    Error: state.stream.lastError || "-",
  });

  const last = state.telemetry.last;
  const debug = last?.payload?.debug;
  const lag = estimateReceiverLag(state, last, debug);
  setDl(telemetryStats, {
    "Packets received": state.telemetry.packetsReceived,
    "Last from": state.telemetry.lastFrom || "-",
    "Last at": state.telemetry.lastPacketAt || "-",
    "Receiver seq": last?.payload?.lastSeq ?? "-",
    "Seq gap": lag ? lag.sequenceGapPackets : "-",
    "Network lag ms": lag ? lag.networkLagMs : "-",
    "Playback lag ms": lag ? lag.playbackLagMs : "-",
    "Estimated audio lag ms": lag ? lag.totalLagMs : "-",
    "Receiver pps": debug?.receiverPps ?? "-",
    "Receiver packets": debug?.totalPackets ?? "-",
    "Ambient RMS": last?.payload?.ambientRms ?? "-",
    "Buffer ms": last?.payload?.bufferMs ?? "-",
    "Loss ppm": last?.payload?.packetLossPpm ?? "-",
    "Lost packets": debug?.lostPackets ?? "-",
    "Late packets": debug?.latePackets ?? "-",
    "Playback frames": debug?.playbackBufferFrames ?? "-",
    "Playback underflows": debug?.playbackUnderflows ?? "-",
    "Playback drops": debug?.playbackDrops ?? "-",
    "Playback pipes": debug?.playbackBrokenPipes ?? "-",
    "Playback exit": debug?.playbackExitCode ?? "-",
    "Parse errors": debug?.parseErrors ?? "-",
    Errors: state.telemetry.errors,
  });

  deviceScanState.textContent = scanText(state.audioDeviceScan);
  devicesEl.innerHTML = "";
  for (const device of state.audioDevices) {
    const row = document.createElement("div");
    row.className = `device${device.id === state.stream.sourceId ? " selected" : ""}`;
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(device.name)}</strong>
        <div class="muted">${escapeHtml(device.note || device.kind)}</div>
      </div>
      <span class="muted">${escapeHtml(deviceLabel(device))}</span>
    `;
    devicesEl.append(row);
  }
}

function renderMeters(state) {
  const processing = state.processing || {};
  lastProcessing = processing;
  renderMeterStack(inputMeterEl, [
    {
      label: "Announcement Level",
      value: processing.sourceRmsDb,
      suffix: "dBFS",
      threshold: processing.gateThresholdDb,
      fill: "source",
    },
  ]);

  const ambientDb = processing.ambientRmsDb;
  renderMeterStack(ambientMeterEl, [
    {
      label: "Ambient Level",
      value: processing.stableAmbientDb,
      suffix: "dBFS",
      fill: "ambient",
    },
    {
      label: "Baseline",
      value: processing.baselineAmbientDb,
      suffix: "dBFS",
      fill: "target",
    },
    {
      label: "Live Mic",
      value: ambientDb,
      suffix: "dBFS",
      fill: "preview",
    },
  ]);

  renderMeterStack(processingMeterEl, [
    {
      label: "Above Ambient",
      value: processing.targetMarginDb,
      min: 0,
      max: 36,
      suffix: "dB",
      fill: "target",
    },
    {
      label: "Frozen Ambient",
      value: processing.frozenAmbientDb,
      suffix: "dBFS",
      fill: "target",
    },
    {
      label: "Ambient Delta",
      value: processing.ambientDeltaDb,
      min: 0,
      max: Math.max(1, processing.maxAddedGainDb || 36),
      suffix: "dB",
      fill: "gain",
    },
    {
      label: "Preview Gain",
      value: processing.previewAddedGainDb,
      min: 0,
      max: Math.max(1, processing.maxAddedGainDb || 36),
      suffix: "dB",
      fill: "preview",
    },
    {
      label: "Added Gain",
      value: processing.addedGainDb,
      min: 0,
      max: Math.max(1, processing.maxAddedGainDb || 36),
      suffix: "dB",
      fill: "gain",
    },
    {
      label: "Output Gain",
      value: processing.outputGainDb,
      min: -60,
      max: Math.max(12, processing.maxAddedGainDb || 36),
      suffix: "dB",
      fill: "output",
    },
    {
      label: "Output Peak",
      value: processing.outputPeakDb,
      suffix: "dBFS",
      threshold: processing.limiterCeilingDb,
      fill: "output",
    },
    {
      label: "Limiter",
      value: processing.limiterReductionDb,
      min: 0,
      max: 12,
      suffix: "dB",
      fill: "limit",
    },
  ]);

  processingStateEl.textContent = processing.state || "Idle";
  processingStateEl.className = `state-badge ${stateClass(processing.state)}`;
  if (processing.state === "Holding" && Number(processing.holdRemainingMs) > 0) {
    processingStateEl.textContent = `Holding ${processing.holdRemainingMs} ms`;
  }

  ambientStateEl.textContent = Number.isFinite(ambientDb) ? ambientLabel(ambientDb) : "No telemetry";
  ambientStateEl.className = "state-badge";
  if (clipStateEl) {
    clipStateEl.textContent = processing.clipping ? "Clip" : "Clean";
    clipStateEl.className = `state-badge utility-hidden ${processing.clipping ? "danger" : ""}`;
  }

  const inputActive = Number(processing.sourceRmsDb) >= Number(processing.gateThresholdDb);
  inputSignalLed.className = `led ${inputActive ? "on" : ""}`;
  const holdActive = processing.state === "Active" || processing.state === "Holding";
  holdLed.className = `led ${holdActive ? "on" : ""}`;
}

function renderZones(state) {
  const processing = state.processing || {};
  const telemetryFresh = state.telemetry?.lastPacketAt
    ? Date.now() - Date.parse(state.telemetry.lastPacketAt) < 2500
    : false;
  const visibleZones = (state.zones || []).filter((zone) => zone.userVisible).slice(0, 8);
  if (!visibleZones.some((zone) => zone.id === selectedZoneId)) {
    selectedZoneId = visibleZones[0]?.id ?? 1;
  }
  zonesEl.innerHTML = "";

  for (const zone of visibleZones) {
    const isLiveZone = zone.id === Number(state.stream.zoneId || 1);
    const connected = isLiveZone && telemetryFresh;
    const calculatedBoost = isLiveZone ? processing.previewAddedGainDb : null;
    const baselineAmbientDb = Number(zone.baselineAmbientDb ?? -60);
    const card = document.createElement("article");
    card.className = `zone-card ${zone.enabled ? "" : "disabled"} ${zone.id === selectedZoneId ? "selected" : ""}`;
    card.dataset.zoneId = zone.id;
    card.innerHTML = `
      <div class="zone-card-head">
        <div class="zone-title-block">
          <span class="zone-number">${zone.id}</span>
          <span class="zone-name">${escapeHtml(zone.name)}</span>
        </div>
        <div class="zone-card-badges">
          ${zone.enabled ? "" : `<span class="zone-muted-badge">Muted</span>`}
          <span class="zone-online ${connected ? "online" : ""}">${connected ? "Online" : "Offline"}</span>
        </div>
      </div>
      <div class="zone-metrics">
        ${metricRow("Ambient Level", isLiveZone ? formatDb(processing.stableAmbientDb, "dBFS") : "-")}
        ${metricRow("Ambient Baseline", formatDb(baselineAmbientDb, "dBFS"))}
        ${metricRow("Calculated Boost", Number.isFinite(calculatedBoost) ? formatDb(calculatedBoost, "dB") : "-")}
      </div>
      ${segmentMeter(isLiveZone ? processing.outputPeakDb : -90)}
    `;
    zonesEl.append(card);
  }
}

function renderZoneDetails(state) {
  if (zoneDetailsEl.contains(document.activeElement) && document.activeElement.matches("[data-zone-field]")) {
    updateZoneDetailsLive(state);
    return;
  }

  const zones = state.zones || [];
  const zone = zones.find((item) => item.id === selectedZoneId) || zones.find((item) => item.userVisible);
  if (!zone) {
    zoneDetailTitle.textContent = "Zone Details";
    zoneDetailsEl.innerHTML = "";
    return;
  }

  const processing = state.processing || {};
  const last = state.telemetry.last;
  const debug = last?.payload?.debug;
  const isLiveZone = zone.id === Number(state.stream.zoneId || 1);
  const telemetryFresh = state.telemetry?.lastPacketAt
    ? Date.now() - Date.parse(state.telemetry.lastPacketAt) < 2500
    : false;
  const lag = estimateReceiverLag(state, last, debug);
  const lastPacketAge = state.telemetry?.lastPacketAt
    ? `${formatNumber((Date.now() - Date.parse(state.telemetry.lastPacketAt)) / 1000)} s ago`
    : "-";
  const baselineAmbientDb = Number(zone.baselineAmbientDb ?? -60);
  const delayMs = Number(zone.delayMs || 0);
  const delayOffsetMs = Number(zone.delayOffsetMs || 0);
  const outputTrimDb = Number(zone.outputTrimDb || 0);
  const delayTotalMs = delayMs + delayOffsetMs;
  const receiverQuality = isLiveZone ? (debug?.receiverPps ?? "-") : "-";
  const streamLocked = isLiveZone && telemetryFresh;
  const editingName = editingZoneNameId === zone.id;
  const assigningReceiver = assignReceiverZoneId === zone.id;
  const calibratingDelay = calibrateDelayZoneId === zone.id;
  const identifying = identifyingZones.has(zone.id);
  const nextSignature = zoneDetailsStaticSignature(state, zone);
  if (zoneDetailsEl.dataset.zoneId === String(zone.id) && zoneDetailsSignature === nextSignature) {
    updateZoneDetailsLive(state);
    return;
  }
  zoneDetailsSignature = nextSignature;

  zoneDetailTitle.textContent = "Zone Details";
  zoneDetailsEl.dataset.zoneId = String(zone.id);
  zoneDetailsEl.innerHTML = `
    <section class="detail-group selected-zone-panel" data-zone-id="${zone.id}">
      <div class="selected-zone-title">
        <span class="zone-number">${zone.id}</span>
        <strong>${escapeHtml(zone.name)}</strong>
        <button type="button" class="icon-button edit-name-button" data-zone-action="edit-name" title="Edit zone name" aria-label="Edit zone name">✎</button>
        <span class="zone-online ${streamLocked ? "online" : ""}" data-zone-live="selectedStatus">${streamLocked ? "Online" : "Offline"}</span>
      </div>
      <label class="${editingName ? "" : "utility-hidden"}">
        Zone Name
        <input data-zone-field="name" value="${escapeHtml(zone.name)}" autocomplete="off">
      </label>
    </section>
    <section class="detail-group">
      <h3><span>${zone.id}</span> Receiver Status</h3>
      ${detailRow("Stream Locked", streamLocked ? "Yes" : "No", streamLocked, "", "streamLocked")}
      ${detailRow("Quality", receiverQuality === "-" ? "-" : `${receiverQuality} PPS`, true, "", "quality")}
      ${detailRow("Delay", `${formatNumber(delayTotalMs)} ms`, true, "", "delayTotal")}
      ${detailRow("Receiver IP", zone.receiverHost || "-", true, "", "receiverIp")}
      ${detailRow("Receiver Device ID", zone.receiverId || "-", true, "", "receiverDeviceId")}
    </section>
    <section class="detail-group zone-control-panel" data-zone-id="${zone.id}">
      <h3><span>CTL</span> Zone Controls</h3>
      <input class="utility-hidden" data-zone-field="enabled" type="checkbox" ${zone.enabled ? "checked" : ""}>
      <input class="utility-hidden" data-zone-field="name" value="${escapeHtml(zone.name)}" autocomplete="off">
      <input class="utility-hidden" data-zone-field="delayMs" type="number" value="${delayMs}">
      <div class="detail-buttons">
        <button type="button" class="mute-button ${zone.enabled ? "" : "muted"}" data-zone-action="mute">${zone.enabled ? "Mute" : "Muted"}</button>
        <button type="button" data-zone-action="identify">${identifying ? "Identifying..." : "Identify"}</button>
      </div>
      <button type="button" data-zone-action="assign-receiver" aria-expanded="${assigningReceiver}">Assign Receiver</button>
      <div class="assign-receiver-panel ${assigningReceiver ? "" : "utility-hidden"}">
        <div class="assign-receiver-head">
          <strong>Assign Receiver</strong>
          <button type="button" class="icon-button" data-zone-action="close-assign-receiver" aria-label="Close receiver assignment">x</button>
        </div>
        <div class="detail-row">
          <span>Assigned Device</span>
          <strong>${escapeHtml(zone.receiverId || zone.receiverHost || "Unassigned")}</strong>
        </div>
        <label>
          Receiver Address
          <input data-zone-field="receiverHost" value="${escapeHtml(zone.receiverHost || "")}" autocomplete="off">
        </label>
        <p>Discovered receivers will appear here when device discovery is wired.</p>
      </div>
      <button type="button" data-zone-action="calibrate-ambient">Set Ambient Baseline</button>
      <button type="button" data-zone-action="calibrate-delay" aria-expanded="${calibratingDelay}">Calibrate Delay</button>
      <div class="calibrate-delay-panel ${calibratingDelay ? "" : "utility-hidden"}">
        <div class="assign-receiver-head">
          <strong>Calibrate Delay</strong>
          <button type="button" class="icon-button" data-zone-action="close-calibrate-delay" aria-label="Close delay calibration">x</button>
        </div>
        <p>Delay calibration will be added later.</p>
      </div>
      <label class="slider-field">
        <span class="field-head">
          Delay Offset ms
          <output data-zone-output="delayOffsetMs">${formatNumber(delayOffsetMs)}</output>
        </span>
        <input data-zone-field="delayOffsetMs" type="range" min="-100" max="100" step="0.5" value="${delayOffsetMs}">
      </label>
      <label class="slider-field">
        <span class="field-head">
          Output Trim dB
          <output data-zone-output="outputTrimDb">${formatNumber(outputTrimDb)}</output>
        </span>
        <input data-zone-field="outputTrimDb" type="range" min="-60" max="0" step="0.5" value="${outputTrimDb}">
      </label>
      <input class="utility-hidden" data-zone-field="baselineAmbientDb" type="number" min="-90" max="0" step="0.1" value="${baselineAmbientDb}">
    </section>
    <section class="detail-group system-info-panel ${systemInfoOpen ? "open" : ""}">
      <button type="button" class="system-info-toggle" data-zone-action="toggle-system-info" aria-expanded="${systemInfoOpen}">
        System Info
      </button>
      <div class="system-info-body ${systemInfoOpen ? "" : "utility-hidden"}">
        ${detailRow("Last Packet", isLiveZone ? lastPacketAge : "-", telemetryFresh, "", "lastPacket")}
        ${detailRow("Loss PPM", isLiveZone ? (last?.payload?.packetLossPpm ?? "-") : "-", true, "", "lossPpm")}
        ${detailRow("Estimated Audio Lag", isLiveZone && lag ? `${lag.totalLagMs} ms` : "-", true, "", "audioLag")}
        ${detailRow("Ambient Level", isLiveZone ? formatDb(processing.stableAmbientDb, "dBFS") : "-", true, "", "ambientLevel")}
        ${detailRow("Ambient Baseline", formatDb(baselineAmbientDb, "dBFS"), true, "", "ambientBaseline")}
        ${detailRow("Ambient Delta", isLiveZone ? formatDb(processing.ambientDeltaDb, "dB") : "-", true, "", "ambientDelta")}
        ${detailRow("Preview Boost", isLiveZone ? formatDb(processing.previewAddedGainDb, "dB") : "-", true, "", "previewBoost")}
        ${detailRow("Applied Boost", isLiveZone ? formatDb(processing.addedGainDb, "dB") : "-", true, "accent", "appliedBoost")}
        ${detailRow("Max Boost", formatDb(processing.maxAddedGainDb, "dB"), true, "", "maxBoost")}
        ${detailRow("Output Trim", formatDb(outputTrimDb, "dB"), true, "", "outputTrim")}
        ${detailRow("Limiter", processing.limiterReductionDb > 0 ? "Reducing" : "On", processing.limiterReductionDb <= 0, "", "limiter")}
        ${detailRow("Buffer", isLiveZone ? `${last?.payload?.bufferMs ?? "-"} ms` : "-", true, "", "buffer")}
        ${detailRow("Playback Frames", isLiveZone ? (debug?.playbackBufferFrames ?? "-") : "-", true, "", "playbackFrames")}
        ${detailRow("Underflows", isLiveZone ? (debug?.playbackUnderflows ?? "-") : "-", true, "", "underflows")}
      </div>
    </section>
  `;
}

function zoneDetailsStaticSignature(state, zone) {
  return JSON.stringify({
    selectedZoneId,
    zoneId: zone.id,
    name: zone.name,
    enabled: zone.enabled,
    receiverHost: zone.receiverHost || "",
    receiverId: zone.receiverId || "",
    baselineAmbientDb: Number(zone.baselineAmbientDb ?? -60),
    delayMs: Number(zone.delayMs || 0),
    delayOffsetMs: Number(zone.delayOffsetMs || 0),
    outputTrimDb: Number(zone.outputTrimDb || 0),
    editingName: editingZoneNameId === zone.id,
    assigningReceiver: assignReceiverZoneId === zone.id,
    calibratingDelay: calibrateDelayZoneId === zone.id,
    identifying: identifyingZones.has(zone.id),
    systemInfoOpen,
  });
}

function zoneDetailsLiveValues(state) {
  const zones = state.zones || [];
  const zone = zones.find((item) => item.id === selectedZoneId) || zones.find((item) => item.userVisible);
  if (!zone) return null;

  const processing = state.processing || {};
  const last = state.telemetry.last;
  const debug = last?.payload?.debug;
  const isLiveZone = zone.id === Number(state.stream.zoneId || 1);
  const telemetryFresh = state.telemetry?.lastPacketAt
    ? Date.now() - Date.parse(state.telemetry.lastPacketAt) < 2500
    : false;
  const lag = estimateReceiverLag(state, last, debug);
  const lastPacketAge = state.telemetry?.lastPacketAt
    ? `${formatNumber((Date.now() - Date.parse(state.telemetry.lastPacketAt)) / 1000)} s ago`
    : "-";
  const baselineAmbientDb = Number(zone.baselineAmbientDb ?? -60);
  const delayMs = Number(zone.delayMs || 0);
  const delayOffsetMs = Number(zone.delayOffsetMs || 0);
  const outputTrimDb = Number(zone.outputTrimDb || 0);
  const delayTotalMs = delayMs + delayOffsetMs;
  const receiverQuality = isLiveZone ? (debug?.receiverPps ?? "-") : "-";
  const streamLocked = isLiveZone && telemetryFresh;

  return {
    selectedStatus: { value: streamLocked ? "Online" : "Offline", positive: streamLocked },
    streamLocked: { value: streamLocked ? "Yes" : "No", positive: streamLocked },
    quality: { value: receiverQuality === "-" ? "-" : `${receiverQuality} PPS`, positive: true },
    delayTotal: { value: `${formatNumber(delayTotalMs)} ms`, positive: true },
    receiverIp: { value: zone.receiverHost || "-", positive: true },
    receiverDeviceId: { value: zone.receiverId || "-", positive: true },
    lastPacket: { value: isLiveZone ? lastPacketAge : "-", positive: telemetryFresh },
    lossPpm: { value: isLiveZone ? (last?.payload?.packetLossPpm ?? "-") : "-", positive: true },
    audioLag: { value: isLiveZone && lag ? `${lag.totalLagMs} ms` : "-", positive: true },
    ambientLevel: { value: isLiveZone ? formatDb(processing.stableAmbientDb, "dBFS") : "-", positive: true },
    ambientBaseline: { value: formatDb(baselineAmbientDb, "dBFS"), positive: true },
    ambientDelta: { value: isLiveZone ? formatDb(processing.ambientDeltaDb, "dB") : "-", positive: true },
    previewBoost: { value: isLiveZone ? formatDb(processing.previewAddedGainDb, "dB") : "-", positive: true },
    appliedBoost: { value: isLiveZone ? formatDb(processing.addedGainDb, "dB") : "-", positive: true },
    maxBoost: { value: formatDb(processing.maxAddedGainDb, "dB"), positive: true },
    outputTrim: { value: formatDb(outputTrimDb, "dB"), positive: true },
    limiter: { value: processing.limiterReductionDb > 0 ? "Reducing" : "On", positive: processing.limiterReductionDb <= 0 },
    buffer: { value: isLiveZone ? `${last?.payload?.bufferMs ?? "-"} ms` : "-", positive: true },
    playbackFrames: { value: isLiveZone ? (debug?.playbackBufferFrames ?? "-") : "-", positive: true },
    underflows: { value: isLiveZone ? (debug?.playbackUnderflows ?? "-") : "-", positive: true },
  };
}

function updateZoneDetailsLive(state) {
  const values = zoneDetailsLiveValues(state);
  if (!values) return;
  for (const [key, item] of Object.entries(values)) {
    const target = zoneDetailsEl.querySelector(`[data-zone-live="${key}"]`);
    if (!target) continue;
    target.textContent = item.value;
    target.classList.toggle("positive", Boolean(item.positive));
    target.classList.toggle("negative", !item.positive);
    if (key === "selectedStatus") {
      target.classList.toggle("online", Boolean(item.positive));
    }
  }
}

function metricRow(label, value) {
  return `
    <div class="zone-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function detailRow(label, value, positive = true, emphasis = "", liveKey = "") {
  return `
    <div class="detail-row ${emphasis}">
      <span>${escapeHtml(label)}</span>
      <strong class="${positive ? "positive" : "negative"}" ${liveKey ? `data-zone-live="${escapeHtml(liveKey)}"` : ""}>${escapeHtml(value)}</strong>
    </div>
  `;
}

function segmentMeter(db) {
  const percent = clamp(((Number(db) - -60) / 60) * 100, 0, 100);
  const lit = Math.round((percent / 100) * 28);
  let segments = "";
  for (let i = 0; i < 28; i += 1) {
    const hot = i > 21;
    const warm = i > 16;
    segments += `<span class="${i < lit ? (hot ? "hot" : warm ? "warm" : "lit") : ""}"></span>`;
  }
  return `<div class="segment-meter" aria-label="Zone output level">${segments}</div>`;
}

function renderMeterStack(root, rows) {
  root.innerHTML = "";
  for (const row of rows) {
    const min = row.min ?? -90;
    const max = row.max ?? 0;
    const value = Number.isFinite(row.value) ? row.value : min;
    const percent = clamp(((value - min) / (max - min)) * 100, 0, 100);
    const item = document.createElement("div");
    item.className = "meter-row";
    item.innerHTML = `
      <div class="meter-label">
        <span>${escapeHtml(row.label)}</span>
        <strong>${formatNumber(value)} ${escapeHtml(row.suffix || "")}</strong>
      </div>
      <div class="meter-track">
        <div class="meter-fill ${escapeHtml(row.fill || "")}" style="width: ${percent}%"></div>
        ${Number.isFinite(row.threshold) ? `<div class="meter-threshold" style="left: ${clamp(((row.threshold - min) / (max - min)) * 100, 0, 100)}%"></div>` : ""}
      </div>
    `;
    root.append(item);
  }
}

function ambientLabel(db) {
  if (db <= -75) return "Quiet";
  if (db <= -45) return "Normal";
  return "Loud";
}

function stateClass(state) {
  if (state === "Active" || state === "Holding") return "active";
  if (state === "Opening" || state === "Releasing") return "warn";
  return "";
}

function setupLabel(mode) {
  if (mode === "mixed-feed") return "Mixed Feed";
  if (mode === "program-announcement") return "Program + Announcement";
  return "Announcement Only";
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(1);
}

function formatDb(value, suffix) {
  if (!Number.isFinite(value)) return "-";
  return `${formatNumber(value)} ${suffix}`;
}

function shortSourceName(value) {
  return String(value || "-").replace(/^CoreAudio:\s*/, "").replace(/^AVFoundation:\s*/, "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimateReceiverLag(state, last, debug) {
  const lastSeq = last?.payload?.lastSeq;
  if (!Number.isFinite(lastSeq) || !Number.isFinite(state.stream.seq)) return null;
  const frameMs = 10;
  const sequenceGapPackets = Math.max(0, state.stream.seq - lastSeq - 1);
  const playbackFrames = debug?.playbackBufferFrames ?? Math.round((last?.payload?.bufferMs ?? 0) / frameMs);
  const networkLagMs = sequenceGapPackets * frameMs;
  const playbackLagMs = Math.max(0, playbackFrames) * frameMs;
  return {
    sequenceGapPackets,
    networkLagMs,
    playbackLagMs,
    totalLagMs: networkLagMs + playbackLagMs,
  };
}

function setInputValue(selector, value) {
  const input = document.querySelector(selector);
  if (document.activeElement === input) return;
  input.value = value;
}

function syncSliderReadouts() {
  for (const [inputSelector, outputSelector] of sliderReadouts) {
    const input = document.querySelector(inputSelector);
    const output = document.querySelector(outputSelector);
    output.value = formatNumber(Number(input.value));
  }
}

function applySetupMode(mode) {
  const programMode = mode === "program-announcement";
  for (const field of programModeFields) {
    field.hidden = !programMode;
  }
  if (mode === "mixed-feed") {
    sourceLabel.textContent = "Mixed Feed Input";
  } else {
    sourceLabel.textContent = "Announcement Input";
  }
}

function renderSourceOptions(select, devices, selectedId, placeholder = "") {
  const signature = devices
    .map((device) => `${device.id}:${device.name}:${device.ready ? 1 : 0}`)
    .join("|");
  if (signature === select.dataset.signature && document.activeElement === select) return;

  const currentValue = document.activeElement === select
    ? select.value || selectedId
    : selectedId;
  if (signature === select.dataset.signature) {
    select.value = devices.some((device) => device.id === currentValue) ? currentValue : selectedId;
    return;
  }

  select.innerHTML = "";
  if (placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.name;
    option.disabled = !device.ready;
    select.append(option);
  }
  select.value = devices.some((device) => device.id === currentValue) ? currentValue : selectedId;
  select.dataset.signature = signature;
}

function deviceLabel(device) {
  if (!device.ready) return "Unavailable";
  if (device.kind === "generated") return "Generated";
  if (device.kind === "file") return "File";
  return device.backend || device.kind;
}

function scanText(scan) {
  if (!scan) return "";
  const suffix = scan.scannedAt ? ` Last scan: ${scan.scannedAt}` : "";
  if (scan.status === "scanning") return "Scanning audio devices...";
  if (scan.error) return `${scan.error}${suffix}`;
  return scan.status ? `Status: ${scan.status}.${suffix}` : "";
}

function setDl(dl, rows) {
  dl.innerHTML = "";
  for (const [key, value] of Object.entries(rows)) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function updatePendingControls() {
  startBtn.disabled = Boolean(pendingAction);
  if (stopBtn) stopBtn.disabled = pendingAction === "stop";
  calibrateAmbientBtn.disabled = pendingAction === "calibrate";
  setThresholdBtn.disabled = Boolean(pendingAction);
  refreshDevicesBtn.disabled = pendingAction === "refresh";
  uploadAudioBtn.disabled = pendingAction === "upload";
}

function setUiMessage(message) {
  uiMessage.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function init() {
  const res = await fetch("/api/status");
  render(await res.json());
  const events = new EventSource("/api/events");
  events.addEventListener("message", (event) => {
    render(JSON.parse(event.data));
  });
}

init().catch((err) => {
  console.error(err);
  setUiMessage(err.message || String(err));
});
