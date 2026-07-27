# Kid Audio Intelligence System

This repository is organized as a monorepo containing the application API,
user interface, and asynchronous audio-processing workers.

## Repository structure

```text
.
├── backend/   # Public API, orchestration, persistence, and business logic
├── frontend/  # Web application and review timeline
└── workers/   # Audio, speech, ML inference, and background workers
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

## Getting started

```bash
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

## First API workflow

Create an analysis and request an upload URL:

```bash
curl -X POST http://localhost:3000/v1/audio-analysis \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: local-dev' \
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
  -H 'x-tenant-id: local-dev' \
  http://localhost:3000/v1/audio-analysis/{analysisId}/complete-upload
```

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
