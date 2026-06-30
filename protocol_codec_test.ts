/**
 * TS test for protocol_codec.ts.
 *
 * Run with a TS runner:
 *   npx ts-node protocol_codec_test.ts
 * or
 *   npx tsx protocol_codec_test.ts
 */

import assert from "node:assert/strict"
import {
  MSG_AUDIO,
  MSG_CONTROL,
  MSG_TELEMETRY,
  FLAG_START,
  ENC_PCM16_LE,
  parsePacket,
  packAudioPacket,
  packTelemetryPacket,
  packControlPacket,
  AudioPayload,
  TelemetryPayload,
  ControlPayload,
} from "./protocol_codec"

function assertThrows(fn: () => void, message: string): void {
  let threw = false
  try {
    fn()
  } catch (err) {
    threw = true
    assert.ok(String(err).includes(message))
  }
  if (!threw) {
    throw new Error(`expected error containing: ${message}`)
  }
}

const zoneId = 3
const streamId = 11

const audio: AudioPayload = {
  encoding: ENC_PCM16_LE,
  channels: 1,
  sampleRateHz: 48_000,
  frameSamples: 480,
  audio: new Uint8Array(960),
}
const audioPacket = packAudioPacket(zoneId, streamId, 123, 480, audio, FLAG_START, true)
const audioDecoded = parsePacket(audioPacket)
assert.equal(audioDecoded.header.msgType, MSG_AUDIO)
assert.equal((audioDecoded.payload as AudioPayload).audio.length, 960)

const telemetry: TelemetryPayload = {
  status: 0x05,
  rssi: 99,
  ambientRms: 1000,
  bufferMs: 64,
  jitterMs: 5,
  packetLossPpm: 12,
  lastSeq: 123,
  streamId: 11,
}
const telemetryPacket = packTelemetryPacket(zoneId, streamId, 124, 960, telemetry)
const telemetryDecoded = parsePacket(telemetryPacket)
assert.equal(telemetryDecoded.header.msgType, MSG_TELEMETRY)
assert.equal((telemetryDecoded.payload as TelemetryPayload).lastSeq, 123)

const control: ControlPayload = {
  op: 1,
  zoneId,
  argU32: 0xDEADBEEF,
}
const controlPacket = packControlPacket(zoneId, streamId, 125, 1_440, control)
const controlDecoded = parsePacket(controlPacket)
assert.equal(controlDecoded.header.msgType, MSG_CONTROL)
assert.equal((controlDecoded.payload as ControlPayload).argU32, 0xDEADBEEF)

const audioPacketCorrupt = new Uint8Array(audioPacket)
// force one byte change while keeping crc enabled
audioPacketCorrupt[audioPacketCorrupt.length - 1] ^= 0x01
assertThrows(() => parsePacket(audioPacketCorrupt), "crc16 mismatch")

const badLen = new Uint8Array(audioPacket)
badLen[20] = 0
badLen[21] = 0
assertThrows(() => parsePacket(badLen), "payload_len mismatch")

console.log("protocol_codec_test.ts: checks complete")
