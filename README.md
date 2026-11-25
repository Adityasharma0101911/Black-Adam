<p align="center">
  <img src="assets/icon.png" width="128" alt="Black Adam icon">
</p>

<h1 align="center">Black Adam</h1>

<p align="center">
  Identify any song playing on your computer, straight from system audio. No mic, no API keys, no accounts.
</p>

<p align="center">
  <a href="https://github.com/Adityasharma0101911/Black-Adam/actions/workflows/build.yml"><img src="https://github.com/Adityasharma0101911/Black-Adam/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/Adityasharma0101911/Black-Adam/releases"><img src="https://img.shields.io/github/v/release/Adityasharma0101911/Black-Adam" alt="Release"></a>
  <img src="https://img.shields.io/badge/python-3.10-blue" alt="Python 3.10">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="GPL-3.0"></a>
</p>

---

## What it does

Black Adam records a few seconds of whatever your computer is playing (Spotify, YouTube, a game, a stream) and tells you what song it is. It listens to the audio output directly, so background noise and a missing microphone don't matter.

- **System-audio capture**: loopback recording from your speakers/headphones output
- **Pick your device**: choose which output to listen to, with a live level meter
- **Rich results**: title, artist, album art, and one-click Spotify and YouTube links
- **Recent history**: your last 10 identified songs
- **Free and unlimited**: powered by [ShazamIO](https://github.com/shazamio/ShazamIO), no API key needed
- **Cross-platform builds**: Windows `.exe`, macOS `.dmg`, Linux `.tar.gz`

## Download

Grab the latest build from [Releases](https://github.com/Adityasharma0101911/Black-Adam/releases), or the newest artifacts from the [Actions tab](https://github.com/Adityasharma0101911/Black-Adam/actions).

| Platform | File | Notes |
|----------|------|-------|
| Windows | `BlackAdam.exe` | Works out of the box (WASAPI loopback) |
| macOS | `BlackAdam-macOS.dmg` | Needs [BlackHole](https://github.com/ExistentialAudio/BlackHole) plus a Multi-Output Device in Audio MIDI Setup |
| Linux | `BlackAdam-Linux.tar.gz` | Needs PulseAudio or PipeWire with monitor sources |

## Run from source

```bash
git clone https://github.com/Adityasharma0101911/Black-Adam.git
cd Black-Adam
pip install -r requirements.txt
python main.py
```

Requires Python 3.10+. Settings such as recording length live in [`config.py`](config.py).

## Build

```bash
pip install pyinstaller
python build.py
```

The output lands in `dist/`. GitHub Actions builds all three platforms on every push to `main` (see [`.github/workflows/build.yml`](.github/workflows/build.yml)).

To regenerate the app icon: `python assets/make_icon.py`.

## How it works

1. **Capture**: [`soundcard`](https://github.com/bastibe/SoundCard) opens a loopback device that mirrors your selected output and records about 5 seconds of audio at 16 kHz ([`src/audio_capture.py`](src/audio_capture.py)).
2. **Recognize**: the clip is written to a temporary WAV and fingerprinted by ShazamIO against Shazam's catalogue ([`src/api_client.py`](src/api_client.py)).
3. **Display**: matches render as cards in a PySide6 interface, with album art loaded in the background ([`src/ui/app_pyside.py`](src/ui/app_pyside.py)).

## Tech stack

| Layer | Tool |
|-------|------|
| Language | Python 3.10 |
| UI | PySide6 (Qt 6) |
| Audio | soundcard, NumPy |
| Recognition | ShazamIO |
| Images | Pillow, requests |
| Packaging | PyInstaller, GitHub Actions |

## Project layout

```
main.py                 entry point and dependency check
config.py               recording and window settings
src/audio_capture.py    loopback capture
src/api_client.py       ShazamIO client
src/models/song.py      SongMatch model
src/ui/app_pyside.py    current UI
src/ui/app.py           legacy CustomTkinter UI
assets/                 icon and icon generator
BlackAdam.spec          PyInstaller config
```

## Author

**Aditya Sharma**: [GitHub](https://github.com/Adityasharma0101911) · [Portfolio](https://adityasharma0101.vercel.app)

## License

[GNU GPL v3](LICENSE)
