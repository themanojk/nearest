# Kid Audio Intelligence System

This repository contains the NearNest backend, browser and mobile clients,
audio-processing workers, and ESP32 firmware. This is the single source of
first-party setup and operating documentation for the repository.

## Repository structure

```text
.
├── backend/             # API, authentication, queues, and persistence
├── frontend/            # Browser upload and analysis dashboard
├── mobile/              # Bare React Native parent application
├── workers/             # Python audio and ML inference service
├── NearNestFirmware/    # Arduino ESP32 firmware
└── NearNestFirmwareIdf/ # ESP-IDF wrapper for the Arduino firmware
```

Each component owns its dependencies, configuration, tests, and build output.
Shared packages can be introduced later under a root-level `packages/`
directory when concrete shared code exists.

## Requirements

- Node.js 22 LTS or 24 LTS
- npm 10 or newer
- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/) for Python dependency management
- Docker with Compose
- FFmpeg/FFprobe 7 or newer

New firmware recordings use 16 kHz mono input (16-bit PCM), encoded on the ESP
as 64 kbps MP3 for smaller transfers. Existing WAV and FLAC files remain
supported. Firmware build and hardware validation instructions are included
below.

The backend also needs FFmpeg for mobile playback of FLAC recordings. Set
`FFMPEG_PATH` if `ffmpeg` is not on its PATH. The first playback request creates
a cached PCM WAV copy; later requests reuse it. Original FLAC uploads remain
unchanged, and deleting audio removes both copies. Existing FLAC imports use
this path automatically after restarting the updated backend.

## Getting started

```bash
cp .env.example .env
npm install
npm run install:workers
npm run infra:up
```

Run each service in a separate terminal:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:workers
```

Open `http://localhost:5173` to upload a recording and follow upload,
ingestion, Tier-1 scan, and selective-ASR progress. The dashboard polls the backend once per
second while work is active and shows media metadata, a full-recording RMS/peak
dBFS overview, and detected processing regions when available.

The default local endpoints are:

- Backend health: `http://localhost:3000/v1/health`
- Frontend: `http://localhost:5173`
- Worker health: `http://localhost:8000/health`
- MongoDB: `mongodb://localhost:57017/kid_audio`
- Redis: `localhost:56379`
- MinIO API/console: `http://localhost:59000` / `http://localhost:59001`

The ports above are repository defaults. Values in `.env`, including
`BACKEND_PORT`, may override them. Keep `S3_PUBLIC_ENDPOINT` reachable from the
browser or phone performing the upload. Use `http://localhost:59000` for a
browser running on the development machine; use the machine's current LAN IP
or an HTTPS hostname for a physical phone.

## Worker model installation

The ONNX binaries are intentionally Git-ignored and must be provisioned on
every worker machine. Run these commands from the repository root after
`npm run install:workers`.

Download the speaker-embedding model:

```bash
curl --fail --location \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" \
  --output workers/models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
```

Download and install the quantized acoustic-tagging model:

```bash
curl --fail --location \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2" \
  --output /tmp/nearnest-audio-tagging.tar.bz2

mkdir -p /tmp/nearnest-audio-tagging

tar -xjf /tmp/nearnest-audio-tagging.tar.bz2 \
  -C /tmp/nearnest-audio-tagging \
  sherpa-onnx-zipformer-small-audio-tagging-2024-04-15/model.int8.onnx

install -m 644 \
  /tmp/nearnest-audio-tagging/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15/model.int8.onnx \
  workers/models/audio-tagging/model.int8.onnx
```

Verify the installed files:

```bash
shasum -a 256 \
  workers/models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
  workers/models/audio-tagging/model.int8.onnx
```

Expected SHA-256 hashes:

```text
aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2  workers/models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
69304b8a1b96bbe6b7d16c24079f0732c65faf3568a14cb82a8238c709afe76c  workers/models/audio-tagging/model.int8.onnx
```

Faster Whisper downloads and caches its ASR model independently when it first
initializes. Start the worker and verify all dependencies:

```bash
npm run dev:workers
curl http://localhost:8000/ready
```

The readiness response must report `"status":"ready"`. A `503` response lists
the missing dependency under `checks`.

