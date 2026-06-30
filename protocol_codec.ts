/**
 * Auto-Announce UDP Protocol v1 codec (TypeScript).
 *
 * Dependency-free, intended for browser/Node/firmware tooling.
 */

export const MAGIC = 0xaa55
export const VERSION = 1
export const HEADER_SIZE = 22

export const MSG_AUDIO = 0x01
export const MSG_TELEMETRY = 0x02
export const MSG_CONTROL = 0x03

export const FLAG_START = 0x01
export const FLAG_END = 0x02
export const FLAG_RESYNC = 0x04

export const STATUS_STREAM_PRESENT = 0x01
export const STATUS_TIMEOUT_MUTE = 0x02
export const STATUS_CLIPPING = 0x04
export const STATUS_CALIBRATION = 0x08
export const STATUS_LOW_BATTERY = 0x10
export const STATUS_LOW_TEMP = 0x20

export const ENC_PCM16_LE = 0x01

export interface PacketHeader {
  magic: number
  version: number
  msgType: number
  zoneId: number
  streamId: number
  seq: number
  timestamp: number
  flags: number
  crc16: number
  payloadLen: number
}

export interface AudioPayload {
  encoding: number
  channels: number
  sampleRateHz: number
  frameSamples: number
  audio: Uint8Array
}

export interface TelemetryPayload {
  status: number
  rssi: number
  ambientRms: number
  bufferMs: number
  jitterMs: number
  packetLossPpm: number
  lastSeq: number
  streamId: number
}

export interface ControlPayload {
  op: number
  zoneId: number
  argU32: number
}

export type PacketPayload = AudioPayload | TelemetryPayload | ControlPayload | Uint8Array

export interface ParsedPacket {
  header: PacketHeader
  payload: PacketPayload
}

export function crc16Ccitt(data: Uint8Array, poly = 0x1021, init = 0xffff): number {
  let crc = init
  for (const byte of data) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ poly) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc
}

function writeHeader(header: Omit<PacketHeader, "payloadLen" | "crc16" | "magic" | "version"> & {
  payloadLen: number
  crc16?: number
}, buf: Uint8Array, includeCrc = false) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 0
  dv.setUint16(offset, MAGIC, true); offset += 2
  dv.setUint8(offset, VERSION); offset += 1
  dv.setUint8(offset, header.msgType); offset += 1
  dv.setUint16(offset, header.zoneId & 0xffff, true); offset += 2
  dv.setUint16(offset, header.streamId & 0xffff, true); offset += 2
  dv.setUint32(offset, header.seq >>> 0, true); offset += 4
  dv.setUint32(offset, header.timestamp >>> 0, true); offset += 4
  dv.setUint8(offset, header.flags & 0xff); offset += 1
  dv.setUint8(offset, 0); offset += 1
  dv.setUint16(offset, includeCrc ? (header.crc16 ?? 0) : 0, true); offset += 2
  dv.setUint16(offset, header.payloadLen & 0xffff, true)
}

export function packAudioPacket(
  zoneId: number,
  streamId: number,
  seq: number,
  timestamp: number,
  payload: AudioPayload,
  flags = 0,
  includeCrc = false
): Uint8Array {
  const payloadBytes = new Uint8Array(8 + payload.audio.length)
  const dv = new DataView(payloadBytes.buffer)
  let o = 0
  dv.setUint8(o, payload.encoding); o += 1
  dv.setUint8(o, payload.channels); o += 1
  dv.setUint16(o, payload.sampleRateHz, true); o += 2
  dv.setUint16(o, payload.frameSamples, true); o += 2
  dv.setUint16(o, payload.audio.length, true); o += 2
  payloadBytes.set(payload.audio, o)

  const packet = new Uint8Array(HEADER_SIZE + payloadBytes.length)
  const crc = includeCrc ? crc16Ccitt(payloadBytes) : 0
  writeHeader({ msgType: MSG_AUDIO, zoneId, streamId, seq, timestamp, flags, payloadLen: payloadBytes.length, crc16: crc }, packet, includeCrc)
  packet.set(payloadBytes, HEADER_SIZE)
  return packet
}

export function packTelemetryPacket(
  zoneId: number,
  streamId: number,
  seq: number,
  timestamp: number,
  payload: TelemetryPayload,
  flags = 0,
  includeCrc = false
): Uint8Array {
  const payloadBytes = new Uint8Array(18)
  const dv = new DataView(payloadBytes.buffer)
  let o = 0
  dv.setUint8(o, payload.status); o += 1
  dv.setUint8(o, payload.rssi); o += 1
  dv.setUint16(o, payload.ambientRms, true); o += 2
  dv.setUint16(o, payload.bufferMs, true); o += 2
  dv.setUint16(o, payload.jitterMs, true); o += 2
  dv.setUint16(o, payload.packetLossPpm, true); o += 2
  dv.setUint32(o, payload.lastSeq >>> 0, true); o += 4
  dv.setUint16(o, payload.streamId, true); o += 2
  dv.setUint16(o, 0, true)

  const packet = new Uint8Array(HEADER_SIZE + payloadBytes.length)
  const crc = includeCrc ? crc16Ccitt(payloadBytes) : 0
  writeHeader(
    { msgType: MSG_TELEMETRY, zoneId, streamId, seq, timestamp, flags, payloadLen: payloadBytes.length, crc16: crc },
    packet,
    includeCrc
  )
  packet.set(payloadBytes, HEADER_SIZE)
  return packet
}

