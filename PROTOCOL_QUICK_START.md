# Auto-Announce Protocol v1 — Quick Reference

## Packet layout (all little-endian)

**Header (22 bytes) for every UDP packet**

- `magic` **2**: `0xAA55` (serialized as bytes `55 AA` because little-endian)
- `version` **1**: `1`
- `msg_type` **1**: `0x01` audio, `0x02` telemetry, `0x03` control
- `zone_id` **2**
- `stream_id` **2**
- `seq` **4**
- `timestamp` **4** (sample index)
- `flags` **1**
- `reserved` **1** (0)
- `crc16` **2** (optional)
- `payload_len` **2**
- `payload` **N**

## v1 message types

### 0x01 Audio payload
- `encoding` **1** = `0x01` (PCM16_LE)
- `channels` **1** = `1`
- `sample_rate_hz` **2** = `48000`
- `frame_samples` **2**
- `audio_bytes` **2**
- `audio` **audio_bytes**
- **payload_len = 8 + audio_bytes**

Recommended: `frame_samples=480` (10 ms @ 48k), `audio_bytes=960`.

### 0x02 Telemetry payload (receiver → app)
- `status` **1**
- `rssi` **1** (optional, 0)
- `ambient_rms` **2**
- `buffer_ms` **2**
- `jitter_ms` **2**
- `packet_loss_ppm` **2**
- `last_seq` **4**
- `stream_id` **2**
- `reserved` **2** = 0

### 0x03 Control payload (either direction)
- `op` **1**
- `zone_id` **2**
- `reserved` **1** = 0
- `arg_u32` **4**

## Sequence/timing rules
- Sender increments `seq` by 1 per audio packet.
- Sender increments `timestamp` by `frame_samples`.
- Use new `stream_id` per stream session / reconnect.
- If stream timing resets, set header `RESYNC` flag.

## Receiver behavior (must-have v1)
- Jitter buffer target: 50–80 ms.
- Keep playing with silence-fill on packet loss.
- Timeout if no audio for `>800 ms`.
- On timeout, mute and set telemetry bit `muted_by_stream_timeout`.
- On recovery, start playback after 2–3 full packets buffered.

## Ports
- Audio IN: `41771`
- Telemetry OUT: `41772`

## CRC
- `crc16` optional in v1. If enabled, compute over payload bytes only and validate on receive.
