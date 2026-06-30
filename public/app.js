"use strict";

const form = document.querySelector("#streamForm");
const stopBtn = document.querySelector("#stopBtn");
const runState = document.querySelector("#runState");
const streamStats = document.querySelector("#streamStats");
const telemetryStats = document.querySelector("#telemetryStats");
const devicesEl = document.querySelector("#devices");
const refreshDevicesBtn = document.querySelector("#refreshDevicesBtn");
const deviceScanState = document.querySelector("#deviceScanState");
const sourceSelect = document.querySelector("#sourceId");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  body.targetPort = Number(body.targetPort);
  body.zoneId = Number(body.zoneId);
  body.streamId = Number(body.streamId);
  body.frequencyHz = Number(body.frequencyHz);
  body.gain = Number(body.gain);
  await postJson("/api/stream/start", body);
});

stopBtn.addEventListener("click", async () => {
  await postJson("/api/stream/stop", {});
});

refreshDevicesBtn.addEventListener("click", async () => {
  await postJson("/api/audio-devices/refresh", {});
});

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  render(await res.json());
}

function render(state) {
  runState.textContent = state.stream.running ? "Running" : "Stopped";
  runState.classList.toggle("running", state.stream.running);

  document.querySelector("#targetHost").value = state.stream.targetHost;
  document.querySelector("#targetPort").value = state.stream.targetPort;
  document.querySelector("#zoneId").value = state.stream.zoneId;
  document.querySelector("#streamId").value = state.stream.streamId;
  document.querySelector("#frequencyHz").value = state.stream.frequencyHz;
  document.querySelector("#gain").value = state.stream.gain;
  renderSourceOptions(state.audioDevices, state.stream.sourceId);

  setDl(streamStats, {
    Target: `${state.stream.targetHost}:${state.stream.targetPort}`,
    Source: state.stream.sourceName || state.stream.sourceId,
    Zone: state.stream.zoneId,
    Stream: state.stream.streamId,
    Sequence: state.stream.seq,
    Timestamp: state.stream.timestamp,
    "Packets sent": state.stream.packetsSent,
    Started: state.stream.startedAt || "-",
    Error: state.stream.lastError || "-",
  });

  const last = state.telemetry.last;
  setDl(telemetryStats, {
    "Packets received": state.telemetry.packetsReceived,
    "Last from": state.telemetry.lastFrom || "-",
    "Last at": state.telemetry.lastPacketAt || "-",
    "Receiver seq": last?.payload?.lastSeq ?? "-",
    "Ambient RMS": last?.payload?.ambientRms ?? "-",
    "Buffer ms": last?.payload?.bufferMs ?? "-",
    "Loss ppm": last?.payload?.packetLossPpm ?? "-",
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

function renderSourceOptions(devices, selectedId) {
  const currentValue = sourceSelect.value || selectedId;
  sourceSelect.innerHTML = "";
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.name;
    option.disabled = !device.ready;
    sourceSelect.append(option);
  }
  sourceSelect.value = devices.some((device) => device.id === currentValue) ? currentValue : selectedId;
}

function deviceLabel(device) {
  if (!device.ready) return "Unavailable";
  if (device.kind === "generated") return "Generated";
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
});