## First API workflow

Create an analysis and request an upload URL:

```bash
curl -X POST http://localhost:3000/v1/audio-analysis \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <access-token>' \
  -d '{
    "childId": "child-001",
    "fileName": "recording.m4a",
    "contentType": "audio/mp4",
    "sizeBytes": 123456
  }'
```

Upload the exact number of bytes declared in the request to the returned
presigned URL. Then call:

```bash
curl -X POST \
  -H 'Authorization: Bearer <access-token>' \
  http://localhost:3000/v1/audio-analysis/{analysisId}/complete-upload
```

Obtain the access token through `POST /v1/auth/otp/send` followed by
`POST /v1/auth/otp/verify`. Lower environments use the fixed OTP `1234`.

Wearable recordings use BLE only for control messages. For bulk data, the ESP
creates an isolated one-client WPA2 hotspot with no internet route. The phone
caches resumable 10 MiB ranges, leaves the hotspot, and uploads them through
its normal internet connection, so an interrupted 500 MB sync continues from
missing chunks instead of restarting the complete file.

### Wearable transfer implementation and performance

Android uses a hybrid UDP/TCP transfer over the private ESP hotspot:

1. BLE discovers the wearable, lists finalized recordings, and returns
   temporary hotspot credentials plus a transfer token.
2. The phone joins the hotspot and requests each 10 MiB range from
   `GET /v1/recording/udp`.
3. UDP packets include a session ID, sequence number, payload length, and
   CRC32. The phone writes in-order packets in 64 KiB batches.
4. After the UDP range ends, the phone identifies missing or corrupt packet
   runs and repairs only those byte ranges over
   `GET /v1/recording`.
5. The phone leaves the hotspot, restores internet access, uploads the cached
   parts to the backend, completes the multipart upload, and only then sends
   `recording.release`.

iOS currently keeps the resumable TCP range path. BLE carries credentials and
commands only; audio never travels over BLE.

Physical testing on the current ESP32 and SPI-wired SD card produced:

- UDP RAM/network capacity: approximately 2.3–2.6 MiB/s.
- Original recording transfer: approximately 0.74 MiB/s.
- Optimized recording transfer: approximately 1.2–1.39 MiB/s, with zero
  missing or corrupt packets in the measured short runs.

The optimized firmware uses aligned double buffering, separate SD and UDP
tasks on the two ESP cores, direct FAT reads, ROM CRC32, watchdog-safe
scheduling, and explicit task cleanup. The current SPI SD path cannot
guarantee the 1.5 MiB/s product target. Reaching that target requires migrating
the card to the ESP32 SDMMC host:

| SD signal | ESP32 GPIO |
| --- | --- |
| CLK | 14 |
| CMD | 15 |
| DAT0 | 2 |
| DAT1 | 4 |
| DAT2 | 12 |
| DAT3 | 13 |

One-bit SDMMC uses CLK, CMD, and DAT0. Four-bit mode additionally uses DAT1,
DAT2, and DAT3 and is preferred when the SD socket exposes every data line.
CMD and all connected DAT lines require suitable pull-ups. The checked-in
firmware still uses SPI until the hardware is rewired and SDMMC is enabled.

The completion endpoint verifies the object before submitting a deterministic
BullMQ ingestion job. Repeating the request does not create a second job. The
ingestion worker probes the object over a short-lived read URL, so the backend
does not load the complete recording into memory, and persists duration,
container, bitrate, size, codec, sample-rate, and channel metadata.

After ingestion, the backend dispatches an `audio.scan` job to the Python
service. Tier 1 streams FFmpeg-decoded mono 16 kHz PCM, generates overlapping
logical windows, runs WebRTC VAD, and stores scan windows and
merged speech intervals in MongoDB. This baseline identifies candidates for
later processing; it is not presented as a trained speech or acoustic-event
classifier.

The backend then performs logical silence trimming. Nearby speech intervals are
merged, padded with context, clamped to the source duration, and stored as
`PROCESSING_REGION` records for selective downstream transcription. Timestamps
remain relative to the original recording and the source audio is not modified.

