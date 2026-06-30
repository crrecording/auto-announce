#!/usr/bin/env python3
"""
Auto-Announce v1 UDP loopback proof.

Runs a host-side audio sender, a simulated receiver, and a host telemetry
listener in one process. This proves the packet codec and UDP flow before
building the full desktop app.

Run:
  python3 host_loopback.py
"""

from __future__ import annotations

import argparse
import math
import socket
import struct
import threading
import time
from dataclasses import dataclass

from protocol_codec import (
    AudioPayload,
    ENC_PCM16_LE,
    FLAG_START,
    MSG_AUDIO,
    MSG_TELEMETRY,
    Packet,
    STATUS_STREAM_PRESENT,
    TelemetryPayload,
    parse_packet,
)


LOCALHOST = "127.0.0.1"
DEFAULT_AUDIO_PORT = 41771
DEFAULT_TELEMETRY_PORT = 41772
SAMPLE_RATE_HZ = 48000
FRAME_SAMPLES = 480
CHANNELS = 1


@dataclass
class LoopbackStats:
    audio_packets_sent: int = 0
    audio_packets_received: int = 0
    telemetry_packets_sent: int = 0
    telemetry_packets_received: int = 0
    lost_packets_detected: int = 0
    duplicate_or_late_packets: int = 0
    first_seq: int | None = None
    last_seq: int | None = None
    first_timestamp: int | None = None
    last_timestamp: int | None = None
    audio_bytes_received: int = 0


def make_sine_frame(frame_index: int, frequency_hz: float = 880.0, amplitude: float = 0.20) -> bytes:
    samples = bytearray(FRAME_SAMPLES * 2)
    for i in range(FRAME_SAMPLES):
        n = frame_index * FRAME_SAMPLES + i
        value = int(math.sin(2 * math.pi * frequency_hz * n / SAMPLE_RATE_HZ) * 32767 * amplitude)
        struct.pack_into("<h", samples, i * 2, value)
    return bytes(samples)


def run_receiver(
    stop: threading.Event,
    ready: threading.Event,
    stats: LoopbackStats,
    audio_port: int,
    telemetry_port: int,
    zone_id: int,
    stream_id: int,
) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((LOCALHOST, audio_port))
    sock.settimeout(0.1)
    ready.set()

    expected_seq: int | None = None

    try:
        while not stop.is_set():
            try:
                raw, _addr = sock.recvfrom(2048)
            except socket.timeout:
                continue

            decoded = parse_packet(raw)
            header = decoded["header"]
            payload = decoded["payload"]

            if header.msg_type != MSG_AUDIO or header.zone_id != zone_id or header.stream_id != stream_id:
                continue

            if expected_seq is None:
                expected_seq = header.seq
                stats.first_seq = header.seq
                stats.first_timestamp = header.timestamp

            if header.seq < expected_seq:
                stats.duplicate_or_late_packets += 1
                continue

            if header.seq > expected_seq:
                stats.lost_packets_detected += header.seq - expected_seq

            expected_seq = header.seq + 1
            stats.audio_packets_received += 1
            stats.last_seq = header.seq
            stats.last_timestamp = header.timestamp
            stats.audio_bytes_received += len(payload.audio)

            telemetry = TelemetryPayload(
                status=STATUS_STREAM_PRESENT,
                rssi=0,
                ambient_rms=1000,
                buffer_ms=60,
                jitter_ms=0,
                packet_loss_ppm=0,
                last_seq=header.seq,
                stream_id=stream_id,
            )
            telemetry_packet = Packet(
                MSG_TELEMETRY,
                zone_id=zone_id,
                stream_id=stream_id,
                seq=header.seq,
                timestamp=header.timestamp,
                payload=telemetry.pack(),
            )
            sock.sendto(telemetry_packet.pack(include_crc=True), (LOCALHOST, telemetry_port))
            stats.telemetry_packets_sent += 1
    finally:
        sock.close()


def run_telemetry_listener(stop: threading.Event, ready: threading.Event, stats: LoopbackStats, telemetry_port: int) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((LOCALHOST, telemetry_port))
    sock.settimeout(0.1)
    ready.set()

    try:
        while not stop.is_set():
            try:
                raw, _addr = sock.recvfrom(2048)
            except socket.timeout:
                continue

            decoded = parse_packet(raw)
            if decoded["header"].msg_type == MSG_TELEMETRY:
                stats.telemetry_packets_received += 1
    finally:
        sock.close()


