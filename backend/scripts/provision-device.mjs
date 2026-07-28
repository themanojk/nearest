import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import mongoose from 'mongoose';

config({ path: ['.env', '../.env'], override: false, quiet: true });

const [serialArg, publicKeyPath, hardwareRevision, firmwareVersion] =
  process.argv.slice(2);
if (!serialArg || !publicKeyPath || !hardwareRevision || !firmwareVersion) {
  throw new Error(
    'Usage: npm run device:provision -- <serial> <public-key.pem> <hardware-revision> <firmware-version>',
  );
}
if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required in backend/.env, ../.env, or the shell');
}

const serialNumber = serialArg.trim().toUpperCase();
if (!/^[A-Z0-9][A-Z0-9._-]{3,79}$/.test(serialNumber)) {
  throw new Error('Invalid device serial number');
}
const identityPublicKeyPem = await readFile(publicKeyPath, 'utf8');
const key = createPublicKey(identityPublicKeyPem);
if (key.asymmetricKeyType !== 'ed25519') {
  throw new Error('Device identity public key must be Ed25519');
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  const result = await mongoose.connection.collection('devices').updateOne(
    { serialNumber },
    {
      $setOnInsert: {
        serialNumber,
        identityPublicKeyPem,
        hardwareRevision,
        firmwareVersion,
        pairingStatus: 'unpaired',
        lifecycleStatus: 'active',
        credentialVersion: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  if (result.upsertedCount !== 1) {
    throw new Error(
      'Serial already exists; identity keys cannot be replaced by provisioning',
    );
  }
  process.stdout.write(`Provisioned device ${serialNumber}\n`);
} finally {
  await mongoose.disconnect();
}
