import { generateKeyPairSync, randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const [serialArg, hardwareRevision = 'rev-a', firmwareVersion = '2.4.0'] =
  process.argv.slice(2);
if (!serialArg) {
  throw new Error(
    'Usage: npm run device:identity -- <serial> [hardware-revision] [firmware-version]',
  );
}
const serialNumber = serialArg.trim().toUpperCase();
if (!/^[A-Z0-9][A-Z0-9._-]{3,79}$/.test(serialNumber)) {
  throw new Error('Invalid device serial number');
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateJwk = privateKey.export({ format: 'jwk' });
const publicJwk = publicKey.export({ format: 'jwk' });
if (!privateJwk.d || !publicJwk.x) {
  throw new Error('Could not export Ed25519 identity');
}
const privateSeed = Buffer.from(privateJwk.d, 'base64url');
const publicBytes = Buffer.from(publicJwk.x, 'base64url');
const blePasskey = randomInt(100000, 1000000);
const firmwareDirectory = path.resolve(process.cwd(), '../NearNestFirmware');
const publicKeyPath = path.join(
  firmwareDirectory,
  `${serialNumber}.public.pem`,
);
const secretsPath = path.join(firmwareDirectory, 'device_secrets.h');

const bytes = (value) =>
  [...value]
    .map((byte, index) => `${index % 8 === 0 ? '    ' : ''}0x${byte
      .toString(16)
      .padStart(2, '0')}${index === value.length - 1 ? '' : ', '}${
      index % 8 === 7 ? '\n' : ''
    }`)
    .join('');
const header = `#pragma once
#define NEARNEST_DEVICE_SERIAL "${serialNumber}"
#define NEARNEST_HARDWARE_REVISION "${hardwareRevision}"
#define NEARNEST_FIRMWARE_VERSION "${firmwareVersion}"
#define NEARNEST_BLE_PASSKEY ${blePasskey}
static const uint8_t NEARNEST_ED25519_PRIVATE_KEY[32] = {
${bytes(privateSeed)}};
static const uint8_t NEARNEST_ED25519_PUBLIC_KEY[32] = {
${bytes(publicBytes)}};
`;

await writeFile(secretsPath, header, { mode: 0o600 });
await writeFile(
  publicKeyPath,
  publicKey.export({ format: 'pem', type: 'spki' }),
  { mode: 0o644 },
);
process.stdout.write(
  `Generated ${secretsPath}\nPublic key: ${publicKeyPath}\nBLE label passkey: ${blePasskey}\n`,
);