def run_sender(
    stats: LoopbackStats,
    audio_port: int,
    zone_id: int,
    stream_id: int,
    frames: int,
    realtime: bool,
) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    frame_interval_s = FRAME_SAMPLES / SAMPLE_RATE_HZ

    try:
        for frame_index in range(frames):
            flags = FLAG_START if frame_index == 0 else 0
            audio = AudioPayload(
                encoding=ENC_PCM16_LE,
                channels=CHANNELS,
                sample_rate_hz=SAMPLE_RATE_HZ,
                frame_samples=FRAME_SAMPLES,
                audio=make_sine_frame(frame_index),
            )
            packet = Packet(
                MSG_AUDIO,
                zone_id=zone_id,
                stream_id=stream_id,
                seq=frame_index,
                timestamp=frame_index * FRAME_SAMPLES,
                flags=flags,
                payload=audio.pack(),
            )
            sock.sendto(packet.pack(include_crc=True), (LOCALHOST, audio_port))
            stats.audio_packets_sent += 1
            if realtime:
                time.sleep(frame_interval_s)
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Auto-Announce v1 UDP loopback proof.")
    parser.add_argument("--frames", type=int, default=100, help="Number of 10 ms audio frames to send.")
    parser.add_argument("--audio-port", type=int, default=DEFAULT_AUDIO_PORT)
    parser.add_argument("--telemetry-port", type=int, default=DEFAULT_TELEMETRY_PORT)
    parser.add_argument("--zone-id", type=int, default=1)
    parser.add_argument("--stream-id", type=int, default=1)
    parser.add_argument("--fast", action="store_true", help="Send as fast as possible instead of realtime cadence.")
    args = parser.parse_args()

    stop = threading.Event()
    receiver_ready = threading.Event()
    telemetry_ready = threading.Event()
    stats = LoopbackStats()

    receiver = threading.Thread(
        target=run_receiver,
        args=(stop, receiver_ready, stats, args.audio_port, args.telemetry_port, args.zone_id, args.stream_id),
        daemon=True,
    )
    telemetry = threading.Thread(
        target=run_telemetry_listener,
        args=(stop, telemetry_ready, stats, args.telemetry_port),
        daemon=True,
    )

    receiver.start()
    telemetry.start()
    receiver_ready.wait(timeout=2)
    telemetry_ready.wait(timeout=2)

    started = time.perf_counter()
    run_sender(
        stats,
        audio_port=args.audio_port,
        zone_id=args.zone_id,
        stream_id=args.stream_id,
        frames=args.frames,
        realtime=not args.fast,
    )

    deadline = time.perf_counter() + 2
    while stats.audio_packets_received < args.frames and time.perf_counter() < deadline:
        time.sleep(0.01)
    while stats.telemetry_packets_received < stats.audio_packets_received and time.perf_counter() < deadline:
        time.sleep(0.01)

    elapsed = time.perf_counter() - started
    stop.set()
    receiver.join(timeout=1)
    telemetry.join(timeout=1)

    expected_last_timestamp = (args.frames - 1) * FRAME_SAMPLES if args.frames else None
    ok = (
        stats.audio_packets_sent == args.frames
        and stats.audio_packets_received == args.frames
        and stats.telemetry_packets_received == args.frames
        and stats.lost_packets_detected == 0
        and stats.duplicate_or_late_packets == 0
        and stats.last_timestamp == expected_last_timestamp
    )

    print("Auto-Announce UDP loopback")
    print(f"  audio packets sent:        {stats.audio_packets_sent}")
    print(f"  audio packets received:    {stats.audio_packets_received}")
    print(f"  telemetry packets sent:    {stats.telemetry_packets_sent}")
    print(f"  telemetry packets received:{stats.telemetry_packets_received}")
    print(f"  seq range:                 {stats.first_seq}..{stats.last_seq}")
    print(f"  timestamp range:           {stats.first_timestamp}..{stats.last_timestamp}")
    print(f"  audio bytes received:      {stats.audio_bytes_received}")
    print(f"  loss detected:             {stats.lost_packets_detected}")
    print(f"  duplicate/late detected:   {stats.duplicate_or_late_packets}")
    print(f"  elapsed:                   {elapsed:.3f}s")
    print(f"  result:                    {'PASS' if ok else 'FAIL'}")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
