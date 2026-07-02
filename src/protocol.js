"use strict";

const MAGIC = 0xaa55;
const VERSION = 1;
const HEADER_SIZE = 22;

const MSG_AUDIO = 0x01;
const MSG_TELEMETRY = 0x02;
const MSG_CONTROL = 0x03;

const FLAG_START = 0x01;
const FLAG_END = 0x02;
const FLAG_RESYNC = 0x04;

const STATUS_STREAM_PRESENT = 0x01;
const STATUS_TIMEOUT_MUTE = 0x02;
const STATUS_CLIPPING = 0x04;
const STATUS_CALIBRATION = 0x08;
const STATUS_LOW_BATTERY = 0x10;
const STATUS_LOW_TEMP = 0x20;

const ENC_PCM16_LE = 0x01;

function crc16Ccitt(data, poly = 0x1021, init = 0xffff) {
  let crc = init;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function writeHeader(packet, payload, includeCrc) {
  const out = Buffer.alloc(HEADER_SIZE + payload.length);
  let offset = 0;
  out.writeUInt16LE(MAGIC, offset); offset += 2;
  out.writeUInt8(VERSION, offset); offset += 1;
  out.writeUInt8(packet.msgType, offset); offset += 1;
  out.writeUInt16LE(packet.zoneId & 0xffff, offset); offset += 2;
  out.writeUInt16LE(packet.streamId & 0xffff, offset); offset += 2;
  out.writeUInt32LE(packet.seq >>> 0, offset); offset += 4;
  out.writeUInt32LE(packet.timestamp >>> 0, offset); offset += 4;
  out.writeUInt8(packet.flags & 0xff, offset); offset += 1;
  out.writeUInt8(0, offset); offset += 1;
  out.writeUInt16LE(includeCrc ? crc16Ccitt(payload) : 0, offset); offset += 2;
  out.writeUInt16LE(payload.length & 0xffff, offset); offset += 2;
  payload.copy(out, offset);
  return out;
}

function packAudioPayload(payload) {
  const audio = Buffer.from(payload.audio);
  const out = Buffer.alloc(8 + audio.length);
  let offset = 0;
  out.writeUInt8(payload.encoding ?? ENC_PCM16_LE, offset); offset += 1;
  out.writeUInt8(payload.channels ?? 1, offset); offset += 1;
  out.writeUInt16LE(payload.sampleRateHz ?? 48000, offset); offset += 2;
  out.writeUInt16LE(payload.frameSamples ?? 480, offset); offset += 2;
  out.writeUInt16LE(audio.length, offset); offset += 2;
  audio.copy(out, offset);
  return out;
}

function packTelemetryPayload(payload) {
  const debugLen = payload.debug ? 34 : 0;
  const out = Buffer.alloc(18 + debugLen);
  let offset = 0;
  out.writeUInt8(payload.status & 0xff, offset); offset += 1;
  out.writeUInt8((payload.rssi ?? 0) & 0xff, offset); offset += 1;
  out.writeUInt16LE((payload.ambientRms ?? 0) & 0xffff, offset); offset += 2;
  out.writeUInt16LE((payload.bufferMs ?? 0) & 0xffff, offset); offset += 2;
  out.writeUInt16LE((payload.jitterMs ?? 0) & 0xffff, offset); offset += 2;
  out.writeUInt16LE((payload.packetLossPpm ?? 0) & 0xffff, offset); offset += 2;
  out.writeUInt32LE((payload.lastSeq ?? 0) >>> 0, offset); offset += 4;
  out.writeUInt16LE((payload.streamId ?? 0) & 0xffff, offset); offset += 2;
  out.writeUInt16LE(0, offset); offset += 2;

  if (payload.debug) {
    const debug = payload.debug;
    out.writeUInt16LE(0x4441, offset); offset += 2;
    out.writeUInt8(1, offset); offset += 1;
    out.writeUInt8((debug.flags ?? 0) & 0xff, offset); offset += 1;
    out.writeUInt16LE((debug.receiverPpsX10 ?? 0) & 0xffff, offset); offset += 2;
    out.writeUInt32LE((debug.totalPackets ?? 0) >>> 0, offset); offset += 4;
    out.writeUInt32LE((debug.lostPackets ?? 0) >>> 0, offset); offset += 4;
    out.writeUInt32LE((debug.latePackets ?? 0) >>> 0, offset); offset += 4;
    out.writeUInt16LE((debug.playbackBufferFrames ?? 0) & 0xffff, offset); offset += 2;
    out.writeUInt32LE((debug.playbackUnderflows ?? 0) >>> 0, offset); offset += 4;
    out.writeUInt32LE((debug.playbackDrops ?? 0) >>> 0, offset); offset += 4;
    out.writeUInt16LE((debug.playbackBrokenPipes ?? 0) & 0xffff, offset); offset += 2;
    out.writeInt16LE(clampInt16(debug.playbackExitCode ?? -1), offset); offset += 2;
    out.writeUInt16LE((debug.parseErrors ?? 0) & 0xffff, offset);
  }
  return out;
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Number(value) || 0));
}

