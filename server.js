#!/usr/bin/env node
"use strict";

const dgram = require("node:dgram");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { URL } = require("node:url");

const {
  ENC_PCM16_LE,
  FLAG_START,
  MSG_AUDIO,
  MSG_TELEMETRY,
  packAudioPacket,
  parsePacket,
} = require("./src/protocol");

const HOST = process.env.AUTO_ANNOUNCE_HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.AUTO_ANNOUNCE_HTTP_PORT || 8080);
const TELEMETRY_HOST = process.env.AUTO_ANNOUNCE_TELEMETRY_HOST || "0.0.0.0";
const TELEMETRY_PORT = Number(process.env.AUTO_ANNOUNCE_TELEMETRY_PORT || 41772);
const DEFAULT_TARGET_HOST = process.env.AUTO_ANNOUNCE_TARGET_HOST || "192.168.10.101";
const SAMPLE_RATE_HZ = 48000;
const FRAME_SAMPLES = 480;
const FRAME_INTERVAL_MS = 10;
const START_CAPTURE_QUEUE_FRAMES = 4;
const TARGET_CAPTURE_QUEUE_FRAMES = 8;
const MAX_CAPTURE_QUEUE_FRAMES = 25;
const MIN_DB = -90;
const REFERENCE_MARGIN_DB = 12;
const AMBIENT_AVERAGE_SECONDS = 2;
const CALIBRATED_BASELINE_AUDIO_DB = -24;
const INTERNAL_ZONE_SLOTS = 10;
const USER_ZONE_SLOTS = 8;
const MEDIA_DIR = path.join(__dirname, "media");
const UPLOAD_DIR = path.join(MEDIA_DIR, "uploads");
const TEST_AUDIO_FILE = path.join(MEDIA_DIR, "test-announcement.wav");
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const CORE_AUDIO_HELPER_SOURCE = path.join(__dirname, "tools", "coreaudio_capture.swift");
const CORE_AUDIO_HELPER_BIN = path.join(__dirname, "tools", "coreaudio_capture");

const state = {
  input: {
    setupType: "announcement-only",
    programSourceId: "",
    programSourceName: "",
    programLevelDb: 0,
    programDuckDb: 12,
  },
  zones: Array.from({ length: INTERNAL_ZONE_SLOTS }, (_, index) => ({
    id: index + 1,
    name: index === 0 ? "Lobby" : `Zone ${index + 1}`,
    enabled: index === 0,
    receiverId: "",
    receiverHost: index === 0 ? DEFAULT_TARGET_HOST : "",
    baselineAmbientDb: -60,
    delayMs: 0,
    delayOffsetMs: 0,
    outputTrimDb: 0,
    userVisible: index < USER_ZONE_SLOTS,
  })),
  stream: {
    running: false,
    targetHost: DEFAULT_TARGET_HOST,
    targetPort: 41771,
    zoneId: 1,
    streamId: 1,
    seq: 0,
    timestamp: 0,
    frequencyHz: 880,
    gain: 0.2,
    sourceId: "test-tone",
    sourceName: "Test tone generator",
    packetsSent: 0,
    captureFramesReceived: 0,
    captureQueueFrames: 0,
    captureDrops: 0,
    captureUnderflows: 0,
    captureRepeats: 0,
    startedAt: null,
    lastError: null,
  },
  telemetry: {
    packetsReceived: 0,
    lastPacketAt: null,
    last: null,
    lastFrom: null,
    errors: 0,
  },
  processing: {
    inputTrimDb: 0,
    gateThresholdDb: -50,
    holdMs: 1000,
    baselineAmbientDb: -60,
    stableAmbientDb: MIN_DB,
    frozenAmbientDb: MIN_DB,
    ambientDeltaDb: 0,
    targetMarginDb: REFERENCE_MARGIN_DB,
    previewAddedGainDb: 0,
    maxAddedGainDb: 36,
    limiterCeilingDb: -1,
    state: "Idle",
    holdRemainingMs: 0,
    sourceRmsDb: MIN_DB,
    sourcePeakDb: MIN_DB,
    ambientRmsDb: MIN_DB,
    addedGainDb: 0,
    outputGainDb: 0,
    limiterReductionDb: 0,
    outputRmsDb: MIN_DB,
    outputPeakDb: MIN_DB,
    clipping: false,
  },
  audioDevices: [
    {
      id: "test-tone",
      name: "Test tone generator",
      kind: "generated",
      generator: "sine",
      ready: true,
      note: "Built-in generated source for network checks.",
    },
    {
      id: "pulse-test",
      name: "Pulse test generator",
      kind: "generated",
      generator: "pulse",
      ready: true,
      note: "Short tick pattern for hearing dropouts and repeats.",
    },
    {
      id: "test-file",
      name: "Test announcement WAV",
      kind: "file",
      filePath: TEST_AUDIO_FILE,
      ready: true,
      note: "Local 48 kHz mono WAV for end-to-end source file checks.",
    },
  ],
  audioDeviceScan: {
    status: "idle",
    error: null,
    scannedAt: null,
  },
};

