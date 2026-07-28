const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 256;

const sensitiveKeys = new Set([
  'accesstoken',
  'authorization',
  'childname',
  'code',
  'cookie',
  'developmentcode',
  'email',
  'firstname',
  'lastname',
  'number',
  'otp',
  'pairingcode',
  'passcode',
  'password',
  'payload',
  'phone',
  'refreshtoken',
  'set-cookie',
  'signature',
  'token',
  'url',
  'verificationcode',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('signature') ||
    normalized.endsWith('token')
  );
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

export function sanitizeForLogs(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeForLogs(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key)
        ? REDACTED
        : sanitizeForLogs(item, depth + 1, seen),
    ]),
  );
}

export function sanitizeErrorMessage(message: string): string {
  return truncate(
    message
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, (url) => {
        const queryIndex = url.indexOf('?');
        return `${url.slice(0, queryIndex)}?[REDACTED]`;
      }),
  );
}
