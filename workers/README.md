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

Readiness check: `GET http://localhost:8000/ready`. Readiness requires FFmpeg,
a locally available ASR model, the diarization and acoustic ONNX models, the
acoustic label file, and a writable normalized-audio cache. It returns HTTP 503
while any dependency is missing and never downloads a model during the probe.

Set `WORKER_API_TOKEN` in both the backend and worker environments to require
`Authorization: Bearer ...` on inference endpoints. Health and readiness remain
unauthenticated for orchestrator probes.

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

Transcription and diarization share the normalized source cache. The cache key
includes the analysis identifier and stable source location while excluding
rotating signed-URL query credentials.

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

`AUTO` and `HINDI_HINGLISH` decoding also receive a compact, versioned hotword
lexicon for short or softly spoken Hindi/Hinglish safety terms such as `saale`,
`badtameez`, and `kameena`. Edit `lexicons/hi_hinglish_safety.tsv` to add a
canonical term and its ASR spelling or script variants. Use
`WORKER_ASR_HOTWORDS_PATH` only to select a different lexicon file. Explicit
English decoding does not receive these hints. Hotwords improve vocabulary
recall but do not guarantee detection and must be evaluated against clean
negative audio for false positives.

For GPU workers, set `WORKER_ASR_DEVICE=cuda` and select a supported
CTranslate2 compute type for the installed hardware. Queue concurrency and
model worker count are independently configurable with
`ASR_QUEUE_CONCURRENCY` and `WORKER_ASR_NUM_WORKERS`.

## ASR and safety evaluation

Decoder hints are applied only during a selective retry after the neutral pass
looks unreliable. A low-confidence word, wrong script/language, empty result,
or repetitive output can trigger that retry. This keeps vocabulary hints from
biasing every clean transcription.

Use a JSONL manifest to measure exact safety-term recall and downstream signal
precision/recall against representative, consented audio:

```json
{"id":"quiet-saale-01","audioPath":"audio/quiet-saale-01.wav","startMs":0,"endMs":2400,"languageMode":"AUTO","referenceText":"abe saale idhar aa","expectedTerms":["saale"],"expectedSignals":["insult"]}
```

The audio must be mono 16 kHz PCM WAV, matching the normalized ASR cache.

```bash
uv run python scripts/evaluate_asr_manifest.py evaluation/cases.jsonl
```

For an initial synthetic regression corpus on macOS, generate adult Hindi and
Indian-English TTS across clean, quiet, fast, and noisy profiles:

```bash
uv run python scripts/generate_synthetic_hinglish_corpus.py
```

This creates 120 local clips with development and held-out manifests under
`evaluation/`. The generated audio and reports are ignored by Git. Synthetic
speech is useful for repeatable regression tests, but it is not evidence of
accuracy on children, spontaneous conversation, regional accents, or real
recording environments.

Keep separate development and held-out manifests. Do not add child recordings
or identifying transcripts to Git. The resulting error set should guide model
selection or domain adaptation; the decoder lexicon is only a bounded fallback,
not the primary abuse detector.

The acoustic endpoint applies the local AudioSet-trained Zipformer tagger to
10-second windows of the selected ranges. Candidate alarms, distress sounds,
health sounds, impacts, and hazards are mapped through the supplied edit map
to the original recording timeline. These are screening candidates rather
than verified incidents.

## Child-safety transcript rules (context model 1.4.0)

`src/audio_workers/safety_rules.py` extends English, Hindi and Hinglish review
cues: insults/bullying, direct threats, physical-harm disclosures, unwanted
contact, secrecy, inappropriate personal requests, coercion/blackmail, unsafe
contact/password requests, substance pressure, possible unmet care needs,
physical distress, self-harm-related language and immediate danger.

These phrase rules are not comprehensive language understanding or a guarantee
of child safety. Missing or incorrect ASR words can still be missed. Timestamps
cover the source utterance, not individual words. Child involvement remains
unconfirmed. Rule confidence scores are not calibrated probabilities.

Insults produce medium-priority review cues. Bare English `sale` is excluded;
directed phrases such as `abe sale` are covered. Profanity retains per-session
thresholds: one severe, two moderate, or three total occurrences. Educational
frames downgrade safety cues to low priority; reported disclosures remain
reviewable. Negation handling is narrow; grammar and sarcasm can cause errors.

Rebuild/restart the worker to load the new rules. Previously completed recordings
require context and downstream risk re-analysis; no historical jobs are
re-run automatically. Review the corresponding audio to interpret findings.

Validation: `pytest tests/test_context.py tests/test_child_safety_rules.py`.