const clients = new Set();
let senderSocket = null;
let senderTimer = null;
let telemetrySocket = null;
let captureProcess = null;
let captureBuffer = Buffer.alloc(0);
let captureQueue = [];
let captureLastFrame = null;
let audioDeviceScanId = 0;
let nextGeneratedFrameAt = 0;
let nextCaptureFrameAt = 0;
let lastStreamBroadcastAt = 0;
let lastTelemetryBroadcastAt = 0;
let gateHoldUntilMs = 0;
let smoothedOutputGainDb = 0;
let processorWasActive = false;
let stableAmbientDb = null;
let lastAmbientUpdateAt = 0;

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
  });
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function readRawRequestBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        reject(new Error("upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeUploadName(name) {
  const base = path.basename(String(name || "audio-file")).replace(/[^a-zA-Z0-9._ -]/g, "_");
  return base || "audio-file";
}

function fileDeviceName(fileName) {
  return `File: ${fileName}`;
}

function addUploadedAudioFile(fileName, data) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeName = safeUploadName(fileName);
  const parsed = path.parse(safeName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storedName = `${parsed.name || "audio"}-${stamp}${parsed.ext || ""}`;
  const filePath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(filePath, data);

  const existing = state.audioDevices.find((device) => device.kind === "file" && device.uploaded);
  if (existing) {
    existing.id = `file:${storedName}`;
    existing.name = fileDeviceName(safeName);
    existing.filePath = filePath;
    existing.ready = true;
    existing.note = `Uploaded audio file: ${safeName}`;
    return existing;
  }

  const device = {
    id: `file:${storedName}`,
    name: fileDeviceName(safeName),
    kind: "file",
    uploaded: true,
    filePath,
    ready: true,
    note: `Uploaded audio file: ${safeName}`,
  };
  state.audioDevices.splice(generatedDevices().length, 0, device);
  return device;
}

function publicFilePath(urlPath) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.resolve(__dirname, "public", `.${safePath}`);
  const root = path.resolve(__dirname, "public");
  return resolved.startsWith(root) ? resolved : null;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function publicState() {
  return {
    input: state.input,
    zones: state.zones,
    stream: state.stream,
    telemetry: state.telemetry,
    processing: state.processing,
    audioDevices: state.audioDevices,
    audioDeviceScan: state.audioDeviceScan,
  };
}

function makeSineFrame(frameIndex) {
  const frame = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const n = frameIndex * FRAME_SAMPLES + i;
    const sample = Math.round(
      Math.sin((2 * Math.PI * state.stream.frequencyHz * n) / SAMPLE_RATE_HZ) *
      32767 *
      state.stream.gain
    );
    frame.writeInt16LE(sample, i * 2);
  }
  return frame;
}

function makePulseFrame(frameIndex) {
  const frame = Buffer.alloc(FRAME_SAMPLES * 2);
  const frameStart = frameIndex * FRAME_SAMPLES;
  const pulsePeriodSamples = SAMPLE_RATE_HZ / 2;
  const pulseSamples = 96;

  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const n = frameStart + i;
    const phase = n % pulsePeriodSamples;
    let sample = 0;
    if (phase < pulseSamples) {
      const envelope = 1 - phase / pulseSamples;
      sample = Math.round(32767 * state.stream.gain * envelope);
      if (phase % 16 >= 8) sample = -sample;
    }
    frame.writeInt16LE(sample, i * 2);
  }
  return frame;
}

function makeGeneratedFrame(frameIndex) {
  const device = selectedDevice(state.stream.sourceId);
  if (device?.generator === "pulse") {
    return makePulseFrame(frameIndex);
  }
  return makeSineFrame(frameIndex);
}

function packetForFrame(audio, flags = 0) {
  return packAudioPacket(
    {
      msgType: MSG_AUDIO,
      zoneId: state.stream.zoneId,
      streamId: state.stream.streamId,
      seq: state.stream.seq,
      timestamp: state.stream.timestamp,
      flags,
    },
    {
      encoding: ENC_PCM16_LE,
      channels: 1,
      sampleRateHz: SAMPLE_RATE_HZ,
      frameSamples: FRAME_SAMPLES,
      audio,
    },
    true
  );
}

function sendPcmFrame(audio) {
  if (!senderSocket || !state.stream.running) return;

  const processed = processAudioFrame(audio);
  const packet = packetForFrame(processed, state.stream.seq === 0 ? FLAG_START : 0);
  senderSocket.send(packet, state.stream.targetPort, state.stream.targetHost, (err) => {
    if (err) {
      state.stream.lastError = err.message;
      broadcast();
    }
  });

  state.stream.seq += 1;
  state.stream.timestamp += FRAME_SAMPLES;
  state.stream.packetsSent += 1;
  broadcastStreamProgress();
}

