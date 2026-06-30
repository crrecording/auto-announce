# Auto-Announce UDP Protocol (v1)

This document defines the first protocol version for the Auto-Announce system.  
The first milestone is software-first and hardware-agnostic: one host app streams audio to simple networked receivers and receives ambient telemetry back.

## 1) Scope and goals

- Low-latency LAN audio transport for announcement playback.
- Predictable behavior across packet loss and jitter.
- Simple implementation for Teensy/embedded firmware.
- Explicit versioning and message types so we can evolve later (Opus, encryption, discovery, etc.).
- No PTP in v1; timing is stream clock + jitter buffering.

## 2) Network model

- Transport: UDP over IPv4 (IPv6 optional in v2).
- Topology: one unicast stream per zone.
- Default ports (v1):
  - Audio RX (from app -> receiver): `41771`
  - Telemetry TX (receiver -> app): `41772`
- Frame size target: keep UDP payloads comfortably below MTU fragmentation, ideally under 1200 bytes.
- Recommended audio format for v1:
  - 48 kHz, 16-bit, PCM mono
  - 10 ms frame = 480 samples

## 3) Packet header (common)

All multi-byte values are little-endian.

| Offset | Size | Field       | Type | Notes |
|---:|---:|---|---|---|
| 0 | 2 | magic | u16 | Fixed `0xAA55` |
| 2 | 1 | version | u8 | Protocol version (`1`) |
| 3 | 1 | msg_type | u8 | See section 4 |
| 4 | 2 | zone_id | u16 | 1..N, per receiver zone |
| 6 | 2 | stream_id | u16 | New value for each stream session |
| 8 | 4 | seq | u32 | Monotonic packet sequence per stream |
| 12 | 4 | timestamp | u32 | Sample index of first sample in this packet |
| 16 | 1 | flags | u8 | See section 4.4 |
| 17 | 1 | reserved | u8 | Must be zero |
| 18 | 2 | crc16 | u16 | Optional CRC16-CCITT over payload |
| 20 | 2 | payload_len | u16 | Payload length in bytes |
| 22 | ... | payload | bytes | Message-specific |

Common header size: **22 bytes**.

## 4) Message types

### 4.1 `0x01` Audio

Sent from host app to receiver.

Payload:

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0 | 1 | encoding | u8 | `0x01` = PCM16_LE |
| 1 | 1 | channels | u8 | `1` in v1 |
| 2 | 2 | sample_rate_hz | u16 | `48000` in v1 |
| 4 | 2 | frame_samples | u16 | Number of samples in this packet |
| 6 | 2 | audio_bytes | u16 | Number of bytes in audio data |
| 8 | ... | audio | i16[] or u8[] | Interleaved PCM16_LE |

Recommended:
- `frame_samples = 480`
- `audio_bytes = frame_samples * channels * 2`
- `payload_len = 8 + audio_bytes`

### 4.2 `0x02` Telemetry

Sent from receiver to host app.

Payload:

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0 | 1 | status | u8 | Bitfield, section 4.4 |
| 1 | 1 | rssi | u8 | Optional for v1; can be 0 |
| 2 | 2 | ambient_rms | u16 | Ambient RMS (0-65535) |
| 4 | 2 | buffer_ms | u16 | Current jitter buffer fill |
| 6 | 2 | jitter_ms | u16 | Packet jitter estimate |
| 8 | 2 | packet_loss_ppm | u16 | Packet loss estimate |
| 10 | 4 | last_seq | u32 | Last contiguous audio seq delivered |
| 14 | 2 | stream_id | u16 | Last seen stream |
| 16 | 2 | reserved | u16 | Must be zero |

### 4.3 `0x03` Control

Sent either direction.

Payload:

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0 | 1 | op | u8 | Operation |
| 1 | 2 | zone_id | u16 | Zone identifier |
| 3 | 1 | reserved | u8 | Must be zero |
| 4 | 4 | arg_u32 | u32 | Operation specific |

Operation ideas for v1:
- `0x01` Mute / unmute
- `0x02` Set output trim dB (Q8 signed, dBFS)
- `0x03` Set limiter threshold (u16)
- `0x04` Set output gain (Q8 signed)
- `0x05` Set delay offset ms (u16)
- `0x06` Ping (heartbeat)

### 4.4 Flags and status bits

Header flags:
- bit 0 `START_STREAM`: start of a new stream burst
- bit 1 `END_STREAM`: optional end marker
- bit 2 `RESYNC`: sender-side clock correction or stream reset
- bits 3..7 reserved = 0

Telemetry `status` bits:
- bit 0 `stream_present`
- bit 1 `muted_by_stream_timeout`
- bit 2 `clipping_detected`
- bit 3 `calibration_mode`
- bit 4 `low_battery`
- bit 5 `low_temp`
- bits 6..7 reserved = 0

## 5) Sender behavior (host app)

- Use a new `stream_id` when entering a stream session or after reconnect.
- Increment `seq` by 1 per packet.
- Increment `timestamp` by `frame_samples` each packet.
- If restarting timing after discontinuity, set `RESYNC`.
- Optional CRC16 recommended during development.
- On `packet_rate` mismatch, keep sending at fixed cadence (`frame_samples / sample_rate`).
- Audio packet interval at 48k + 480 samples = 10ms.

## 6) Receiver behavior

State machine:
- `IDLE`: waiting for valid header and stream
- `LOCKING`: collecting initial packets
- `PLAYING`: steady playout
- `TIMEOUT_MUTE`: safe mute after stream loss

Rules:
- Buffer incoming audio and use sequence numbers for playout order.
- Accept late packets only within one packet-time of expected sequence.
- On packet loss or jitter gap:
  - first strategy: insert silence (`0`) for missing samples
  - do not stretch/squeeze aggressively in v1
- On timeout (no valid audio packet for > 800 ms):
  - enter `TIMEOUT_MUTE`
  - output should be muted/silent
  - send telemetry status bit `muted_by_stream_timeout`
- On timeout recovery:
  - flush existing buffer
  - begin playback only after at least 2–3 good packets buffered
- Duplicate packets:
  - ignore if older than last consumed `seq`
- CRC failures:
  - discard packet, update local loss counters

Target jitter buffer:
- Initial 50–80 ms
- Keep `buffer_ms` generally between 40 and 120 ms

## 7) Timing and sync approach (no PTP)

- No sample-exact network timestamping in v1.
- Sync is implicit from:
  - sender `timestamp`
  - fixed sampling model
  - receiver queue playout
- This is acceptable for room announcements where a few ms jitter is tolerable.
- For future sync refinement, add RTP-like timestamp extension and optional clock sync in v2.

## 8) Security and defaults

- v1 has no auth/encryption.
- Use fixed UDP source IP allowlist.
- Prefer LAN-only firewall/VLAN segmentation.
- Log and reject unexpected `zone_id`/`stream_id`.

## 9) Test matrix (before hardware)

1. Local loopback sender->software receiver, 10ms packets, no loss.
2. Add 1% random loss + 20ms jitter.
3. Burst loss and burst duplicate scenarios.
4. 1-second sender pause and resume with stream timeout behavior.
5. Forced stream restart with new `stream_id` and resync.
6. 5-zone simulated senders to validate zone routing/timeout isolation.

## 10) Minimal v1 implementation checklist

- Host app sends `0x01` audio packets at fixed interval.
- Receiver validates header + seq + payload.
- Receiver uses jitter buffer + silence insertion + timeout mute.
- Receiver emits telemetry (`0x02`) at 10–20 Hz.
- One simple control path (`0x03`) for mute / gain.
