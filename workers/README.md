# Workers

Asynchronous audio-processing and machine-learning workloads belong here,
including ingestion, VAD, acoustic-event detection, ASR, diarization,
classification, risk aggregation, and timeline finalization.

Python workers expose internal inference APIs. BullMQ job ownership remains in
the NestJS backend so queue behavior is not duplicated across runtimes.

```bash
uv sync
uv run uvicorn audio_workers.main:app --reload
```

Health check: `GET http://localhost:8000/health`

Tier-1 scan: `POST http://localhost:8000/v1/scan`

Selective transcription: `POST http://localhost:8000/v1/transcribe`

Acoustic-event detection:
`POST http://localhost:8000/v1/detect-acoustic-events`

The initial scan implementation:

- streams FFmpeg decode rather than materializing normalized audio;
- converts the first audio stream to mono 16 kHz signed PCM;
- produces configurable logical windows with overlap;
- emits WebRTC VAD speech candidates and energy-based quality labels;
- rejects source URLs whose hosts are not explicitly allowed.

The `webrtc-vad/1.0.0` pipeline uses WebRTC voice activity detection for
speech gating while retaining RMS/peak measurements for the overview chart. It
must be calibrated or replaced by a trained VAD/acoustic model before product
quality claims are made.

The transcription endpoint concatenates only the requested source ranges into
a temporary mono 16 kHz WAV, runs local multilingual Faster Whisper, maps word
timestamps through the supplied edit map back to the source timeline, and
removes the temporary clip after the request.

ASR sources are normalized once per analysis into a worker-local, six-hour
cache. ASR chunks retain continuous source audio and natural pauses rather
than stitching distant speech fragments together. The multilingual preset
uses `large-v3-turbo`, batched inference, beam size 3, and a final Silero VAD
pass. If VAD retains less than
15% of an already-selected chunk, the worker retries that chunk without VAD
to protect quiet speech. Auto mode retries suspicious language detection with
Hindi/Hinglish- and English-biased decoding, and repeated-token hallucinations
are rejected.
Every response reports extraction, inference, pre-VAD, and post-VAD timings.

For GPU workers, set `WORKER_ASR_DEVICE=cuda` and select a supported
CTranslate2 compute type for the installed hardware. Queue concurrency and
model worker count are independently configurable with
`ASR_QUEUE_CONCURRENCY` and `WORKER_ASR_NUM_WORKERS`.

The acoustic endpoint applies the local AudioSet-trained Zipformer tagger to
10-second windows of the selected ranges. Candidate alarms, distress sounds,
health sounds, impacts, and hazards are mapped through the supplied edit map
to the original recording timeline. These are screening candidates rather
than verified incidents.
