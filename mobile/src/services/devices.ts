import { authenticatedRequest } from './auth';

export type PairingChallenge = {
  challengeId: string;
  expiresAt: string;
  nonce: string;
  payload: string;
};

export type PairingSession = {
  challenge?: PairingChallenge;
  expiresAt: string;
  id: string;
  serialNumber?: string;
  status: string;
};

export type Device = {
  childId?: string;
  displayName?: string;
  firmwareVersion: string;
  hardwareRevision: string;
  id: string;
  lifecycleStatus: string;
  pairingStatus: string;
  serialNumber: string;
};

export type ChildProfile = {
  id: string;
  name: string;
  nickname?: string;
};

export function listOwnedDevices(): Promise<Device[]> {
  return authenticatedRequest('/devices');
}

export function startPairingSession(): Promise<PairingSession> {
  return authenticatedRequest('/device-pairing-sessions', {
    method: 'POST',
  });
}

export function discoverPairingDevice(
  sessionId: string,
  serialNumber: string,
): Promise<PairingSession> {
  return authenticatedRequest(
    `/device-pairing-sessions/${sessionId}/discover`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serialNumber }),
    },
  );
}

export function verifyPairingDevice(
  sessionId: string,
  challengeId: string,
  signature: string,
): Promise<PairingSession> {
  return authenticatedRequest(
    `/device-pairing-sessions/${sessionId}/challenge`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    },
  );
}

export function createChildProfile(nickname: string): Promise<ChildProfile> {
  const trimmed = nickname.trim();
  return authenticatedRequest('/children', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: trimmed,
      nickname: trimmed,
      ageGroup: '6_8',
      languages: ['en-IN'],
      analysisPreferences: {},
    }),
  });
}

export function completePairingSession(
  sessionId: string,
  childId: string,
  displayName: string,
): Promise<Device> {
  return authenticatedRequest(
    `/device-pairing-sessions/${sessionId}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        childId,
        displayName: displayName.trim(),
      }),
    },
  );
}