ASR-ready regions are packed into bounded speech-only batches and dispatched to
the `speech.asr` queue with concurrency and retries. The Python worker extracts
only each selected source range and uses local Faster Whisper for multilingual
transcription. Each batch retains an edit map for its discontinuous source
ranges, so chunk text, language, confidence, and word timestamps are stored in
MongoDB using the original recording timeline.

With the backend and infrastructure running, exercise the workflow using:

```bash
npm run smoke:upload
```

## Service boundary

The backend owns API and BullMQ orchestration. Python workers expose
model-oriented inference operations; queue processors call those operations
using versioned internal contracts. This keeps queue semantics in Node while
allowing the ML runtime to remain Python-native.

## Backend

The NestJS backend owns authentication, upload orchestration, BullMQ jobs,
analysis state, timeline access, and application business logic.

```bash
npm run infra:up
npm run dev:backend
```

### Authentication

The main authentication routes are:

- `POST /v1/auth/otp/send`
- `POST /v1/auth/otp/verify`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/users/me`
- `PATCH /v1/users/me`

Local development uses `AUTH_OTP_DELIVERY_MODE=development` and the fixed code
configured by `AUTH_DEVELOPMENT_OTP_CODE` (`1234` by default). Set delivery to
`disabled` outside lower environments until an SMS or email adapter is
configured. OTPs are HMAC-hashed, access tokens are short-lived JWTs, and
opaque refresh tokens are stored as SHA-256 hashes and rotated on use.

Child profile routes require a bearer token and are scoped to the authenticated
parent. Standard deletion archives a profile rather than physically deleting
it. The routes include:

- `POST /v1/children`
- `GET /v1/children`
- `GET`, `PATCH`, and `DELETE /v1/children/:childId`
- `PATCH /v1/children/:childId/analysis-preferences`
- `PATCH /v1/children/:childId/retention-preferences`

### Device provisioning and pairing

Wearable identities must be provisioned before shipment. The backend stores
only the Ed25519 public key; the private key remains on the device.

```bash
DEVICE_ROOT_CA_FILE=./object-storage-root-ca.pem \
  npm run device:identity --workspace backend -- NN-000001 rev-a 2.4.0

MONGODB_URI=mongodb://localhost:57017/kid_audio \
  npm run device:provision --workspace backend -- \
  NN-000001 NearNestFirmware/NN-000001.public.pem rev-a 2.4.0
```

Provisioning is insert-only. Pairing sessions expire after 10 minutes;
challenges expire after 2 minutes, are single-use, and allow five attempts.
Device routes cover pairing-session creation, discovery, challenge completion,
device listing, updates, unpairing, and lost-device marking.

### Uploads and analysis

Analysis routes require `Authorization: Bearer <access-token>`. Browser uploads
use one presigned `PUT`. Wearable uploads use resumable multipart transfer:

1. Create the analysis with `uploadMode: "MULTIPART"`.
2. `POST /v1/audio-analysis/:id/multipart/parts` issues URLs for selected
   10 MiB parts.
3. `GET /v1/audio-analysis/:id/multipart` reports persisted parts.
4. `POST /v1/audio-analysis/:id/multipart/complete` verifies and assembles the
   object before processing.
5. `DELETE /v1/audio-analysis/:id/multipart` abandons the upload.

Set `S3_PUBLIC_ENDPOINT` to a URL reachable by the uploading client. The ESP
never receives cloud credentials or object-storage URLs; the phone uploads
after leaving the wearable's isolated hotspot.

The processing chain is ingestion, Tier-1 scan, selective ASR, speaker
diarization, context classification, acoustic-event detection, and risk
aggregation. Lifecycle logs use stable event names and redact credentials,
OTPs, profile data, device signatures, and signed URLs. Use `LOG_LEVEL=debug`
locally and `LOG_LEVEL=info` in production.

## Browser frontend

The React/Vite frontend supports presigned uploads, live stage polling,
recording-level quality charts, transcripts, speaker analysis, acoustic events,
and risk review.

```bash
npm run dev:frontend
```

Open `http://localhost:5173`. `VITE_API_BASE_URL` selects the backend API; the
repository default follows the local backend configuration. If the browser
reports an object-upload network error, verify that the hostname embedded in
`S3_PUBLIC_ENDPOINT` is reachable from that browser and that it matches the
origin allowed by MinIO.