function packControlPayload(payload) {
  const out = Buffer.alloc(8);
  out.writeUInt8(payload.op & 0xff, 0);
  out.writeUInt16LE(payload.zoneId & 0xffff, 1);
  out.writeUInt8(0, 3);
  out.writeUInt32LE(payload.argU32 >>> 0, 4);
  return out;
}

function packPacket(packet, includeCrc = true) {
  return writeHeader(packet, Buffer.from(packet.payload ?? []), includeCrc);
}

function packAudioPacket(packet, audioPayload, includeCrc = true) {
  return writeHeader(packet, packAudioPayload(audioPayload), includeCrc);
}

function packTelemetryPacket(packet, telemetryPayload, includeCrc = true) {
  return writeHeader(packet, packTelemetryPayload(telemetryPayload), includeCrc);
}

function packControlPacket(packet, controlPayload, includeCrc = true) {
  return writeHeader(packet, packControlPayload(controlPayload), includeCrc);
}

function parsePacket(raw) {
  const buf = Buffer.from(raw);
  if (buf.length < HEADER_SIZE) {
    throw new Error("packet too short for header");
  }

  let offset = 0;
  const magic = buf.readUInt16LE(offset); offset += 2;
  if (magic !== MAGIC) {
    throw new Error(`invalid magic: 0x${magic.toString(16)}`);
  }
  const version = buf.readUInt8(offset); offset += 1;
  if (version !== VERSION) {
    throw new Error(`unexpected version: ${version}`);
  }
  const msgType = buf.readUInt8(offset); offset += 1;
  const zoneId = buf.readUInt16LE(offset); offset += 2;
  const streamId = buf.readUInt16LE(offset); offset += 2;
  const seq = buf.readUInt32LE(offset); offset += 4;
  const timestamp = buf.readUInt32LE(offset); offset += 4;
  const flags = buf.readUInt8(offset); offset += 1;
  offset += 1;
  const crc16 = buf.readUInt16LE(offset); offset += 2;
  const payloadLen = buf.readUInt16LE(offset); offset += 2;

  if (HEADER_SIZE + payloadLen !== buf.length) {
    throw new Error("payload_len mismatch with datagram length");
  }

  const payload = buf.subarray(HEADER_SIZE);
  if (crc16 && crc16Ccitt(payload) !== crc16) {
    throw new Error("crc16 mismatch");
  }

  const header = { magic, version, msgType, zoneId, streamId, seq, timestamp, flags, crc16, payloadLen };
  return { header, payload: parsePayload(msgType, payload) };
}

function parsePayload(msgType, payload) {
  if (msgType === MSG_AUDIO) {
    if (payload.length < 8) throw new Error("audio payload too short");
    const audioBytes = payload.readUInt16LE(6);
    if (payload.length !== 8 + audioBytes) throw new Error("audio payload length mismatch");
    return {
      encoding: payload.readUInt8(0),
      channels: payload.readUInt8(1),
      sampleRateHz: payload.readUInt16LE(2),
      frameSamples: payload.readUInt16LE(4),
      audio: payload.subarray(8),
    };
  }

  if (msgType === MSG_TELEMETRY) {
    if (payload.length < 18) throw new Error("telemetry payload too short");
    const out = {
      status: payload.readUInt8(0),
      rssi: payload.readUInt8(1),
      ambientRms: payload.readUInt16LE(2),
      bufferMs: payload.readUInt16LE(4),
      jitterMs: payload.readUInt16LE(6),
      packetLossPpm: payload.readUInt16LE(8),
      lastSeq: payload.readUInt32LE(10),
      streamId: payload.readUInt16LE(14),
    };
    if (payload.length >= 52 && payload.readUInt16LE(18) === 0x4441) {
      out.debug = {
        version: payload.readUInt8(20),
        flags: payload.readUInt8(21),
        receiverPpsX10: payload.readUInt16LE(22),
        receiverPps: payload.readUInt16LE(22) / 10,
        totalPackets: payload.readUInt32LE(24),
        lostPackets: payload.readUInt32LE(28),
        latePackets: payload.readUInt32LE(32),
        playbackBufferFrames: payload.readUInt16LE(36),
        playbackUnderflows: payload.readUInt32LE(38),
        playbackDrops: payload.readUInt32LE(42),
        playbackBrokenPipes: payload.readUInt16LE(46),
        playbackExitCode: payload.readInt16LE(48),
        parseErrors: payload.readUInt16LE(50),
      };
    }
    return out;
  }

  if (msgType === MSG_CONTROL) {
    if (payload.length < 8) throw new Error("control payload too short");
    return {
      op: payload.readUInt8(0),
      zoneId: payload.readUInt16LE(1),
      argU32: payload.readUInt32LE(4),
    };
  }

  return payload;
}

module.exports = {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  MSG_AUDIO,
  MSG_TELEMETRY,
  MSG_CONTROL,
  FLAG_START,
  FLAG_END,
  FLAG_RESYNC,
  STATUS_STREAM_PRESENT,
  STATUS_TIMEOUT_MUTE,
  STATUS_CLIPPING,
  STATUS_CALIBRATION,
  STATUS_LOW_BATTERY,
  STATUS_LOW_TEMP,
  ENC_PCM16_LE,
  crc16Ccitt,
  packPacket,
  packAudioPacket,
  packTelemetryPacket,
  packControlPacket,
  parsePacket,
};