function broadcastStreamProgress() {
  const now = performance.now();
  if (now - lastStreamBroadcastAt < 1000) return;
  lastStreamBroadcastAt = now;
  broadcast();
}

function broadcastTelemetryProgress() {
  const now = performance.now();
  if (now - lastTelemetryBroadcastAt < 250) return;
  lastTelemetryBroadcastAt = now;
  broadcast();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function linearToDb(value) {
  if (!Number.isFinite(value) || value <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(value));
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function analyzePcm16(frame) {
  let peak = 0;
  let sumSquares = 0;
  const samples = frame.length / 2;
  for (let offset = 0; offset < frame.length; offset += 2) {
    const sample = frame.readInt16LE(offset);
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
  }
  const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
  return {
    rmsDb: linearToDb(rms / 32768),
    peakDb: linearToDb(peak / 32768),
    peak,
  };
}

function processAudioFrame(input) {
  const inputStats = analyzePcm16(input);
  const baselineAmbientDb = activeZoneBaselineDb();
  const now = performance.now();
  if (inputStats.rmsDb >= state.processing.gateThresholdDb) {
    gateHoldUntilMs = now + state.processing.holdMs;
  }

  const gateActive = gateHoldUntilMs > now;
  const holdRemainingMs = Math.max(0, Math.round(gateHoldUntilMs - now));
  const startingAnnouncement = gateActive && !processorWasActive;
  if (startingAnnouncement) {
    state.processing.frozenAmbientDb = roundDb(
      Number.isFinite(stableAmbientDb) ? stableAmbientDb : state.processing.ambientRmsDb
    );
  }

  let ambientDeltaDb = 0;
  let addedGainDb = 0;
  if (gateActive) {
    ambientDeltaDb = Math.max(0, state.processing.frozenAmbientDb - baselineAmbientDb);
    addedGainDb = calculatedAddedGainDb(state.processing.frozenAmbientDb, baselineAmbientDb);
  }

  const targetOutputGainDb = CALIBRATED_BASELINE_AUDIO_DB + state.processing.inputTrimDb + addedGainDb;
  smoothedOutputGainDb = slewDb(smoothedOutputGainDb, targetOutputGainDb, 1.5);
  let outputGainDb = smoothedOutputGainDb;
  let limiterReductionDb = 0;
  const projectedPeakDb = inputStats.peakDb + outputGainDb;
  if (projectedPeakDb > state.processing.limiterCeilingDb) {
    limiterReductionDb = projectedPeakDb - state.processing.limiterCeilingDb;
    outputGainDb -= limiterReductionDb;
  }

  const gain = dbToLinear(outputGainDb);
  const output = Buffer.alloc(input.length);
  let clipped = false;
  for (let offset = 0; offset < input.length; offset += 2) {
    const scaled = Math.round(input.readInt16LE(offset) * gain);
    if (scaled > 32767 || scaled < -32768) clipped = true;
    output.writeInt16LE(clamp(scaled, -32768, 32767), offset);
  }
  const outputStats = analyzePcm16(output);

  state.processing.sourceRmsDb = roundDb(inputStats.rmsDb);
  state.processing.sourcePeakDb = roundDb(inputStats.peakDb);
  state.processing.state = gateActive ? (holdRemainingMs > state.processing.holdMs - FRAME_INTERVAL_MS * 2 ? "Active" : "Holding") : "Idle";
  state.processing.holdRemainingMs = holdRemainingMs;
  state.processing.ambientDeltaDb = roundDb(ambientDeltaDb);
  state.processing.addedGainDb = roundDb(addedGainDb);
  state.processing.outputGainDb = roundDb(outputGainDb);
  state.processing.limiterReductionDb = roundDb(limiterReductionDb);
  state.processing.outputRmsDb = roundDb(outputStats.rmsDb);
  state.processing.outputPeakDb = roundDb(outputStats.peakDb);
  state.processing.clipping = clipped;
  processorWasActive = gateActive;
  return output;
}

function slewDb(current, target, maxStepDb) {
  if (!Number.isFinite(current)) return target;
  if (target > current) return Math.min(target, current + maxStepDb);
  return Math.max(target, current - maxStepDb);
}

function roundDb(db) {
  return Math.round(db * 10) / 10;
}

function activeZone() {
  return state.zones.find((zone) => zone.id === Number(state.stream.zoneId || 1)) || state.zones[0];
}

function activeZoneBaselineDb() {
  const zone = activeZone();
  const baseline = Number(zone?.baselineAmbientDb);
  return Number.isFinite(baseline) ? baseline : state.processing.baselineAmbientDb;
}

function calculatedAddedGainDb(ambientDb, baselineDb = activeZoneBaselineDb()) {
  if (!Number.isFinite(ambientDb)) return 0;
  const ambientDeltaDb = Math.max(0, ambientDb - baselineDb);
  const marginBiasDb = state.processing.targetMarginDb - REFERENCE_MARGIN_DB;
  return clamp(ambientDeltaDb + marginBiasDb, 0, state.processing.maxAddedGainDb);
}

function updatePreviewGain() {
  const previewAmbientDb = Number.isFinite(stableAmbientDb)
    ? stableAmbientDb
    : state.processing.ambientRmsDb;
  state.processing.baselineAmbientDb = activeZoneBaselineDb();
  state.processing.previewAddedGainDb = roundDb(calculatedAddedGainDb(previewAmbientDb));
}

function updateAmbientLevel(ambientDb) {
  if (!Number.isFinite(ambientDb)) return;
  state.processing.ambientRmsDb = roundDb(ambientDb);
  if (state.processing.state !== "Idle") {
    lastAmbientUpdateAt = 0;
    return;
  }

  const now = performance.now();
  if (!Number.isFinite(stableAmbientDb)) {
    stableAmbientDb = ambientDb;
  } else {
    const elapsedSeconds = lastAmbientUpdateAt
      ? Math.max(0.001, (now - lastAmbientUpdateAt) / 1000)
      : FRAME_INTERVAL_MS / 1000;
    const smoothing = 1 - Math.exp(-elapsedSeconds / AMBIENT_AVERAGE_SECONDS);
    stableAmbientDb += (ambientDb - stableAmbientDb) * smoothing;
  }
  lastAmbientUpdateAt = now;
  state.processing.stableAmbientDb = roundDb(stableAmbientDb);
  state.processing.frozenAmbientDb = state.processing.stableAmbientDb;
  updatePreviewGain();
}

function calibrateAmbientBaseline(zoneId = state.stream.zoneId) {
  const baseline = Number.isFinite(stableAmbientDb)
    ? stableAmbientDb
    : state.processing.ambientRmsDb;
  if (!Number.isFinite(baseline)) {
    throw new Error("No receiver ambient level is available yet.");
  }
  const zone = state.zones.find((item) => item.id === Number(zoneId));
  if (!zone) {
    throw new Error(`Unknown zone: ${zoneId}`);
  }
  zone.baselineAmbientDb = roundDb(baseline);
  state.processing.baselineAmbientDb = activeZoneBaselineDb();
  state.processing.ambientDeltaDb = 0;
  state.processing.addedGainDb = 0;
  updatePreviewGain();
}

function generatedDevice() {
  return state.audioDevices.find((device) => device.id === "test-tone");
}

function generatedDevices() {
  return state.audioDevices.filter((device) => device.kind === "generated");
}

function builtInDevices() {
  return state.audioDevices.filter((device) => device.kind === "generated" || device.kind === "file");
}

function selectedDevice(sourceId) {
  return state.audioDevices.find((device) => device.id === sourceId);
}

function preferredDevSource(devices) {
  return devices.find((device) => (
    device.ready &&
    device.backend === "coreaudio" &&
    /blackhole/i.test(device.name)
  )) || devices.find((device) => (
    device.ready &&
    /blackhole/i.test(device.name)
  ));
}

function ffmpegName() {
  return process.env.AUTO_ANNOUNCE_FFMPEG || "ffmpeg";
}

function compileCoreAudioHelperIfNeeded() {
  if (process.platform !== "darwin") return null;
  try {
    const sourceStat = fs.statSync(CORE_AUDIO_HELPER_SOURCE);
    const binStat = fs.existsSync(CORE_AUDIO_HELPER_BIN) ? fs.statSync(CORE_AUDIO_HELPER_BIN) : null;
    if (binStat && binStat.mtimeMs >= sourceStat.mtimeMs) return null;
  } catch (err) {
    return `CoreAudio helper source missing: ${err.message}`;
  }

  const result = spawnSync("swiftc", [
    "-module-cache-path",
    "/private/tmp/auto-announce-swift-cache",
    CORE_AUDIO_HELPER_SOURCE,
    "-o",
    CORE_AUDIO_HELPER_BIN,
    "-framework",
    "AudioToolbox",
    "-framework",
    "CoreAudio",
  ], {
    encoding: "utf8",
  });
  if (result.error) return `Could not run swiftc: ${result.error.message}`;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return `CoreAudio helper compile failed: ${detail || `exit ${result.status}`}`;
  }
  return null;
}

function coreAudioSourceId(uid) {
  return `coreaudio:${Buffer.from(uid, "utf8").toString("base64url")}`;
}

function scanCoreAudioDevices() {
  if (process.platform !== "darwin") return { devices: [], error: null };
  const compileError = compileCoreAudioHelperIfNeeded();
  if (compileError) return { devices: [], error: compileError };

  const result = spawnSync(CORE_AUDIO_HELPER_BIN, ["--list-json"], {
    encoding: "utf8",
  });
  if (result.error) return { devices: [], error: `CoreAudio scan failed: ${result.error.message}` };
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return { devices: [], error: `CoreAudio scan failed: ${detail || `exit ${result.status}`}` };
  }

  try {
    const rawDevices = JSON.parse(result.stdout || "[]");
    const devices = rawDevices.filter((device) => Number(device.inputChannels || 0) > 0).map((device) => ({
      id: coreAudioSourceId(device.uid),
      name: `CoreAudio: ${device.name}`,
      kind: "input",
      backend: "coreaudio",
      uid: device.uid,
      index: Number(device.index),
      inputChannels: Number(device.inputChannels || 0),
      ready: true,
      note: "Native macOS CoreAudio capture. Preferred for live input testing.",
    }));
    return { devices, error: null };
  } catch (err) {
    return { devices: [], error: `CoreAudio scan parse failed: ${err.message}` };
  }
}