## Python workers

The FastAPI worker provides internal model-oriented endpoints while BullMQ
ownership stays in the backend:

- `GET /health`
- `GET /ready`
- `POST /v1/scan`
- `POST /v1/transcribe`
- `POST /v1/diarize`
- `POST /v1/detect-acoustic-events`

Set the same `WORKER_API_TOKEN` in the backend and worker environments to
require bearer authentication on inference endpoints. Health and readiness
remain unauthenticated.

The scan streams FFmpeg-decoded mono 16 kHz PCM, produces logical windows,
uses WebRTC VAD for speech gating, and retains RMS/peak measurements. This is a
candidate-selection baseline, not a calibrated speech classifier.

Selective transcription uses multilingual Faster Whisper and maps word times
back to the source recording through an edit map. Normalized audio is cached
and shared with diarization. `AUTO` and `HINDI_HINGLISH` perform a neutral pass
first and use the versioned `workers/lexicons/hi_hinglish_safety.tsv` only for
a targeted low-quality retry. The lexicon is a bounded decoder fallback, not
the primary abuse detector.

For GPU machines, set `WORKER_ASR_DEVICE=cuda` and a CTranslate2-compatible
compute type. `ASR_QUEUE_CONCURRENCY` and `WORKER_ASR_NUM_WORKERS` tune queue
and model concurrency independently.

### ASR and safety evaluation

Generate the synthetic Hindi/Hinglish regression corpus on macOS:

```bash
cd workers
uv run python scripts/generate_synthetic_hinglish_corpus.py
```

Evaluate a manifest:

```bash
uv run python scripts/evaluate_asr_manifest.py evaluation/heldout.jsonl
```

Manifests contain `audioPath`, `referenceText`, `expectedTerms`, and
`expectedSignals`. Keep development and held-out data separate. Synthetic
adult speech is useful for regression but does not establish accuracy on
children, spontaneous conversation, accents, or real recording conditions.
Never add child recordings or identifying transcripts to Git.

Child-safety rules produce review cues, not confirmed events or calibrated
probabilities. Missing ASR words, negation, grammar, sarcasm, and educational
context can change results. Review the source audio before interpreting a cue.

## Mobile application

`mobile/` is a bare React Native application outside the npm workspaces. Bare
React Native is required for BLE, Wi-Fi hotspot, secure storage, and native
audio playback. The default `BleWifiTransport` performs authenticated pairing,
challenge signing, recording control, and hotspot transfer. The
`SimulatedTransport` is only for explicit UI previews and tests.

Requirements:

- Node 22.19.0 (`nvm use`)
- Xcode and CocoaPods for iOS
- JDK 17 and the Android SDK for Android
- A UTF-8 locale for CocoaPods with Ruby 3.4

Setup from `mobile/`:

```bash
nvm use
npm install
npx react-native-asset
cd ios
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install
cd ..
```

Run Metro and one native target in separate terminals:

```bash
npm start
npm run ios
# or
npm run android
```

For a USB-connected Android device, forward the backend and Metro ports:

```bash
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
```

Use the configured backend port instead of `3000` when `.env` overrides it.
Physical phones otherwise require the laptop's current LAN address. Production
builds must use reachable HTTPS endpoints.

iOS hotspot joining must be tested on a physical iPhone. Enable the Hotspot
Configuration capability for the App ID and provisioning profiles. Access and
refresh tokens are stored through `react-native-keychain`. Bulk audio never
travels over BLE; the phone transfers ranges from the ESP hotspot and uploads
them after restoring internet connectivity.

The imported-recording debugger is available under **Profile → Imported
recordings (debug)**. Audio deletion is permanent for the uploaded source but
retains reports and diagnostic metadata. Native playback changes require a
fresh Android/iOS build; Metro reload cannot install native methods.

## ESP32 Arduino firmware

`NearNestFirmware/` records 16 kHz mono audio, advertises the BLE control
service, signs pairing challenges with a provisioned Ed25519 identity, and
serves finalized recording ranges over an isolated one-client WPA2 hotspot.
Audio never travels over BLE, and the ESP receives no router credentials.

Required Arduino dependencies:

- Espressif ESP32 board package 3.2.1
- ArduinoJson 7.4.2
- NimBLE-Arduino 2.3.2
- TinyGPSPlus 1.0.3
- Adafruit NeoPixel 1.12.x
- Crypto 0.4.0 with `Ed25519.h`

Use the **Minimal SPIFFS (1.9 MB APP with OTA/190 KB SPIFFS)** partition on a
standard 4 MB ESP32. Build from the repository root:

```bash
arduino-cli compile \
  --fqbn esp32:esp32:esp32:PartitionScheme=min_spiffs \
  NearNestFirmware
```

Run host validation with a C/C++ compiler, FFmpeg, and FFprobe installed:

```bash
python3 NearNestFirmware/tests/test_mp3.py
python3 NearNestFirmware/tests/test_recording_header.py
python3 NearNestFirmware/tests/test_shine_memory.py
```

`NearNestBuildConfig.h` selects MP3, FLAC, or WAV. MP3 defaults to mono
64 kbps and uses approximately 480 KB/minute. `NEARNEST_AUDIO_GAIN_PERCENT`
defaults to `400` (approximately +12 dB) with a soft limiter. Validate speech,
background sounds, file beginnings/endings, real-time encoding headroom, and
SD error recovery on hardware before relying on a build.

The production build deletes a recording only after explicit
`recording.release` following durable backend multipart completion. Never ship
the placeholder keys from `device_secrets.example.h`; production devices need
secure boot and flash encryption or a supported secure element.

### BLE, transfer, and hardware

The BLE service UUID is `8ec90001-f315-4f60-9fb8-838830daea50`. Identity is
read-only; command writes and status reads/notifications require authenticated
encryption. Commands use framed UTF-8 JSON: write `BEGIN:<byte-length>`, then
send the JSON bytes in MTU-sized chunks.

Android uses hybrid UDP transfer with TCP repair; iOS uses resumable TCP
ranges. Current SPI-SD measurements are approximately 1.2–1.39 MiB/s, below
the 1.5 MiB/s target. SDMMC migration uses:

| SD signal | ESP32 GPIO |
| --- | --- |
| CLK | 14 |
| CMD | 15 |
| DAT0 | 2 |
| DAT1 | 4 |
| DAT2 | 12 |
| DAT3 | 13 |

One-bit mode needs CLK, CMD, and DAT0. Four-bit mode is preferred when all data
lines are available. Do not enable SDMMC until the hardware is rewired and
appropriate pull-ups are fitted.

The local button is GPIO 27 (`INPUT_PULLUP`) and the WS2812 data pin is GPIO
21. A single press starts or checkpoints recording, a double press restarts,
a 3–5 second hold enters pairing, and a 5-second hold saves and sleeps.

### Vendored Shine encoder

The bundled Shine MP3 source comes from
`https://github.com/toots/shine` revision
`ab5e3526b64af1a2eaa43aa6f441a7312e013519` under GNU LGPL v2. Local changes
reduce encoder state for 16 kHz mono operation, move the quantization table to
flash, validate allocations, and expose state-size diagnostics. Its separate
license and upstream provenance files remain with the vendored source.

## ESP-IDF firmware build

`NearNestFirmwareIdf/` builds the Arduino implementation as an ESP-IDF
application with Arduino as a managed component. The Arduino sketch remains
the source of truth.

```bash
source ~/esp/esp-idf-v5.5.4/export.sh
cd NearNestFirmwareIdf
idf.py set-target esp32
idf.py build
```

Source the export script in every new terminal. To find a serial port on macOS
and flash:

```bash
ls /dev/cu.usbserial* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* 2>/dev/null
idf.py -p /dev/cu.usbserial-0001 flash monitor
```

Exit the monitor with `Ctrl+]`. Do not run `idf.py erase-flash` during
migration because NVS stores recording sequence and BLE bonding state. The
generated image is `NearNestFirmwareIdf/build/nearnest_firmware.bin`.

## Validation

Run repository checks from the root:

```bash
npm test
npm run typecheck
npm run lint
```

Worker-only checks can be run from `workers/`:

```bash
uv run pytest
uv run mypy src tests
uv run ruff check .
```
