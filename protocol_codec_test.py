#!/usr/bin/env python3
"""
Basic regression tests for protocol_codec.py.
Run: python3 protocol_codec_test.py
"""

import secrets

from protocol_codec import (
    ControlPayload,
    Packet,
    MSG_AUDIO,
    MSG_CONTROL,
    MSG_TELEMETRY,
    FLAG_START,
    AudioPayload,
    TelemetryPayload,
    ENC_PCM16_LE,
    parse_packet,
    crc16_ccitt,
)


def make_audio_payload():
    audio = bytes(secrets.token_bytes(960))
    payload = AudioPayload(
        encoding=ENC_PCM16_LE,
        channels=1,
        sample_rate_hz=48000,
        frame_samples=480,
        audio=audio,
    )
    return payload


def run():
    aud = make_audio_payload()
    ap = Packet(MSG_AUDIO, zone_id=3, stream_id=11, seq=12345, timestamp=48000, flags=FLAG_START, payload=aud.pack())
    raw = ap.pack(include_crc=True)
    dec = parse_packet(raw)
    assert dec["header"].msg_type == MSG_AUDIO
    ap2 = dec["payload"]
    assert ap2.audio == aud.audio
    assert ap2.frame_samples == 480
    assert ap2.sample_rate_hz == 48000

    tlm = TelemetryPayload(
        status=0x05,
        rssi=99,
        ambient_rms=1000,
        buffer_ms=64,
        jitter_ms=5,
        packet_loss_ppm=12,
        last_seq=12345,
        stream_id=11,
    )
    tp = Packet(MSG_TELEMETRY, zone_id=3, stream_id=11, seq=54321, timestamp=96000, flags=0, payload=tlm.pack())
    traw = tp.pack(include_crc=False)
    tdec = parse_packet(traw)
    assert tdec["header"].msg_type == MSG_TELEMETRY
    tp2 = tdec["payload"]
    assert tp2.status == 0x05
    assert tp2.last_seq == 12345

    ctrl = ControlPayload(op=1, zone_id=3, arg_u32=0xDEADBEEF)
    cp = Packet(MSG_CONTROL, zone_id=3, stream_id=11, seq=999, payload=ctrl.pack(), timestamp=96000)
    craw = cp.pack(include_crc=False)
    cdec = parse_packet(craw)
    assert cdec["header"].msg_type == MSG_CONTROL
    cp2 = cdec["payload"]
    assert cp2.arg_u32 == 0xDEADBEEF

    # CRC rejection check
    bad = bytearray(raw)
    bad[-1] ^= 0x01
    try:
        parse_packet(bytes(bad))
        raise AssertionError("CRC corruption should fail")
    except ValueError as exc:
        assert "crc16 mismatch" in str(exc)

    # Corrupt payload length rejection check
    bad_len = bytearray(raw)
    bad_len[21] = 0x00
    bad_len[20] = 0x00
    try:
        parse_packet(bytes(bad_len))
        raise AssertionError("Payload length mismatch should fail")
    except ValueError as exc:
        assert "payload_len mismatch" in str(exc)

    print("protocol_codec_test.py: all checks passed")


if __name__ == "__main__":
    run()

