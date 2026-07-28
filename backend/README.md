# Backend

Public APIs, authentication, upload orchestration, analysis job management,
timeline access, and application business logic belong here.

The backend uses NestJS and owns BullMQ orchestration.

```bash
npm run infra:up
npm run dev
```

Health check: `GET http://localhost:3000/v1/health`

Authentication API:

- `POST /v1/auth/otp/send`
- `POST /v1/auth/otp/verify`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/users/me`
- `PATCH /v1/users/me`

Local development uses `AUTH_OTP_DELIVERY_MODE=development` and the fixed code
configured by `AUTH_DEVELOPMENT_OTP_CODE` (`1234` by default); the OTP send
response includes `developmentCode`. Set the mode to `disabled` outside lower
environments until an SMS or email delivery adapter is configured. OTP codes
are HMAC-hashed in MongoDB, access tokens are short-lived signed JWTs, and
opaque refresh tokens are stored only as SHA-256 hashes and rotated on use.

Child profile API:

- `POST /v1/children`
- `GET /v1/children`
- `GET /v1/children/:childId`
- `PATCH /v1/children/:childId`
- `DELETE /v1/children/:childId`
- `PATCH /v1/children/:childId/analysis-preferences`
- `PATCH /v1/children/:childId/retention-preferences`

User and child-profile routes require `Authorization: Bearer <access-token>`.
Child profiles are scoped to the authenticated parent and are archived rather
than physically deleted by the standard delete endpoint.

Device provisioning and pairing:

- `POST /v1/device-pairing-sessions`
- `POST /v1/device-pairing-sessions/:id/discover`
- `POST /v1/device-pairing-sessions/:id/challenge`
- `POST /v1/device-pairing-sessions/:id/complete`
- `GET /v1/devices`
- `GET /v1/devices/:deviceId`
- `PATCH /v1/devices/:deviceId`
- `POST /v1/devices/:deviceId/unpair`
- `POST /v1/devices/:deviceId/mark-lost`

Wearable identities must be provisioned before shipment. The API stores only
the Ed25519 public key; the private key remains on the device:

```bash
DEVICE_ROOT_CA_FILE=./object-storage-root-ca.pem \
  npm run device:identity --workspace backend -- NN-000001 rev-a 2.4.0

MONGODB_URI=mongodb://localhost:57017/kid_audio \
  npm run device:provision --workspace backend -- \
  NN-000001 ../NearNestFirmware/NN-000001.public.pem rev-a 2.4.0
```

Provisioning is insert-only, so rerunning it cannot replace the identity key
for an existing serial. Pairing sessions expire after 10 minutes, challenges
expire after 2 minutes, and each challenge is single-use with a five-attempt
limit.

Analysis API:

- `POST /v1/audio-analysis`
- `POST /v1/audio-analysis/:id/complete-upload`
- `GET /v1/audio-analysis/:id`
- `GET /v1/audio-analysis/:id/segments?type=PROCESSING_REGION&page=1&limit=100`
- `GET /v1/audio-analysis/:id/transcripts?page=1&limit=100`

All analysis routes require `Authorization: Bearer <access-token>` and scope
stored analysis jobs to the authenticated parent.

Wearable audio uses resumable Wi-Fi multipart upload:

- Create the analysis with `uploadMode: "MULTIPART"`.
- `POST /v1/audio-analysis/:id/multipart/parts` issues short-lived URLs for
  selected 10 MiB parts.
- `GET /v1/audio-analysis/:id/multipart` reports parts persisted by object
  storage, allowing interrupted transfers to resume.
- `POST /v1/audio-analysis/:id/multipart/complete` assembles the object only
  after every declared byte is present and starts processing.
- `DELETE /v1/audio-analysis/:id/multipart` explicitly abandons an upload.

The wearable sends audio bytes directly from SD storage to the presigned object
storage URLs over Wi-Fi. BLE carries only control messages and part manifests.
Set `S3_PUBLIC_ENDPOINT` to an HTTPS hostname reachable by the wearable.
`localhost` is suitable only for simulator/browser testing.

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

Every HTTP route also emits structured lifecycle logs:

- `http.request.started` at debug level includes the request ID, route,
  authenticated user ID, and sanitized request metadata.
- `http.request.completed` at info level includes the response status and
  duration. Client failures are warnings and server failures are errors.
- The incoming `X-Request-Id` is preserved when valid; otherwise the backend
  generates one and returns it as `X-Request-Id`.

Use `LOG_LEVEL=debug` in lower environments and `LOG_LEVEL=info` in production.
Passwords, OTPs, tokens, cookies, personal profile fields, device signatures,
pairing payloads, and signed URLs are redacted from debug logs.