function scanAudioDevices() {
  const scanId = audioDeviceScanId + 1;
  audioDeviceScanId = scanId;
  state.audioDeviceScan = {
    status: "scanning",
    error: null,
    scannedAt: state.audioDeviceScan.scannedAt,
  };
  broadcast();

  if (process.platform !== "darwin") {
    state.audioDevices = builtInDevices();
    state.audioDeviceScan = {
      status: "unsupported",
      error: "Automatic device listing is currently implemented for macOS FFmpeg avfoundation.",
      scannedAt: new Date().toISOString(),
    };
    broadcast();
    return;
  }

  const proc = spawn(ffmpegName(), ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let failed = false;
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  proc.on("error", (err) => {
    failed = true;
    if (scanId !== audioDeviceScanId) return;
    state.audioDevices = builtInDevices();
    state.audioDeviceScan = {
      status: "error",
      error: `FFmpeg not available: ${err.message}`,
      scannedAt: new Date().toISOString(),
    };
    broadcast();
  });
  proc.on("close", () => {
    if (failed || scanId !== audioDeviceScanId) return;
    const avfoundationDevices = parseAvfoundationAudioDevices(stderr);
    const coreAudioScan = scanCoreAudioDevices();
    const devices = [
      ...coreAudioScan.devices,
      ...avfoundationDevices,
    ];
    state.audioDevices = [
      ...builtInDevices(),
      ...devices,
    ];
    const preferred = preferredDevSource(state.audioDevices);
    if (!state.stream.running && preferred && state.stream.sourceId === "test-tone") {
      state.stream.sourceId = preferred.id;
      state.stream.sourceName = preferred.name;
    }
    state.audioDeviceScan = {
      status: "ready",
      error: devices.length
        ? coreAudioScan.error
        : coreAudioScan.error || "No macOS audio input devices were found.",
      scannedAt: new Date().toISOString(),
    };
    broadcast();
  });
}

function parseAvfoundationAudioDevices(output) {
  const devices = [];
  let inAudioSection = false;

  for (const line of output.split(/\r?\n/)) {
    if (line.includes("AVFoundation audio devices:")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("AVFoundation video devices:")) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;

    const match = line.match(/\[(\d+)\]\s+(.+)$/);
    if (!match) continue;

    const index = Number(match[1]);
    const name = match[2].trim();
    devices.push({
      id: `avfoundation:${index}`,
      name,
      kind: "input",
      backend: "avfoundation",
      index,
      ready: true,
      note: name.toLowerCase().includes("blackhole") || name.toLowerCase().includes("loopback")
        ? "Loopback-style source. Good candidate for system/app audio."
        : "Mac audio input device exposed through FFmpeg.",
    });
  }

  return devices;
}

function startPcmWorker(device) {
  captureBuffer = Buffer.alloc(0);
  captureQueue = [];
  captureLastFrame = null;
  nextCaptureFrameAt = 0;

  const worker = pcmWorkerForSource(device);
  const proc = spawn(worker.command, worker.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureProcess = proc;

  proc.stdout.on("data", (chunk) => {
    captureBuffer = Buffer.concat([captureBuffer, chunk]);
    const frameBytes = FRAME_SAMPLES * 2;
    while (captureBuffer.length >= frameBytes) {
      const frame = Buffer.from(captureBuffer.subarray(0, frameBytes));
      captureBuffer = captureBuffer.subarray(frameBytes);
      queueCaptureFrame(frame);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      state.stream.lastError = text.split(/\r?\n/).slice(-1)[0];
      broadcast();
    }
  });

  proc.on("error", (err) => {
    state.stream.lastError = `${worker.label} source failed: ${err.message}`;
    stopStream();
  });

  proc.on("close", (code, signal) => {
    if (state.stream.running && captureProcess === proc) {
      state.stream.lastError = `Audio source stopped: code=${code ?? "-"} signal=${signal ?? "-"}`;
      stopStream();
    }
  });
}

function pcmWorkerForSource(device) {
  if (device?.backend === "coreaudio") {
    const compileError = compileCoreAudioHelperIfNeeded();
    if (compileError) throw new Error(compileError);
    return {
      command: CORE_AUDIO_HELPER_BIN,
      args: ["--device-uid", device.uid],
      label: "CoreAudio",
    };
  }
  return {
    command: ffmpegName(),
    args: ffmpegArgsForSource(device),
    label: "FFmpeg",
  };
}

function ffmpegArgsForSource(device) {
  if (device?.kind === "file") {
    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-stream_loop",
      "-1",
      "-re",
      "-i",
      device.filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE_HZ),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ];
  }

  if (!device || device.backend !== "avfoundation") {
    throw new Error("Selected audio source is not a supported capture device.");
  }

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-f",
    "avfoundation",
    "-i",
    `:${device.index}`,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE_HZ),
    "-af",
    `aresample=${SAMPLE_RATE_HZ}:async=1000:first_pts=0`,
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];
}

