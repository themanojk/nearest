import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';

const API_BASE_URL =
  Platform.OS === 'android'
    ? 'http://127.0.0.1:9000/v1'
    : 'http://127.0.0.1:9000/v1';
const SESSION_SERVICE = 'app.nearnest.parent-session';

export type AuthUser = {
  email?: string;
  firstName?: string;
  id: string;
  lastName?: string;
  phone?: {
    countryCode: string;
    number: string;
  };
};

type AuthTokens = {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  tokenType: 'Bearer';
};

type AuthResponse = {
  tokens: AuthTokens;
  user: AuthUser;
};

export type AuthSession = AuthResponse & {
  hasOnboarded: boolean;
};

type ApiEnvelope<T> = {
  data: T;
  success: true;
};

type OtpSendResponse = {
  developmentCode?: string;
  expiresInSeconds: number;
  verificationId: string;
};

type OwnedDeviceSummary = {
  childId?: string;
  lifecycleStatus: string;
  pairingStatus: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { message?: string }; message?: string }
    | T
    | undefined;
  if (!response.ok) {
    const errorPayload = payload as
      | { error?: { message?: string }; message?: string }
      | undefined;
    throw new ApiError(
      errorPayload?.error?.message ??
        errorPayload?.message ??
        `Request failed with status ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  });
  return parseResponse<T>(response);
}

export async function sendPhoneOtp(
  countryCode: string,
  number: string,
): Promise<OtpSendResponse> {
  const result = await apiRequest<ApiEnvelope<OtpSendResponse>>(
    '/auth/otp/send',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'phone',
        phone: {
          countryCode,
          number,
        },
      }),
    },
  );
  return result.data;
}

export async function verifyPhoneOtp(
  verificationId: string,
  code: string,
): Promise<AuthSession> {
  const result = await apiRequest<ApiEnvelope<AuthResponse>>(
    '/auth/otp/verify',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verificationId,
        code,
      }),
    },
  );
  let session: AuthSession = {
    ...result.data,
    hasOnboarded: false,
  };
  await saveSession(session);
  session = await hydrateOnboardingState(session);
  await saveSession(session);
  return session;
}

export async function loadSession(): Promise<AuthSession | null> {
  const credentials = await Keychain.getGenericPassword({
    service: SESSION_SERVICE,
  });
  if (!credentials) return null;
  try {
    return JSON.parse(credentials.password) as AuthSession;
  } catch {
    await clearStoredSession();
    return null;
  }
}

export async function markSessionOnboarded(): Promise<void> {
  const session = await loadSession();
  if (!session) return;
  await saveSession({
    ...session,
    hasOnboarded: true,
  });
}

export async function restoreAuthenticatedSession(): Promise<AuthSession | null> {
  const session = await loadSession();
  if (!session) return null;
  try {
    const user = await authenticatedRequest<AuthUser>('/users/me');
    const refreshed = await loadSession();
    if (!refreshed) return null;
    const restored = await hydrateOnboardingState({ ...refreshed, user });
    await saveSession(restored);
    return restored;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await clearStoredSession();
      return null;
    }
    return session;
  }
}

async function hydrateOnboardingState(
  session: AuthSession,
): Promise<AuthSession> {
  if (session.hasOnboarded) return session;
  try {
    const devices = await authenticatedRequest<OwnedDeviceSummary[]>('/devices');
    const hasOnboarded = devices.some(
      (device) =>
        device.pairingStatus === 'paired' &&
        device.lifecycleStatus === 'active' &&
        Boolean(device.childId),
    );
    return hasOnboarded ? { ...session, hasOnboarded: true } : session;
  } catch {
    return session;
  }
}

let refreshInFlight: Promise<AuthSession> | null = null;

export async function authenticatedRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let session = await loadSession();
  if (!session) {
    throw new ApiError('Authentication is required', 401);
  }

  let response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${session.tokens.accessToken}`,
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    session = await refreshSession(session);
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.tokens.accessToken}`,
        ...init?.headers,
      },
    });
  }

  const result = await parseResponse<T | ApiEnvelope<T>>(response);
  if (
    result !== null &&
    typeof result === 'object' &&
    'success' in result &&
    result.success === true &&
    'data' in result
  ) {
    return result.data;
  }
  return result as T;
}

export async function logoutSession(): Promise<void> {
  const session = await loadSession();
  await clearStoredSession();
  try {
    if (session) {
      await apiRequest<ApiEnvelope<Record<string, never>>>('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refreshToken: session.tokens.refreshToken,
        }),
      });
    }
  } catch {
    // Local logout must succeed even when the API is temporarily unreachable.
  }
}

async function refreshSession(session: AuthSession): Promise<AuthSession> {
  if (!refreshInFlight) {
    refreshInFlight = apiRequest<ApiEnvelope<AuthResponse>>('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        refreshToken: session.tokens.refreshToken,
      }),
    })
      .then(async ({ data }) => {
        const refreshed = {
          ...data,
          hasOnboarded: session.hasOnboarded,
        };
        await saveSession(refreshed);
        return refreshed;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function saveSession(session: AuthSession): Promise<void> {
  await Keychain.setGenericPassword('nearnest-parent', JSON.stringify(session), {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    service: SESSION_SERVICE,
  });
}

async function clearStoredSession(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SESSION_SERVICE });
}
