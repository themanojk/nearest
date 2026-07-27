# Backend

Public APIs, authentication, upload orchestration, analysis job management,
timeline access, and application business logic belong here.

The backend uses NestJS and owns BullMQ orchestration.

```bash
npm run infra:up
npm run dev
```

Health check: `GET http://localhost:3000/v1/health`

Analysis API:

- `POST /v1/audio-analysis`
- `POST /v1/audio-analysis/:id/complete-upload`
- `GET /v1/audio-analysis/:id`
- `GET /v1/audio-analysis/:id/segments?type=PROCESSING_REGION&page=1&limit=100`
- `GET /v1/audio-analysis/:id/transcripts?page=1&limit=100`

The backend also consumes `audio.ingest` jobs. Ingestion obtains a short-lived
object read URL and invokes FFprobe without shell interpolation. Successful
jobs retain the overall `PROCESSING` state while marking the ingestion stage
`COMPLETED`; subsequent scan stages can continue from the stored media
metadata.

Successful ingestion dispatches a deterministic `audio.scan` job. The scan
processor calls the internal Python service, replaces the analysis's prior
scan segments, and persists bounded summary data on the analysis job.
It also derives timeline-preserving `PROCESSING_REGION` records by merging
nearby speech, adding configurable context, enforcing a minimum useful region,
and clamping the result to the decoded audio duration. The source object is
never rewritten.

The scan processor also packs selected speech ranges into bounded ASR batches
and fans them out through the `speech.asr` queue. Each batch stores its source
range map. Transcription progress is aggregated on the analysis job, while
timestamped text and words are stored in `transcription_chunks`.

Lifecycle logs use stable event names such as `analysis.created`,
`analysis.upload_verified`, `ingest.started`, `ingest.probed`,
`scan.dispatched`, and `scan.completed`. Signed object URLs and audio contents
are never written to application logs.