function stopCapture() {
  if (!captureProcess) return;
  const proc = captureProcess;
  captureProcess = null;
  captureBuffer = Buffer.alloc(0);
  captureQueue = [];
  captureLastFrame = null;
  nextCaptureFrameAt = 0;
  state.stream.captureQueueFrames = 0;
  proc.kill("SIGTERM");
}

function queueCaptureFrame(frame) {
  state.stream.captureFramesReceived += 1;
  captureQueue.push(frame);
  while (captureQueue.length > MAX_CAPTURE_QUEUE_FRAMES) {
    captureQueue.shift();
    state.stream.captureDrops += 1;
  }
  state.stream.captureQueueFrames = captureQueue.length;
  if (
    !senderTimer &&
    state.stream.running &&
    state.stream.sourceId !== "test-tone" &&
    captureQueue.length >= START_CAPTURE_QUEUE_FRAMES
  ) {
    startCaptureSender();
  }
}

function applyProcessingConfig(config = {}) {
  state.processing.inputTrimDb = clamp(Number(config.inputTrimDb ?? state.processing.inputTrimDb ?? 0), -10, 10);
  state.processing.gateThresholdDb = clamp(Number(config.gateThresholdDb ?? state.processing.gateThresholdDb ?? -50), MIN_DB, 0);
  state.processing.holdMs = clamp(Number(config.holdMs ?? state.processing.holdMs ?? 1000), 0, 10000);
  state.processing.baselineAmbientDb = clamp(Number(config.baselineAmbientDb ?? state.processing.baselineAmbientDb ?? -60), MIN_DB, 0);
  state.processing.targetMarginDb = clamp(Number(config.targetMarginDb ?? state.processing.targetMarginDb ?? REFERENCE_MARGIN_DB), 0, 36);
  state.processing.maxAddedGainDb = clamp(Number(config.maxAddedGainDb ?? state.processing.maxAddedGainDb ?? 36), 0, 60);
  state.processing.limiterCeilingDb = clamp(Number(config.limiterCeilingDb ?? state.processing.limiterCeilingDb ?? -1), -24, 0);
  updatePreviewGain();
}

