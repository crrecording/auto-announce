#!/usr/bin/env node
"use strict";

const dgram = require("node:dgram");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
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
const TELEMETRY_HOST = process.env.AUTO_ANNOUNCE_TELEMETRY_HOST || "127.0.0.1";
const TELEMETRY_PORT = Number(process.env.AUTO_ANNOUNCE_TELEMETRY_PORT || 41772);
const SAMPLE_RATE_HZ = 48000;
const FRAME_SAMPLES = 480;
const FRAME_INTERVAL_MS = 10;

const state = {
  stream: {
    running: false,
    targetHost: "127.0.0.1",
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
  audioDevices: [
    {
      id: "test-tone",
      name: "Test tone generator",
      kind: "generated",
      ready: true,
      note: "Built-in generated source for network checks.",
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
let audioDeviceScanId = 0;

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
    stream: state.stream,
    telemetry: state.telemetry,
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

  const packet = packetForFrame(audio, state.stream.seq === 0 ? FLAG_START : 0);
  senderSocket.send(packet, state.stream.targetPort, state.stream.targetHost, (err) => {
    if (err) {
      state.stream.lastError = err.message;
      broadcast();
    }
  });

  state.stream.seq += 1;
  state.stream.timestamp += FRAME_SAMPLES;
  state.stream.packetsSent += 1;
  if (state.stream.packetsSent % 10 === 0) broadcast();
}

function generatedDevice() {
  return state.audioDevices.find((device) => device.id === "test-tone");
}

function selectedDevice(sourceId) {
  return state.audioDevices.find((device) => device.id === sourceId);
}

function ffmpegName() {
  return process.env.AUTO_ANNOUNCE_FFMPEG || "ffmpeg";
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
    state.audioDevices = [
      generatedDevice() || {
        id: "test-tone",
        name: "Test tone generator",
        kind: "generated",
        ready: true,
        note: "Built-in generated source for network checks.",
      },
    ];
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
    state.audioDevices = [
      generatedDevice() || {
        id: "test-tone",
        name: "Test tone generator",
        kind: "generated",
        ready: true,
        note: "Built-in generated source for network checks.",
      },
    ];
    state.audioDeviceScan = {
      status: "error",
      error: `FFmpeg not available: ${err.message}`,
      scannedAt: new Date().toISOString(),
    };
    broadcast();
  });
  proc.on("close", () => {
    if (failed || scanId !== audioDeviceScanId) return;
    const devices = parseAvfoundationAudioDevices(stderr);
    state.audioDevices = [
      {
        id: "test-tone",
        name: "Test tone generator",
        kind: "generated",
        ready: true,
        note: "Built-in generated source for network checks.",
      },
      ...devices,
    ];
    state.audioDeviceScan = {
      status: "ready",
      error: devices.length ? null : "No FFmpeg audio input devices were found.",
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

function startCapture(device) {
  if (!device || device.backend !== "avfoundation") {
    throw new Error("Selected audio source is not a supported capture device.");
  }

  captureBuffer = Buffer.alloc(0);
  const args = [
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
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];

  const proc = spawn(ffmpegName(), args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureProcess = proc;

  proc.stdout.on("data", (chunk) => {
    captureBuffer = Buffer.concat([captureBuffer, chunk]);
    const frameBytes = FRAME_SAMPLES * 2;
    while (captureBuffer.length >= frameBytes) {
      const frame = captureBuffer.subarray(0, frameBytes);
      captureBuffer = captureBuffer.subarray(frameBytes);
      sendPcmFrame(frame);
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
    state.stream.lastError = `FFmpeg capture failed: ${err.message}`;
    stopStream();
  });

  proc.on("close", (code, signal) => {
    if (state.stream.running && captureProcess === proc) {
      state.stream.lastError = `Audio capture stopped: code=${code ?? "-"} signal=${signal ?? "-"}`;
      stopStream();
    }
  });
}

function stopCapture() {
  if (!captureProcess) return;
  const proc = captureProcess;
  captureProcess = null;
  captureBuffer = Buffer.alloc(0);
  proc.kill("SIGTERM");
}

function startStream(config = {}) {
  if (state.stream.running) stopStream();

  state.stream.targetHost = String(config.targetHost || state.stream.targetHost || "127.0.0.1");
  state.stream.targetPort = Number(config.targetPort || state.stream.targetPort || 41771);
  state.stream.zoneId = Number(config.zoneId || state.stream.zoneId || 1);
  state.stream.streamId = Number(config.streamId || state.stream.streamId || 1);
  state.stream.frequencyHz = Number(config.frequencyHz || state.stream.frequencyHz || 880);
  state.stream.gain = Math.max(0, Math.min(1, Number(config.gain ?? state.stream.gain ?? 0.2)));
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
  state.stream.lastError = null;
  state.stream.startedAt = new Date().toISOString();
  state.stream.running = true;

  senderSocket = dgram.createSocket("udp4");
  if (device.kind === "generated") {
    senderTimer = setInterval(sendFrame, FRAME_INTERVAL_MS);
    sendFrame();
  } else {
    startCapture(device);
  }
  broadcast();
}

function stopStream() {
  if (senderTimer) clearInterval(senderTimer);
  senderTimer = null;
  stopCapture();
  if (senderSocket) senderSocket.close();
  senderSocket = null;
  state.stream.running = false;
  broadcast();
}

function sendFrame() {
  if (!senderSocket || !state.stream.running) return;

  const frameIndex = state.stream.seq;
  sendPcmFrame(makeSineFrame(frameIndex));
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
      broadcast();
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

  if (req.method === "POST" && pathname === "/api/stream/start") {
    const body = await readRequestBody(req);
    startStream(body);
    return json(res, 200, publicState());
  }

  if (req.method === "POST" && pathname === "/api/stream/stop") {
    stopStream();
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
  if (telemetrySocket) {
    telemetrySocket.close();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
