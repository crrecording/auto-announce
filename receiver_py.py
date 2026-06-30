#!/usr/bin/env python3
"""
Auto-Announce Python receiver simulator.

This is a no-dependency fallback for machines that have Python but not Node/npm.

Run:
  python3 receiver_py.py --host 0.0.0.0 --telemetry-host 192.168.10.100
"""

from __future__ import annotations

import argparse
import math
import socket
import struct
import time
from dataclasses import dataclass

from protocol_codec import (
    MSG_AUDIO,
    MSG_TELEMETRY,
    STATUS_STREAM_PRESENT,
    Packet,
    TelemetryPayload,
    parse_packet,
)


DEFAULT_AUDIO_PORT = 41771
DEFAULT_TELEMETRY_PORT = 41772
SAMPLE_RATE_HZ = 48000
CHANNELS = 1
BITS_PER_SAMPLE = 16


@dataclass
class ReceiverStats:
    packets: int = 0
    audio_bytes: int = 0
    first_seq: int | None = None
    last_seq: int | None = None
    expected_seq: int | None = None
    first_timestamp: int | None = None
    last_timestamp: int | None = None
    lost: int = 0
    duplicate_or_late: int = 0
    parse_errors: int = 0
    last_from: str | None = None
    started_at: float = time.time()


class WavWriter:
    def __init__(self, path: str):
        self.path = path
        self.file = open(path, "wb")
        self.bytes_written = 0
        self.file.write(b"\x00" * 44)

    def write(self, pcm: bytes) -> None:
        self.file.write(pcm)
        self.bytes_written += len(pcm)

    def close(self) -> None:
        byte_rate = SAMPLE_RATE_HZ * CHANNELS * BITS_PER_SAMPLE // 8
        block_align = CHANNELS * BITS_PER_SAMPLE // 8
        data_size = self.bytes_written
        riff_size = 36 + data_size
        self.file.seek(0)
        self.file.write(
            struct.pack(
                "<4sI4s4sIHHIIHH4sI",
                b"RIFF",
                riff_size,
                b"WAVE",
                b"fmt ",
                16,
                1,
                CHANNELS,
                SAMPLE_RATE_HZ,
                byte_rate,
                block_align,
                BITS_PER_SAMPLE,
                b"data",
                data_size,
            )
        )
        self.file.close()


def estimate_rms(audio: bytes) -> int:
    sample_count = len(audio) // 2
    if sample_count <= 0:
        return 0
    total = 0
    for i in range(sample_count):
        sample = struct.unpack_from("<h", audio, i * 2)[0]
        total += sample * sample
    return min(65535, round(math.sqrt(total / sample_count)))


def estimate_loss_ppm(stats: ReceiverStats) -> int:
    total = stats.packets + stats.lost
    if total <= 0:
        return 0
    return min(65535, round((stats.lost / total) * 1_000_000))


def print_stats(stats: ReceiverStats) -> None:
    elapsed = max(time.time() - stats.started_at, 0.001)
    pps = stats.packets / elapsed
    print(
        f"packets={stats.packets} pps={pps:.1f} "
        f"seq={stats.first_seq}..{stats.last_seq} "
        f"ts={stats.first_timestamp}..{stats.last_timestamp} "
        f"lost={stats.lost} late={stats.duplicate_or_late} "
        f"errors={stats.parse_errors} from={stats.last_from or '-'}",
        flush=True,
    )


def run(args: argparse.Namespace) -> int:
    stats = ReceiverStats()
    wav = WavWriter(args.wav_out) if args.wav_out else None
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))
    sock.settimeout(0.1)

    print(f"Auto-Announce Python receiver listening on udp://{args.host}:{args.port}")
    print(f"Telemetry target: {args.telemetry_host or 'audio sender address'}:{args.telemetry_port}")
    if wav:
        print(f"Writing received PCM to WAV: {args.wav_out}")

    next_print = time.time() + 1
    try:
        while True:
            try:
                raw, remote = sock.recvfrom(2048)
            except socket.timeout:
                if time.time() >= next_print:
                    print_stats(stats)
                    next_print = time.time() + 1
                continue

            try:
                decoded = parse_packet(raw)
                header = decoded["header"]
                payload = decoded["payload"]
                if header.msg_type != MSG_AUDIO:
                    continue

                if stats.expected_seq is None:
                    stats.expected_seq = header.seq
                    stats.first_seq = header.seq
                    stats.first_timestamp = header.timestamp

                if header.seq < stats.expected_seq:
                    stats.duplicate_or_late += 1
                    continue

                if header.seq > stats.expected_seq:
                    stats.lost += header.seq - stats.expected_seq

                stats.expected_seq = header.seq + 1
                stats.packets += 1
                stats.audio_bytes += len(payload.audio)
                stats.last_seq = header.seq
                stats.last_timestamp = header.timestamp
                stats.last_from = f"{remote[0]}:{remote[1]}"
                if wav:
                    wav.write(payload.audio)

                telemetry = TelemetryPayload(
                    status=STATUS_STREAM_PRESENT,
                    rssi=0,
                    ambient_rms=estimate_rms(payload.audio),
                    buffer_ms=60,
                    jitter_ms=0,
                    packet_loss_ppm=estimate_loss_ppm(stats),
                    last_seq=header.seq,
                    stream_id=header.stream_id,
                )
                response = Packet(
                    MSG_TELEMETRY,
                    zone_id=header.zone_id,
                    stream_id=header.stream_id,
                    seq=header.seq,
                    timestamp=header.timestamp,
                    payload=telemetry.pack(),
                )
                telemetry_host = args.telemetry_host or remote[0]
                sock.sendto(response.pack(include_crc=True), (telemetry_host, args.telemetry_port))
            except Exception as exc:
                stats.parse_errors += 1
                if stats.parse_errors <= 5:
                    print(f"Parse error: {exc}", flush=True)

            if time.time() >= next_print:
                print_stats(stats)
                next_print = time.time() + 1
    except KeyboardInterrupt:
        print_stats(stats)
        return 0
    finally:
        sock.close()
        if wav:
            wav.close()
            print(f"WAV saved: {args.wav_out}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Auto-Announce Python receiver simulator.")
    parser.add_argument("--host", default="0.0.0.0", help="Local address to bind. Use 0.0.0.0 for all interfaces.")
    parser.add_argument("--port", type=int, default=DEFAULT_AUDIO_PORT, help="UDP audio receive port.")
    parser.add_argument("--telemetry-host", default=None, help="Host app IP for telemetry return packets.")
    parser.add_argument("--telemetry-port", type=int, default=DEFAULT_TELEMETRY_PORT, help="UDP telemetry destination port.")
    parser.add_argument("--wav-out", default=None, help="Optional path to write received PCM audio as a WAV file.")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