function applyInputConfig(config = {}) {
  const setupType = String(config.setupType ?? state.input.setupType ?? "announcement-only");
  state.input.setupType = ["announcement-only", "mixed-feed", "program-announcement"].includes(setupType)
    ? setupType
    : "announcement-only";
  state.input.programSourceId = String(config.programSourceId ?? state.input.programSourceId ?? "");
  const programDevice = selectedDevice(state.input.programSourceId);
  state.input.programSourceName = programDevice?.name || "";
  state.input.programLevelDb = clamp(Number(config.programLevelDb ?? state.input.programLevelDb ?? 0), -60, 12);
  state.input.programDuckDb = clamp(Number(config.programDuckDb ?? state.input.programDuckDb ?? 12), 0, 60);
}

function applyZoneConfig(config = {}) {
  const zoneId = Number(config.zoneId);
  const zone = state.zones.find((item) => item.id === zoneId);
  if (!zone) {
    throw new Error(`Unknown zone: ${config.zoneId}`);
  }
  if (config.name !== undefined) {
    zone.name = String(config.name || `Zone ${zone.id}`).slice(0, 48);
  }
  if (config.enabled !== undefined) {
    zone.enabled = Boolean(config.enabled);
  }
  if (config.receiverHost !== undefined) {
    zone.receiverHost = String(config.receiverHost || "").slice(0, 128);
  }
  if (config.receiverId !== undefined) {
    zone.receiverId = String(config.receiverId || "").slice(0, 128);
  }
  if (config.baselineAmbientDb !== undefined) {
    zone.baselineAmbientDb = clamp(Number(config.baselineAmbientDb), MIN_DB, 0);
    if (zone.id === Number(state.stream.zoneId || 1)) {
      state.processing.baselineAmbientDb = zone.baselineAmbientDb;
    }
    updatePreviewGain();
  }
  if (config.delayMs !== undefined) {
    zone.delayMs = clamp(Number(config.delayMs), 0, 500);
  }
  if (config.delayOffsetMs !== undefined) {
    zone.delayOffsetMs = clamp(Number(config.delayOffsetMs), -100, 100);
  }
  if (config.outputTrimDb !== undefined) {
    zone.outputTrimDb = clamp(Number(config.outputTrimDb), -60, 0);
  }
}

