#!/usr/bin/env node
"use strict";

const dgram = require("node:dgram");

const {
  MSG_AUDIO,
  MSG_TELEMETRY,
  STATUS_STREAM_PRESENT,
  packTelemetryPacket,
  parsePacket,
} = require("./src/protocol");

const args = parseArgs(process.argv.slice(2));
const listenHost = args.host || "0.0.0.0";
const listenPort = Number(args.port || 41771);
const telemetryPort = Number(args.telemetryPort || 41772);
const configuredTelemetryHost = args.telemetryHost || null;

const stats = {
  packets: 0,
  bytes: 0,
  firstSeq: null,
  lastSeq: null,
  expectedSeq: null,
  firstTimestamp: null,
  lastTimestamp: null,
  lost: 0,
  duplicateOrLate: 0,
  parseErrors: 0,
  lastFrom: null,
  startedAt: Date.now(),
};

const socket = dgram.createSocket("udp4");

socket.on("message", (raw, rinfo) => {
  try {
    const decoded = parsePacket(raw);
    if (decoded.header.msgType !== MSG_AUDIO) return;

    const header = decoded.header;
    const payload = decoded.payload;
    const telemetryHost = configuredTelemetryHost || rinfo.address;

    if (stats.expectedSeq === null) {
      stats.expectedSeq = header.seq;
      stats.firstSeq = header.seq;
      stats.firstTimestamp = header.timestamp;
    }

    if (header.seq < stats.expectedSeq) {
      stats.duplicateOrLate += 1;
      return;
    }

    if (header.seq > stats.expectedSeq) {
      stats.lost += header.seq - stats.expectedSeq;
    }

    stats.expectedSeq = header.seq + 1;
    stats.packets += 1;
    stats.bytes += payload.audio.length;
    stats.lastSeq = header.seq;
    stats.lastTimestamp = header.timestamp;
    stats.lastFrom = `${rinfo.address}:${rinfo.port}`;

    const telemetry = {
      status: STATUS_STREAM_PRESENT,
      rssi: 0,
      ambientRms: estimateRms(payload.audio),
      bufferMs: 60,
      jitterMs: 0,
      packetLossPpm: estimateLossPpm(),
      lastSeq: header.seq,
      streamId: header.streamId,
    };
    const response = packTelemetryPacket(
      {
        msgType: MSG_TELEMETRY,
        zoneId: header.zoneId,
        streamId: header.streamId,
        seq: header.seq,
        timestamp: header.timestamp,
        flags: 0,
      },
      telemetry,
      true
    );
    socket.send(response, telemetryPort, telemetryHost);
  } catch (err) {
    stats.parseErrors += 1;
    if (stats.parseErrors <= 5) {
      console.error(`Parse error: ${err.message}`);
    }
  }
});

socket.bind(listenPort, listenHost, () => {
  console.log(`Auto-Announce receiver simulator listening on udp://${listenHost}:${listenPort}`);
  console.log(`Telemetry target: ${configuredTelemetryHost || "audio sender address"}:${telemetryPort}`);
});

setInterval(printStats, 1000);

function printStats() {
  const elapsed = (Date.now() - stats.startedAt) / 1000;
  const pps = elapsed > 0 ? (stats.packets / elapsed).toFixed(1) : "0.0";
  console.log(
    `packets=${stats.packets} pps=${pps} seq=${stats.firstSeq}..${stats.lastSeq} ` +
    `ts=${stats.firstTimestamp}..${stats.lastTimestamp} lost=${stats.lost} ` +
    `late=${stats.duplicateOrLate} errors=${stats.parseErrors} from=${stats.lastFrom || "-"}`
  );
}

function estimateLossPpm() {
  const total = stats.packets + stats.lost;
  if (total <= 0) return 0;
  return Math.min(65535, Math.round((stats.lost / total) * 1_000_000));
}

function estimateRms(audio) {
  if (!audio.length) return 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(audio.length / 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = audio.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.min(65535, Math.round(Math.sqrt(sumSquares / sampleCount)));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") out.host = argv[++i];
    else if (arg === "--port") out.port = argv[++i];
    else if (arg === "--telemetry-host") out.telemetryHost = argv[++i];
    else if (arg === "--telemetry-port") out.telemetryPort = argv[++i];
    else if (arg === "--help") {
      console.log("Usage: node receiver.js [--host 0.0.0.0] [--port 41771] [--telemetry-host HOST] [--telemetry-port 41772]");
      process.exit(0);
    }
  }
  return out;
}

process.on("SIGINT", () => {
  printStats();
  socket.close(() => process.exit(0));
});
