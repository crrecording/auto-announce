# Auto-Announce

Networked automatic announcement system prototype.

Current prototype:
- Browser-controlled host server.
- Generated 48 kHz mono PCM test-tone source.
- UDP audio sender using the Auto-Announce v1 protocol.
- UDP telemetry listener.
- Standalone receiver simulator for another computer or local loopback.

## Run the host app

```bash
npm start
```

Open:

```text
http://127.0.0.1:8080
```

By default the browser UI and telemetry listener bind to localhost. To expose the browser UI and telemetry listener to another machine on the LAN:

```bash
AUTO_ANNOUNCE_HOST=0.0.0.0 AUTO_ANNOUNCE_TELEMETRY_HOST=0.0.0.0 npm start
```

## Host audio sources

The host app can send either the built-in test tone or a selected macOS audio input device. Device capture uses FFmpeg's `avfoundation` input and converts the selected source to the Auto-Announce v1 transport format:

```text
48 kHz mono PCM16_LE
```

Install FFmpeg on the host computer to enable device listing and capture:

```bash
brew install ffmpeg
```

Then open the browser UI, click `Refresh` in Audio Sources, choose the input device, and start UDP audio.

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

Then set the host app receiver IP to that computer's LAN IP and start UDP audio.

If telemetry needs an explicit return host:

```bash
npm run receiver -- --host 0.0.0.0 --telemetry-host HOST_APP_IP
```

Python fallback, if Node/npm is not installed:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP
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

Live playback uses `ffplay` from FFmpeg or `play` from SoX if either is installed on the receiver computer. You can also record and play at the same time:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --wav-out received.wav
```

Live playback starts with a small jitter buffer before writing to the local player. The receiver stats include:

```text
playbuf = queued playback frames
under = playback underflows
drop = old frames dropped because the local playback buffer got too large
pipe = broken local-player pipe writes
play = local player process state and exit code
```

If the host computer is under heavy load, such as compiling Homebrew packages, `under` may increase even when UDP packet loss is zero.
The receiver writes to the local playback process in 100 ms chunks by default; tune this with `--play-write-ms` if a player dislikes small or large stdin writes.

For FFplay on current Homebrew FFmpeg builds, this explicit command is a good macOS fallback:

```bash
python3 receiver_py.py --host 0.0.0.0 --telemetry-host HOST_APP_IP --play --wav-out received.wav --play-write-ms 100 --play-command "/usr/local/Cellar/ffmpeg/8.1.2/bin/ffplay -hide_banner -loglevel info -f s16le -ar 48000 -ch_layout mono -i -"
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
