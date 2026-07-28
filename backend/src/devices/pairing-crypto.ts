import { createPublicKey, verify } from 'node:crypto';

const PAIRING_DOMAIN = 'nearnest-device-pairing-v1';

export function pairingChallengePayload(
  sessionId: string,
  challengeId: string,
  nonce: string,
): string {
  return `${PAIRING_DOMAIN}\n${sessionId}\n${challengeId}\n${nonce}`;
}

export function verifyPairingSignature(
  publicKeyPem: string,
  payload: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.length !== 64 || decoded.toString('base64url') !== signature) {
      return false;
    }
    return verify(null, Buffer.from(payload, 'utf8'), key, decoded);
  } catch {
    return false;
  }
}