export function packControlPacket(
  zoneId: number,
  streamId: number,
  seq: number,
  timestamp: number,
  payload: ControlPayload,
  flags = 0,
  includeCrc = false
): Uint8Array {
  const payloadBytes = new Uint8Array(8)
  const dv = new DataView(payloadBytes.buffer)
  let o = 0
  dv.setUint8(o, payload.op); o += 1
  dv.setUint16(o, payload.zoneId, true); o += 2
  dv.setUint8(o, 0); o += 1
  dv.setUint32(o, payload.argU32 >>> 0, true)

  const packet = new Uint8Array(HEADER_SIZE + payloadBytes.length)
  const crc = includeCrc ? crc16Ccitt(payloadBytes) : 0
  writeHeader({ msgType: MSG_CONTROL, zoneId, streamId, seq, timestamp, flags, payloadLen: payloadBytes.length, crc16: crc }, packet, includeCrc)
  packet.set(payloadBytes, HEADER_SIZE)
  return packet
}

export function parsePacket(raw: Uint8Array): ParsedPacket {
  if (raw.byteLength < HEADER_SIZE) {
    throw new Error("packet too short for header")
  }

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let offset = 0
  const magic = dv.getUint16(offset, true); offset += 2
  if (magic !== MAGIC) {
    throw new Error(`invalid magic: 0x${magic.toString(16)}`)
  }

  const version = dv.getUint8(offset); offset += 1
  if (version !== VERSION) {
    throw new Error(`unexpected version: ${version}`)
  }

  const msgType = dv.getUint8(offset); offset += 1
  const zoneId = dv.getUint16(offset, true); offset += 2
  const streamId = dv.getUint16(offset, true); offset += 2
  const seq = dv.getUint32(offset, true); offset += 4
  const timestamp = dv.getUint32(offset, true); offset += 4
  const flags = dv.getUint8(offset); offset += 1
  offset += 1 // reserved
  const crc16 = dv.getUint16(offset, true); offset += 2
  const payloadLen = dv.getUint16(offset, true); offset += 2

  if (HEADER_SIZE + payloadLen !== raw.byteLength) {
    throw new Error("payload_len mismatch with datagram length")
  }

  const payload = new Uint8Array(raw.buffer, raw.byteOffset + HEADER_SIZE, payloadLen)
  if (crc16 !== 0 && crc16Ccitt(payload) !== crc16) {
    throw new Error("crc16 mismatch")
  }

  const header: PacketHeader = {
    magic,
    version,
    msgType,
    zoneId,
    streamId,
    seq,
    timestamp,
    flags,
    crc16,
    payloadLen
  }

  if (msgType === MSG_AUDIO) {
    if (payloadLen < 8) throw new Error("audio payload too short")
    const d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    let po = 0
    const encoding = d.getUint8(po); po += 1
    const channels = d.getUint8(po); po += 1
    const sampleRateHz = d.getUint16(po, true); po += 2
    const frameSamples = d.getUint16(po, true); po += 2
    const audioBytes = d.getUint16(po, true); po += 2
    if (payload.byteLength !== 8 + audioBytes) throw new Error("audio payload length mismatch")
    const audio = payload.slice(8)
    return {
      header,
      payload: {
        encoding,
        channels,
        sampleRateHz,
        frameSamples,
        audio
      }
    }
  }

  if (msgType === MSG_TELEMETRY) {
    if (payloadLen < 18) throw new Error("telemetry payload too short")
    const d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    let po = 0
    const status = d.getUint8(po); po += 1
    const rssi = d.getUint8(po); po += 1
    const ambientRms = d.getUint16(po, true); po += 2
    const bufferMs = d.getUint16(po, true); po += 2
    const jitterMs = d.getUint16(po, true); po += 2
    const packetLossPpm = d.getUint16(po, true); po += 2
    const lastSeq = d.getUint32(po, true); po += 4
    const seenStreamId = d.getUint16(po, true); po += 2
    return {
      header,
      payload: {
        status,
        rssi,
        ambientRms,
        bufferMs,
        jitterMs,
        packetLossPpm,
        lastSeq,
        streamId: seenStreamId
      }
    }
  }

  if (msgType === MSG_CONTROL) {
    if (payloadLen < 8) throw new Error("control payload too short")
    const d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const op = d.getUint8(0)
    const payloadZoneId = d.getUint16(1, true)
    const argU32 = d.getUint32(4, true)
    return {
      header,
      payload: {
        op,
        zoneId: payloadZoneId,
        argU32
      }
    }
  }

  return { header, payload }
}

export function demo(): void {
  const audio = {
    encoding: ENC_PCM16_LE,
    channels: 1,
    sampleRateHz: 48_000,
    frameSamples: 480,
    audio: new Uint8Array(960)
  }
  const packet = packAudioPacket(2, 7, 1, 0, audio, FLAG_START, true)
  const decoded = parsePacket(packet)
  const p = decoded.payload as AudioPayload
  console.log(`Demo bytes=${packet.byteLength}`)
  console.log(`Zone=${decoded.header.zoneId} Seq=${decoded.header.seq} type=${decoded.header.msgType}`)
  console.log(`Samples=${p.frameSamples} audio_bytes=${p.audio.length}`)
}
