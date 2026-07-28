import { generateKeyPairSync, sign } from 'node:crypto';
import {
  pairingChallengePayload,
  verifyPairingSignature,
} from './pairing-crypto';

describe('device pairing cryptography', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({
    format: 'pem',
    type: 'spki',
  }).toString();
  const payload = pairingChallengePayload(
    'session-a',
    'challenge-a',
    'nonce-a',
  );

  it('accepts a valid Ed25519 signature from the provisioned identity', () => {
    const signature = sign(
      null,
      Buffer.from(payload),
      keys.privateKey,
    ).toString('base64url');

    expect(verifyPairingSignature(publicKey, payload, signature)).toBe(true);
  });

  it('binds the signature to the session, challenge and nonce', () => {
    const signature = sign(
      null,
      Buffer.from(payload),
      keys.privateKey,
    ).toString('base64url');

    for (const changed of [
      pairingChallengePayload('session-b', 'challenge-a', 'nonce-a'),
      pairingChallengePayload('session-a', 'challenge-b', 'nonce-a'),
      pairingChallengePayload('session-a', 'challenge-a', 'nonce-b'),
    ]) {
      expect(verifyPairingSignature(publicKey, changed, signature)).toBe(false);
    }
  });

  it('rejects another device identity and malformed signatures', () => {
    const otherKeys = generateKeyPairSync('ed25519');
    const signature = sign(
      null,
      Buffer.from(payload),
      otherKeys.privateKey,
    ).toString('base64url');

    expect(verifyPairingSignature(publicKey, payload, signature)).toBe(false);
    expect(verifyPairingSignature(publicKey, payload, 'not-a-signature')).toBe(
      false,
    );
  });
});

