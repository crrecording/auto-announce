#!/usr/bin/env python3
"""
Auto-Announce UDP Protocol v1 codec.

No external dependencies. Intended as a validation stub for app/firmware work.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Dict, Any


MAGIC = 0xAA55
VERSION = 1

MSG_AUDIO = 0x01
MSG_TELEMETRY = 0x02
MSG_CONTROL = 0x03

FLAG_START = 0x01
FLAG_END = 0x02
FLAG_RESYNC = 0x04

STATUS_STREAM_PRESENT = 0x01
STATUS_TIMEOUT_MUTE = 0x02
STATUS_CLIPPING = 0x04
STATUS_CALIBRATION = 0x08
STATUS_LOW_BATTERY = 0x10
STATUS_LOW_TEMP = 0x20

ENC_PCM16_LE = 0x01


def crc16_ccitt(data: bytes, poly: int = 0x1021, init: int = 0xFFFF) -> int:
    crc = init
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc & 0xFFFF


@dataclass
class Packet:
    msg_type: int
    zone_id: int
    stream_id: int
    seq: int
    timestamp: int
    flags: int = 0
    payload: bytes = b""

    def pack(self, version: int = VERSION, include_crc: bool = False) -> bytes:
        payload_len = len(self.payload)
        crc = crc16_ccitt(self.payload) if include_crc else 0
        hdr = struct.pack(
            "<HBBHHIIBBHH",
            MAGIC,
            version,
            self.msg_type,
            self.zone_id & 0xFFFF,
            self.stream_id & 0xFFFF,
            self.seq & 0xFFFFFFFF,
            self.timestamp & 0xFFFFFFFF,
            self.flags & 0xFF,
            0,
            crc & 0xFFFF,
            payload_len & 0xFFFF,
        )
        return hdr + self.payload


@dataclass
class AudioPayload:
    encoding: int
    channels: int
    sample_rate_hz: int
    frame_samples: int
    audio: bytes

    def pack(self) -> bytes:
        return struct.pack("<BBHHH", self.encoding, self.channels, self.sample_rate_hz, self.frame_samples, len(self.audio)) + self.audio

    @classmethod
    def parse(cls, data: bytes) -> "AudioPayload":
        if len(data) < 8:
            raise ValueError("audio payload too short")
        encoding, channels, sample_rate_hz, frame_samples, audio_bytes = struct.unpack("<BBHHH", data[:8])
        if len(data) != 8 + audio_bytes:
            raise ValueError("audio payload length mismatch")
        audio = data[8:]
        return cls(encoding, channels, sample_rate_hz, frame_samples, audio)


@dataclass
class TelemetryDebug:
    flags: int = 0
    receiver_pps_x10: int = 0
    total_packets: int = 0
    lost_packets: int = 0
    late_packets: int = 0
    playback_buffer_frames: int = 0
    playback_underflows: int = 0
    playback_drops: int = 0
    playback_broken_pipes: int = 0
    playback_exit_code: int = -1
    parse_errors: int = 0

    def pack(self) -> bytes:
        return struct.pack(
            "<HBBHIIIHIIHhH",
            0x4441,
            1,
            self.flags & 0xFF,
            self.receiver_pps_x10 & 0xFFFF,
            self.total_packets & 0xFFFFFFFF,
            self.lost_packets & 0xFFFFFFFF,
            self.late_packets & 0xFFFFFFFF,
            self.playback_buffer_frames & 0xFFFF,
            self.playback_underflows & 0xFFFFFFFF,
            self.playback_drops & 0xFFFFFFFF,
            self.playback_broken_pipes & 0xFFFF,
            max(-32768, min(32767, self.playback_exit_code)),
            self.parse_errors & 0xFFFF,
        )

    @classmethod
    def parse(cls, data: bytes) -> "TelemetryDebug | None":
        if len(data) < 34:
            return None
        magic, version = struct.unpack("<HB", data[:3])
        if magic != 0x4441 or version != 1:
            return None
        (
            _magic,
            _version,
            flags,
            receiver_pps_x10,
            total_packets,
            lost_packets,
            late_packets,
            playback_buffer_frames,
            playback_underflows,
            playback_drops,
            playback_broken_pipes,
            playback_exit_code,
            parse_errors,
        ) = struct.unpack("<HBBHIIIHIIHhH", data[:34])
        return cls(
            flags,
            receiver_pps_x10,
            total_packets,
            lost_packets,
            late_packets,
            playback_buffer_frames,
            playback_underflows,
            playback_drops,
            playback_broken_pipes,
            playback_exit_code,
            parse_errors,
        )


@dataclass
class TelemetryPayload:
    status: int
    rssi: int
    ambient_rms: int
    buffer_ms: int
    jitter_ms: int
    packet_loss_ppm: int
    last_seq: int
    stream_id: int
    debug: TelemetryDebug | None = None

    def pack(self) -> bytes:
        base = struct.pack(
            "<BBHHHHIHH",
            self.status & 0xFF,
            self.rssi & 0xFF,
            self.ambient_rms & 0xFFFF,
            self.buffer_ms & 0xFFFF,
            self.jitter_ms & 0xFFFF,
            self.packet_loss_ppm & 0xFFFF,
            self.last_seq & 0xFFFFFFFF,
            self.stream_id & 0xFFFF,
            0,
        )
        return base + (self.debug.pack() if self.debug else b"")

    @classmethod
    def parse(cls, data: bytes) -> "TelemetryPayload":
        if len(data) < 18:
            raise ValueError("telemetry payload too short")
        status, rssi, ambient_rms, buffer_ms, jitter_ms, packet_loss_ppm, last_seq, stream_id, _reserved = struct.unpack("<BBHHHHIHH", data[:18])
        debug = TelemetryDebug.parse(data[18:]) if len(data) >= 52 else None
        return cls(status, rssi, ambient_rms, buffer_ms, jitter_ms, packet_loss_ppm, last_seq, stream_id, debug)


@dataclass
class ControlPayload:
    op: int
    zone_id: int
    arg_u32: int

    def pack(self) -> bytes:
        return struct.pack("<BHBI", self.op, self.zone_id & 0xFFFF, 0, self.arg_u32 & 0xFFFFFFFF)

    @classmethod
    def parse(cls, data: bytes) -> "ControlPayload":
        if len(data) < 8:
            raise ValueError("control payload too short")
        op = data[0]
        zone_id = struct.unpack("<H", data[1:3])[0]
        arg_u32 = struct.unpack("<I", data[4:8])[0]
        return cls(op, zone_id, arg_u32)


def parse_packet(raw: bytes) -> Dict[str, Any]:
    if len(raw) < 22:
        raise ValueError("packet too short for header")

    magic, version, msg_type, zone_id, stream_id, seq, timestamp, flags, _reserved, crc16, payload_len = struct.unpack(
        "<HBBHHIIBBHH",
        raw[:22]
    )
    if magic != MAGIC:
        raise ValueError(f"invalid magic: 0x{magic:04X}")
    if payload_len + 22 != len(raw):
        raise ValueError("payload_len mismatch with datagram length")

    payload = raw[22:]
    if crc16 and crc16_ccitt(payload) != crc16:
        raise ValueError("crc16 mismatch")

    if version != VERSION:
        raise ValueError(f"unexpected version: {version}")

    pkt = Packet(msg_type, zone_id, stream_id, seq, timestamp, flags, payload)
    if msg_type == MSG_AUDIO:
        pkt.payload_parsed = AudioPayload.parse(payload)
    elif msg_type == MSG_TELEMETRY:
        pkt.payload_parsed = TelemetryPayload.parse(payload)
    elif msg_type == MSG_CONTROL:
        pkt.payload_parsed = ControlPayload.parse(payload)
    else:
        pkt.payload_parsed = None

    return {"header": pkt, "payload": pkt.payload_parsed}


def _demo() -> None:
    aud = AudioPayload(
        encoding=ENC_PCM16_LE,
        channels=1,
        sample_rate_hz=48000,
        frame_samples=480,
        audio=bytes([0] * 960),
    )
    pkt = Packet(MSG_AUDIO, zone_id=2, stream_id=7, seq=1, timestamp=0, flags=FLAG_START, payload=aud.pack())
    raw = pkt.pack(include_crc=True)
    obj = parse_packet(raw)
    print(f"Demo packet bytes: {len(raw)}")
    print(f"Decoded: zone={obj['header'].zone_id}, seq={obj['header'].seq}, type={obj['header'].msg_type}")
    parsed_payload = obj["payload"]
    print(f"Payload samples={parsed_payload.frame_samples}, audio_bytes={len(parsed_payload.audio)}")


if __name__ == "__main__":
    _demo()