function startStream(config = {}) {
  if (state.stream.running) stopStream();

  state.stream.targetHost = String(config.targetHost || state.stream.targetHost || DEFAULT_TARGET_HOST);
  state.stream.targetPort = Number(config.targetPort || state.stream.targetPort || 41771);
  state.stream.zoneId = Number(config.zoneId || state.stream.zoneId || 1);
  state.stream.streamId = Number(config.streamId || state.stream.streamId || 1);
  state.stream.frequencyHz = Number(config.frequencyHz || state.stream.frequencyHz || 880);
  state.stream.gain = Math.max(0, Math.min(1, Number(config.gain ?? state.stream.gain ?? 0.2)));
  applyProcessingConfig(config);
  applyInputConfig(config);
  const sourceId = String(config.sourceId || state.stream.sourceId || "test-tone");
  const device = selectedDevice(sourceId);
  if (!device || !device.ready) {
    throw new Error(`Audio source is not available: ${sourceId}`);
  }
  state.stream.sourceId = sourceId;
  state.stream.sourceName = device.name;
  state.stream.seq = 0;
  state.stream.timestamp = 0;
  state.stream.packetsSent = 0;
  state.stream.captureFramesReceived = 0;
  state.stream.captureQueueFrames = 0;
  state.stream.captureDrops = 0;
  state.stream.captureUnderflows = 0;
  state.stream.captureRepeats = 0;
  state.stream.lastError = null;
  state.stream.startedAt = new Date().toISOString();
  state.stream.running = true;
  lastStreamBroadcastAt = 0;
  lastTelemetryBroadcastAt = 0;
  gateHoldUntilMs = 0;
  smoothedOutputGainDb = CALIBRATED_BASELINE_AUDIO_DB + state.processing.inputTrimDb;
  processorWasActive = false;
  resetProcessingMeters();

  senderSocket = dgram.createSocket("udp4");
  if (device.kind === "generated") {
    startGeneratedSender();
  } else {
    startPcmWorker(device);
  }
  broadcast();
}

function stopStream() {
  if (senderTimer) clearTimeout(senderTimer);
  senderTimer = null;
  nextGeneratedFrameAt = 0;
  nextCaptureFrameAt = 0;
  stopCapture();
  if (senderSocket) {
    try {
      senderSocket.close();
    } catch (err) {
      if (err.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") {
        throw err;
      }
    }
  }
  senderSocket = null;
  state.stream.running = false;
  state.processing.state = "Idle";
  state.processing.holdRemainingMs = 0;
  smoothedOutputGainDb = CALIBRATED_BASELINE_AUDIO_DB + state.processing.inputTrimDb;
  processorWasActive = false;
  broadcast();
}

function resetProcessingMeters() {
  state.processing.state = "Idle";
  state.processing.holdRemainingMs = 0;
  state.processing.sourceRmsDb = MIN_DB;
  state.processing.sourcePeakDb = MIN_DB;
  state.processing.ambientDeltaDb = 0;
  state.processing.addedGainDb = 0;
  state.processing.outputGainDb = 0;
  state.processing.limiterReductionDb = 0;
  state.processing.outputRmsDb = MIN_DB;
  state.processing.outputPeakDb = MIN_DB;
  state.processing.clipping = false;
}

function closeTelemetryListener() {
  if (!telemetrySocket) return;
  const socket = telemetrySocket;
  telemetrySocket = null;
  try {
    socket.close();
  } catch (err) {
    if (err.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") {
      throw err;
    }
  }
}

function startGeneratedSender() {
  nextGeneratedFrameAt = performance.now();
  runGeneratedSender();
}

function runGeneratedSender() {
  const device = selectedDevice(state.stream.sourceId);
  if (!senderSocket || !state.stream.running || device?.kind !== "generated") return;

  const now = performance.now();
  let framesDue = 0;
  while (nextGeneratedFrameAt <= now && framesDue < 5) {
    sendGeneratedFrame();
    nextGeneratedFrameAt += FRAME_INTERVAL_MS;
    framesDue += 1;
  }

  if (framesDue === 5 && nextGeneratedFrameAt < now - FRAME_INTERVAL_MS) {
    nextGeneratedFrameAt = now + FRAME_INTERVAL_MS;
  }

  const delayMs = Math.max(0, nextGeneratedFrameAt - performance.now());
  senderTimer = setTimeout(runGeneratedSender, delayMs);
}

function startCaptureSender() {
  nextCaptureFrameAt = performance.now();
  runCaptureSender();
}

