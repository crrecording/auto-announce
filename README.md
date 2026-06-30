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
