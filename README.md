# Auto-Announce

Networked automatic announcement system prototype.

Current prototype:
- Browser-controlled host server.
- Generated 48 kHz mono PCM test-tone source.
- UDP audio sender using the Auto-Announce v1 protocol.
- UDP telemetry listener.
- Standalone receiver simulator for another computer or local loopback.

Current dev network defaults:
- Host app / telemetry return: `192.168.10.100`
- Receiver target: `192.168.10.101`

## Run the host app

```bash
npm start
```

Open:

```text
http://127.0.0.1:8080
```

By default the browser UI binds to localhost and the telemetry listener binds to all interfaces. To expose the browser UI to another machine on the LAN:

```bash
AUTO_ANNOUNCE_HOST=0.0.0.0 AUTO_ANNOUNCE_TELEMETRY_HOST=0.0.0.0 npm start
```

## Host audio sources

The host app can send built-in generated sources, uploaded audio files, or selected macOS audio input devices. Native macOS live capture is exposed as `CoreAudio: ...` sources and is the preferred path for live input testing. The older plain device names use FFmpeg's `avfoundation` input and are kept as a fallback/comparison path.

Both live capture paths convert the selected source to the Auto-Announce v1 transport format:

```text
48 kHz mono PCM16_LE
```

The CoreAudio helper is built automatically from `tools/coreaudio_capture.swift` when the host starts or refreshes devices. On macOS, start the host from a normal Terminal/VS Code process so CoreAudio device access is available:

```bash
AUTO_ANNOUNCE_HOST=0.0.0.0 AUTO_ANNOUNCE_TELEMETRY_HOST=0.0.0.0 npm start
```

Install FFmpeg on the host computer to enable the fallback FFmpeg device listing/capture path and uploaded file decoding:

```bash
brew install ffmpeg
```

Then open the browser UI, click `Refresh` in Audio Sources, choose a `CoreAudio: ...` input device for live testing, and start UDP audio.

## Processing

The host processing path is calibration-relative. Set the powered speaker volume by ear for the zone, then use `Set Ambient Baseline` while the room is at its normal quiet/reference level. That saved receiver mic level becomes the baseline for automatic gain.

```text
ambientDeltaDb = frozenAmbientDb - baselineAmbientDb
marginBiasDb = aboveAmbientDb - 12
addedGainDb = clamp(ambientDeltaDb + marginBiasDb, 0, maxAddedGainDb)
outputGainDb = internalBaselineAudioDb + inputTrimDb + addedGainDb
```

While idle, the host averages receiver ambient telemetry. When source audio crosses the gate threshold, the host freezes the last stable ambient value so the receiver mic does not chase the announcement coming out of the speaker. The added gain is capped by `Max Add dB`, smoothed, and constrained by `Limit dB`.

For loud lobbies, the app keeps an internal attenuated baseline send level so automatic gain has headroom. The visible `Input Trim dB` control is a user-facing +/- trim around that calibrated internal level. `Above Ambient dB` is a development margin control around a 12 dB reference: 12 dB keeps the calibrated model neutral, 18 dB adds another 6 dB, and 6 dB backs it down 6 dB. The powered speaker/amplifier still needs enough acoustic headroom; DSP gain can only use the headroom that exists downstream.

For system/app audio loopback, install or use a virtual audio input such as BlackHole, Loopback, Dante Virtual Soundcard, or another CoreAudio loopback device. Once macOS exposes it as an input, it should appear in the source list. macOS may ask for microphone/input permission for Terminal, VS Code, or the app that launched the server.

## Run the receiver simulator

Local machine:

```bash
npm run receiver
```

Another computer:

```bash
npm run receiver -- --host 0.0.0.0
```

Then set the host app receiver IP to that computer's LAN IP and start UDP audio. The dev default receiver IP is `192.168.10.101`.

The receiver may be started before the host begins sending. It waits for valid audio, accepts stream start/resync packets, and re-buffers after a sender restart.

If telemetry needs an explicit return host:

```bash
npm run receiver -- --host 0.0.0.0 --telemetry-host HOST_APP_IP
```

For the current dev network:

```bash
npm run receiver -- --host 0.0.0.0 --telemetry-host 192.168.10.100
```

Python fallback, if Node/npm is not installed:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP
```

For the current dev network:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host 192.168.10.100
```

Record received network audio to a WAV file:

```bash
npm run receiver -- --host 0.0.0.0 --telemetry-host HOST_APP_IP --wav-out received.wav
```

Python fallback with WAV recording:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --wav-out received.wav
```

Stop the receiver with `Ctrl+C`, then open `received.wav` to confirm the transmitted tone/audio.

Python fallback with live playback:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play
```

Python fallback with live playback and Mac receiver ambient mic telemetry:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --ambient-mic --ambient-device 0
```

The ambient mic path uses FFmpeg `avfoundation` and sends the local mic RMS back in telemetry. If device `0` is not the MacBook internal mic, list receiver-side macOS audio devices with:

```bash
ffmpeg -hide_banner -f avfoundation -list_devices true -i ""
```

Live playback uses `ffplay` from FFmpeg or `play` from SoX if either is installed on the receiver computer. You can also record and play at the same time:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --wav-out received.wav
```

Live playback starts with a small jitter buffer before writing to the local player. The current dev defaults target low LAN latency: 80 ms start buffer, 250 ms maximum buffer, 20 ms playback writes, a 30 ms soft fade-in after playback starts or restarts, and a 30 ms fade-out if the playback buffer runs empty. After `--stream-timeout-ms` without audio, the receiver unlocks from the previous sequence and restarts the local player so a sender restart can relock cleanly. The receiver stats include:

```text
playbuf = queued playback frames
under = playback underflows
drop = old frames dropped because the local playback buffer got too large
pipe = broken local-player pipe writes
play = local player process state and exit code
```

If the host computer is under heavy load, such as compiling Homebrew packages, `under` may increase even when UDP packet loss is zero.
The receiver writes to the local playback process in 20 ms chunks by default; tune this with `--play-write-ms` if a player dislikes small or large stdin writes.
The startup/end fades can be tuned with `--play-fade-in-ms` and `--play-fade-out-ms`; use `0` to disable either one.

For FFplay on current Homebrew FFmpeg builds, this explicit command is a good macOS fallback:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --wav-out received.wav --play-command "/usr/local/Cellar/ffmpeg/8.1.2/bin/ffplay -hide_banner -loglevel info -f s16le -ar 48000 -ch_layout mono -i -"
```

If the receiver has another raw-audio playback command, pass it explicitly. The command receives 48 kHz mono PCM16_LE on stdin:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --play-command "ffplay -hide_banner -loglevel error -f s16le -ar 48000 -ch_layout mono -nodisp -i -"
```

## Protocol checks

```bash
npm test
```

## Audio capture plan

The first app scaffold uses a generated test tone so we can prove UDP streaming before OS-level capture complexity.

Likely capture path:
- macOS: BlackHole, Loopback, Dante Virtual Soundcard, or an input device exposed through CoreAudio.
- Windows: VB-CABLE, Dante Virtual Soundcard, WASAPI loopback, or an ASIO/WDM input.
- Cross-platform app integration: add an audio capture worker after the sender and receiver paths are stable.