function runCaptureSender() {
  const device = selectedDevice(state.stream.sourceId);
  if (!senderSocket || !state.stream.running || device?.kind === "generated") return;

  const now = performance.now();
  let framesDue = 0;
  while (nextCaptureFrameAt <= now && framesDue < 5) {
    let frame = captureQueue.shift();
    if (frame) {
      captureLastFrame = frame;
    } else {
      state.stream.captureUnderflows += 1;
      if (captureLastFrame) {
        frame = captureLastFrame;
        state.stream.captureRepeats += 1;
      } else {
        frame = Buffer.alloc(FRAME_SAMPLES * 2);
      }
    }
    sendPcmFrame(frame);
    state.stream.captureQueueFrames = captureQueue.length;
    nextCaptureFrameAt += captureFrameIntervalMs();
    framesDue += 1;
  }

  if (framesDue === 5 && nextCaptureFrameAt < now - FRAME_INTERVAL_MS) {
    nextCaptureFrameAt = now + FRAME_INTERVAL_MS;
  }

  const delayMs = Math.max(0, nextCaptureFrameAt - performance.now());
  senderTimer = setTimeout(runCaptureSender, delayMs);
}

function captureFrameIntervalMs() {
  const queueError = captureQueue.length - TARGET_CAPTURE_QUEUE_FRAMES;
  if (queueError <= 0) return FRAME_INTERVAL_MS;

  // Drain a high live-capture queue smoothly instead of waiting until it
  // overflows and dropping an audible frame.
  const correctionMs = Math.min(0.75, queueError * 0.08);
  return FRAME_INTERVAL_MS - correctionMs;
}

function sendGeneratedFrame() {
  if (!senderSocket || !state.stream.running) return;

  const frameIndex = state.stream.seq;
  sendPcmFrame(makeGeneratedFrame(frameIndex));
}

function startTelemetryListener() {
  const socket = dgram.createSocket("udp4");
  telemetrySocket = socket;
  socket.on("error", (err) => {
    state.telemetry.errors += 1;
    state.telemetry.last = { error: err.message };
    console.error(`Telemetry listener error: ${err.message}`);
    broadcast();
  });
  socket.on("message", (raw, rinfo) => {
    try {
      const decoded = parsePacket(raw);
      if (decoded.header.msgType !== MSG_TELEMETRY) return;
      state.telemetry.packetsReceived += 1;
      state.telemetry.lastPacketAt = new Date().toISOString();
      state.telemetry.lastFrom = `${rinfo.address}:${rinfo.port}`;
      state.telemetry.last = {
        header: decoded.header,
        payload: decoded.payload,
      };
      updateAmbientLevel(linearToDb((decoded.payload.ambientRms || 0) / 32768));
      broadcastTelemetryProgress();
    } catch (err) {
      state.telemetry.errors += 1;
      state.telemetry.last = { error: err.message };
      broadcast();
    }
  });
  socket.bind(TELEMETRY_PORT, TELEMETRY_HOST, () => {
    console.log(`Telemetry listener on udp://${TELEMETRY_HOST}:${TELEMETRY_PORT}`);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/status") {
    return json(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/audio-devices") {
    return json(res, 200, { devices: state.audioDevices });
  }

  if (req.method === "POST" && pathname === "/api/audio-devices/refresh") {
    scanAudioDevices();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/audio-file") {
    const fileName = decodeURIComponent(req.headers["x-file-name"] || "audio-file");
    const data = await readRawRequestBody(req);
    if (!data.length) {
      return json(res, 400, { error: "empty audio file upload" });
    }
    const device = addUploadedAudioFile(fileName, data);
    broadcast();
    return json(res, 200, { ...publicState(), uploadedSourceId: device.id });
  }

  if (req.method === "POST" && pathname === "/api/stream/start") {
    const body = await readRequestBody(req);
    startStream(body);
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/stream/stop") {
    stopStream();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/processing/config") {
    const body = await readRequestBody(req);
    applyProcessingConfig(body);
    broadcast();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/input/config") {
    const body = await readRequestBody(req);
    applyInputConfig(body);
    broadcast();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/zones/config") {
    const body = await readRequestBody(req);
    applyZoneConfig(body);
    broadcast();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/zones/calibrate-ambient") {
    const body = await readRequestBody(req);
    calibrateAmbientBaseline(body.zoneId);
    broadcast();
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/processing/calibrate-ambient") {
    calibrateAmbientBaseline(state.stream.zoneId);
    broadcast();
    return json(res, 200, publicState());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${HTTP_PORT}`}`);
    if (parsed.pathname.startsWith("/api/")) {
      await handleApi(req, res, parsed.pathname);
      return;
    }

    const file = publicFilePath(parsed.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      json(res, 404, { error: "not found" });
      return;
    }

    const data = fs.readFileSync(file);
    res.writeHead(200, { "content-type": contentType(file), "content-length": data.length });
    res.end(data);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

startTelemetryListener();
scanAudioDevices();
server.listen(HTTP_PORT, HOST, () => {
  console.log(`Auto-Announce host app on http://${HOST}:${HTTP_PORT}`);
  console.log("Open the browser UI, then run the receiver simulator on this or another machine.");
});

process.on("SIGINT", () => {
  stopStream();
  closeTelemetryListener();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
