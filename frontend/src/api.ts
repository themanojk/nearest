import type {
  Analysis,
  AnalysisPage,
  AudioPlayback,
  ConversationPage,
  CreateAnalysisResponse,
  SegmentPage,
  TranscriptionPage,
  TimelineEventPage,
  AcousticEventPage,
  RiskIncidentPage,
  TranscriptionLanguageMode,
} from './types';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/v1';
const AUTH_STORAGE_KEY = 'kid-audio-auth-session';
let sessionInFlight: Promise<AuthTokens> | null = null;

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthEnvelope {
  data: {
    tokens: AuthTokens;
  };
  success: true;
}

interface CreateAnalysisInput {
  childId: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  transcriptionLanguageMode: TranscriptionLanguageMode;
}

async function apiRequest<T>(
  path: string,
  tenantId: string,
  init?: RequestInit,
): Promise<T> {
  let tokens = await getDevelopmentSession(tenantId);
  let response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    tokens = await rotateDevelopmentSession(tokens.refreshToken, tenantId);
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        ...init?.headers,
      },
    });
  }
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const error = (await response.json()) as { message?: string };
      message = error.message ?? message;
    } catch {
      // The status remains useful when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function getDevelopmentSession(tenantId: string): Promise<AuthTokens> {
  const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
  if (stored) {
    try {
      return (JSON.parse(stored) as { tokens: AuthTokens }).tokens;
    } catch {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }
  if (!sessionInFlight) {
    sessionInFlight = createDevelopmentSession(tenantId).finally(() => {
      sessionInFlight = null;
    });
  }
  return sessionInFlight;
}

async function rotateDevelopmentSession(
  refreshToken: string,
  tenantId: string,
): Promise<AuthTokens> {
  if (!sessionInFlight) {
    sessionInFlight = refreshDevelopmentSession(refreshToken)
      .catch(() => createDevelopmentSession(tenantId))
      .finally(() => {
        sessionInFlight = null;
      });
  }
  return sessionInFlight;
}

async function createDevelopmentSession(
  tenantId: string,
): Promise<AuthTokens> {
  const phoneNumber = developmentPhoneNumber(tenantId);
  const sent = await fetch(`${API_BASE_URL}/auth/otp/send`, {
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
  if (!sent.ok) {
    throw new Error('Unable to start the local development session');
  }
  const sentPayload = (await sent.json()) as {
    data: { developmentCode?: string; verificationId: string };
  };
  const verified = await fetch(`${API_BASE_URL}/auth/otp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      verificationId: sentPayload.data.verificationId,
      code: sentPayload.data.developmentCode ?? '1234',
    }),
  });
  if (!verified.ok) {
    throw new Error('Unable to verify the local development session');
  }
  const session = (await verified.json()) as AuthEnvelope;
  window.localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify(session.data),
  );
  return session.data.tokens;
}

async function refreshDevelopmentSession(
  refreshToken: string,
): Promise<AuthTokens> {
  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    throw new Error('Development session expired');
  }
  const session = (await response.json()) as AuthEnvelope;
  window.localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify(session.data),
  );
  return session.data.tokens;
}

function developmentPhoneNumber(seed: string): string {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `9${String(hash).padStart(9, '0').slice(-9)}`;
}

export function createAnalysis(
  tenantId: string,
  input: CreateAnalysisInput,
) {
  return apiRequest<CreateAnalysisResponse>('/audio-analysis', tenantId, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

export function completeUpload(tenantId: string, analysisId: string) {
  return apiRequest<Analysis>(
    `/audio-analysis/${analysisId}/complete-upload`,
    tenantId,
    { method: 'POST' },
  );
}

export function getAnalysis(tenantId: string, analysisId: string) {
  return apiRequest<Analysis>(`/audio-analysis/${analysisId}`, tenantId);
}

export function getAudioPlayback(tenantId: string, analysisId: string) {
  return apiRequest<AudioPlayback>(
    `/audio-analysis/${analysisId}/playback`,
    tenantId,
  );
}

export function getAnalyses(tenantId: string, page = 1, limit = 50) {
  return apiRequest<AnalysisPage>(
    `/audio-analysis?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function getSegments(
  tenantId: string,
  analysisId: string,
  page: number,
  limit = 300,
  type?: 'SCAN_WINDOW' | 'SPEECH_INTERVAL' | 'PROCESSING_REGION',
) {
  const typeQuery = type ? `&type=${type}` : '';
  return apiRequest<SegmentPage>(
    `/audio-analysis/${analysisId}/segments?page=${page}&limit=${limit}${typeQuery}`,
    tenantId,
  );
}

export async function getScanWindows(
  tenantId: string,
  analysisId: string,
) {
  const limit = 500;
  const first = await getSegments(
    tenantId,
    analysisId,
    1,
    limit,
    'SCAN_WINDOW',
  );
  const pageCount = Math.ceil(first.total / limit);
  if (pageCount <= 1) return first.items;

  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      getSegments(tenantId, analysisId, index + 2, limit, 'SCAN_WINDOW'),
    ),
  );
  return [first, ...remaining].flatMap((page) => page.items);
}

export function getTranscriptions(
  tenantId: string,
  analysisId: string,
  page = 1,
  limit = 300,
) {
  return apiRequest<TranscriptionPage>(
    `/audio-analysis/${analysisId}/transcripts?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function startDiarization(
  tenantId: string,
  analysisId: string,
  force = false,
) {
  return apiRequest<Analysis>(
    `/audio-analysis/${analysisId}/diarize`,
    tenantId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    },
  );
}

export function getConversations(
  tenantId: string,
  analysisId: string,
  page = 1,
  limit = 100,
) {
  return apiRequest<ConversationPage>(
    `/audio-analysis/${analysisId}/conversations?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function startContextClassification(
  tenantId: string,
  analysisId: string,
  force = false,
) {
  return apiRequest<Analysis>(
    `/audio-analysis/${analysisId}/classify-context`,
    tenantId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    },
  );
}

export function getTimelineEvents(
  tenantId: string,
  analysisId: string,
  page = 1,
  limit = 100,
) {
  return apiRequest<TimelineEventPage>(
    `/audio-analysis/${analysisId}/timeline?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function startAcousticDetection(
  tenantId: string,
  analysisId: string,
  force = false,
) {
  return apiRequest<Analysis>(
    `/audio-analysis/${analysisId}/detect-acoustic-events`,
    tenantId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    },
  );
}

export function getAcousticEvents(
  tenantId: string,
  analysisId: string,
  page = 1,
  limit = 100,
) {
  return apiRequest<AcousticEventPage>(
    `/audio-analysis/${analysisId}/acoustic-events?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function startRiskAggregation(
  tenantId: string,
  analysisId: string,
  force = false,
) {
  return apiRequest<Analysis>(
    `/audio-analysis/${analysisId}/aggregate-risk`,
    tenantId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    },
  );
}

export function getRiskIncidents(
  tenantId: string,
  analysisId: string,
  page = 1,
  limit = 100,
) {
  return apiRequest<RiskIncidentPage>(
    `/audio-analysis/${analysisId}/risk-incidents?page=${page}&limit=${limit}`,
    tenantId,
  );
}

export function uploadFile(
  upload: CreateAnalysisResponse['upload'],
  file: File,
  onProgress: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.method, upload.url);
    Object.entries(upload.headers).forEach(([name, value]) => {
      request.setRequestHeader(name, value);
    });
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(
          new Error(`Object upload failed with status ${request.status}`),
        );
      }
    });
    request.addEventListener('error', () => {
      reject(
        new Error(
          'Object upload failed. Check that MinIO is running and allows the frontend origin.',
        ),
      );
    });
    request.addEventListener('abort', () => {
      reject(new Error('Object upload was cancelled'));
    });
    request.send(file);
  });
}
