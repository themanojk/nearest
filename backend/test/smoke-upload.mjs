import { Queue } from 'bullmq';

const apiBaseUrl =
  process.env.BACKEND_BASE_URL ??
  'http://127.0.0.1:3000/v1/audio-analysis';
const apiRoot = apiBaseUrl.replace(/\/audio-analysis\/?$/, '');
const redisHost = process.env.REDIS_HOST ?? '127.0.0.1';
const redisPort = Number(process.env.REDIS_PORT ?? 56379);
const frontendOrigin =
  process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
const tenantId = `smoke-${Date.now()}`;
const phoneNumber = `9${String(Date.now()).slice(-9)}`;

function createToneWav(durationMs = 1_000, sampleRate = 16_000) {
  const sampleCount = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate);
    wav.writeInt16LE(Math.round(sample * 3276), 44 + index * 2);
  }
  return wav;
}

const payload = createToneWav();

async function responseJson(response, operation) {
  if (!response.ok) {
    throw new Error(
      `${operation} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

const otpResponse = await fetch(`${apiRoot}/auth/otp/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    channel: 'phone',
    phone: {
      countryCode: '+91',
      number: phoneNumber,
    },
  }),
});
const otp = await responseJson(otpResponse, 'Send development OTP');
const verifyResponse = await fetch(`${apiRoot}/auth/otp/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    verificationId: otp.data.verificationId,
    code: otp.data.developmentCode ?? '1234',
  }),
});
const authenticated = await responseJson(
  verifyResponse,
  'Verify development OTP',
);
const authorization = `Bearer ${authenticated.data.tokens.accessToken}`;

const createResponse = await fetch(apiBaseUrl, {
  method: 'POST',
  headers: {
    authorization,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    childId: 'smoke-child',
    fileName: 'smoke.wav',
    contentType: 'audio/wav',
    sizeBytes: payload.length,
  }),
});
const created = await responseJson(createResponse, 'Create analysis');

const preflightResponse = await fetch(created.upload.url, {
  method: 'OPTIONS',
  headers: {
    origin: frontendOrigin,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'content-type',
  },
});
const allowedOrigin = preflightResponse.headers.get(
  'access-control-allow-origin',
);
if (!preflightResponse.ok || allowedOrigin !== frontendOrigin) {
  throw new Error(
    `Browser upload CORS check failed (${preflightResponse.status})`,
  );
}

const uploadResponse = await fetch(created.upload.url, {
  method: created.upload.method,
  headers: created.upload.headers,
  body: payload,
});
if (!uploadResponse.ok) {
  throw new Error(`Upload failed (${uploadResponse.status})`);
}

const completionUrl = `${apiBaseUrl}/${created.analysisId}/complete-upload`;
const completionResponse = await fetch(completionUrl, {
  method: 'POST',
  headers: { authorization },
});
const completed = await responseJson(completionResponse, 'Complete upload');

const repeatedResponse = await fetch(completionUrl, {
  method: 'POST',
  headers: { authorization },
});
const repeated = await responseJson(repeatedResponse, 'Repeat completion');

let current = repeated;
const deadline = Date.now() + 60_000;
while (
  current.status !== 'COMPLETED' &&
  current.status !== 'FAILED' &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const statusResponse = await fetch(
    `${apiBaseUrl}/${created.analysisId}`,
    { headers: { authorization } },
  );
  current = await responseJson(statusResponse, 'Get analysis');
}

const queueOptions = {
  connection: {
    host: redisHost,
    port: redisPort,
  },
  prefix: 'kid-audio',
};
const ingestQueue = new Queue('audio.ingest', queueOptions);
const scanQueue = new Queue('audio.scan', queueOptions);
const ingestJob = await ingestQueue.getJob(`ingest-${created.analysisId}`);
const scanJob = await scanQueue.getJob(`scan-${created.analysisId}`);
const ingestQueueState = ingestJob
  ? await ingestJob.getState()
  : 'missing';
const scanQueueState = scanJob ? await scanJob.getState() : 'missing';
await Promise.all([ingestQueue.close(), scanQueue.close()]);

console.log(
  JSON.stringify(
    {
      analysisId: created.analysisId,
      tenantId,
      browserUploadOrigin: allowedOrigin,
      initialStatus: created.status,
      completedStatus: completed.status,
      repeatedStatus: repeated.status,
      currentStatus: current.status,
      ingestStatus: current.ingestStage?.status,
      durationMs: current.mediaMetadata?.durationMs,
      audioCodec: current.mediaMetadata?.audioStreams?.[0]?.codecName,
      scanStatus: current.scanStage?.status,
      scanWindowCount: current.scanSummary?.windowCount,
      speechIntervalCount: current.scanSummary?.speechIntervalCount,
      speechRatio: current.scanSummary?.speechRatio,
      transcriptionStatus: current.transcriptionStage?.status,
      transcriptionChunkCount:
        current.transcriptionSummary?.chunkCount,
      transcriptionWordCount:
        current.transcriptionSummary?.wordCount,
      ingestQueueState,
      scanQueueState,
    },
    null,
    2,
  ),
);
