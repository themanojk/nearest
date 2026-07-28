interface Environment {
  AUTH_ACCESS_TOKEN_TTL_SECONDS: number;
  AUTH_DEVELOPMENT_OTP_CODE: string;
  AUTH_JWT_SECRET: string;
  AUTH_OTP_DELIVERY_MODE: string;
  AUTH_OTP_SECRET: string;
  AUTH_REFRESH_TOKEN_TTL_SECONDS: number;
  ASR_MAX_CHUNK_MS: number;
  ASR_QUEUE_CONCURRENCY: number;
  BACKEND_PORT: number;
  FFPROBE_PATH: string;
  FFPROBE_TIMEOUT_MS: number;
  FRONTEND_ORIGIN: string;
  LOGICAL_TRIM_CONTEXT_AFTER_MS: number;
  LOGICAL_TRIM_CONTEXT_BEFORE_MS: number;
  LOGICAL_TRIM_MAX_GAP_MS: number;
  LOGICAL_TRIM_MIN_REGION_MS: number;
  LOG_LEVEL: string;
  MAX_AUDIO_SIZE_BYTES: number;
  MONGODB_URI: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  READ_URL_TTL_SECONDS: number;
  SCAN_OVERLAP_MS: number;
  SCAN_WINDOW_MS: number;
  S3_ACCESS_KEY_ID: string;
  S3_BUCKET: string;
  S3_CONFIGURE_BUCKET_CORS: boolean;
  S3_ENDPOINT: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_SECRET_ACCESS_KEY: string;
  UPLOAD_URL_TTL_SECONDS: number;
  VAD_MODE: number;
  WORKER_BASE_URL: string;
  WORKER_REQUEST_TIMEOUT_MS: number;
}

function numberValue(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = config[key];
  const value =
    typeof raw === 'string' || typeof raw === 'number'
      ? Number(raw)
      : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

function stringValue(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const raw = config[key];
  const value = typeof raw === 'string' ? raw.trim() : fallback;
  if (!value) {
    throw new Error(`${key} must not be empty`);
  }
  return value;
}

function booleanValue(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = config[key];
  const value =
    typeof raw === 'string' || typeof raw === 'boolean'
      ? String(raw).toLowerCase()
      : String(fallback);
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${key} must be true or false`);
  }
  return value === 'true';
}

function nonNegativeNumberValue(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = config[key];
  const value =
    typeof raw === 'string' || typeof raw === 'number'
      ? Number(raw)
      : fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const environment: Environment = {
    AUTH_ACCESS_TOKEN_TTL_SECONDS: numberValue(
      config,
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
      900,
    ),
    AUTH_DEVELOPMENT_OTP_CODE: stringValue(
      config,
      'AUTH_DEVELOPMENT_OTP_CODE',
      '1234',
    ),
    AUTH_JWT_SECRET: stringValue(
      config,
      'AUTH_JWT_SECRET',
      'local-development-jwt-secret-change-before-production',
    ),
    AUTH_OTP_DELIVERY_MODE: stringValue(
      config,
      'AUTH_OTP_DELIVERY_MODE',
      'development',
    ),
    AUTH_OTP_SECRET: stringValue(
      config,
      'AUTH_OTP_SECRET',
      'local-development-otp-secret-change-before-production',
    ),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: numberValue(
      config,
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
      30 * 24 * 60 * 60,
    ),
    ASR_MAX_CHUNK_MS: numberValue(config, 'ASR_MAX_CHUNK_MS', 30_000),
    ASR_QUEUE_CONCURRENCY: numberValue(
      config,
      'ASR_QUEUE_CONCURRENCY',
      2,
    ),
    BACKEND_PORT: numberValue(config, 'BACKEND_PORT', 3000),
    FFPROBE_PATH: stringValue(config, 'FFPROBE_PATH', 'ffprobe'),
    FFPROBE_TIMEOUT_MS: numberValue(config, 'FFPROBE_TIMEOUT_MS', 120_000),
    FRONTEND_ORIGIN: stringValue(
      config,
      'FRONTEND_ORIGIN',
      'http://localhost:5173',
    ),
    LOGICAL_TRIM_CONTEXT_AFTER_MS: nonNegativeNumberValue(
      config,
      'LOGICAL_TRIM_CONTEXT_AFTER_MS',
      400,
    ),
    LOGICAL_TRIM_CONTEXT_BEFORE_MS: nonNegativeNumberValue(
      config,
      'LOGICAL_TRIM_CONTEXT_BEFORE_MS',
      250,
    ),
    LOGICAL_TRIM_MAX_GAP_MS: nonNegativeNumberValue(
      config,
      'LOGICAL_TRIM_MAX_GAP_MS',
      500,
    ),
    LOGICAL_TRIM_MIN_REGION_MS: nonNegativeNumberValue(
      config,
      'LOGICAL_TRIM_MIN_REGION_MS',
      500,
    ),
    LOG_LEVEL: stringValue(config, 'LOG_LEVEL', 'debug'),
    MAX_AUDIO_SIZE_BYTES: numberValue(
      config,
      'MAX_AUDIO_SIZE_BYTES',
      10 * 1024 * 1024 * 1024,
    ),
    MONGODB_URI: stringValue(
      config,
      'MONGODB_URI',
      'mongodb://localhost:57017/kid_audio',
    ),
    REDIS_HOST: stringValue(config, 'REDIS_HOST', 'localhost'),
    REDIS_PORT: numberValue(config, 'REDIS_PORT', 56379),
    READ_URL_TTL_SECONDS: numberValue(config, 'READ_URL_TTL_SECONDS', 900),
    SCAN_OVERLAP_MS: numberValue(config, 'SCAN_OVERLAP_MS', 2_000),
    SCAN_WINDOW_MS: numberValue(config, 'SCAN_WINDOW_MS', 30_000),
    S3_ACCESS_KEY_ID: stringValue(
      config,
      'S3_ACCESS_KEY_ID',
      'kid-audio-local',
    ),
    S3_BUCKET: stringValue(config, 'S3_BUCKET', 'kid-audio'),
    S3_CONFIGURE_BUCKET_CORS: booleanValue(
      config,
      'S3_CONFIGURE_BUCKET_CORS',
      false,
    ),
    S3_ENDPOINT: stringValue(config, 'S3_ENDPOINT', 'http://localhost:59000'),
    S3_FORCE_PATH_STYLE: booleanValue(config, 'S3_FORCE_PATH_STYLE', true),
    S3_PUBLIC_ENDPOINT: stringValue(
      config,
      'S3_PUBLIC_ENDPOINT',
      stringValue(config, 'S3_ENDPOINT', 'http://localhost:59000'),
    ),
    S3_REGION: stringValue(config, 'S3_REGION', 'us-east-1'),
    S3_SECRET_ACCESS_KEY: stringValue(
      config,
      'S3_SECRET_ACCESS_KEY',
      'kid-audio-local-secret',
    ),
    UPLOAD_URL_TTL_SECONDS: numberValue(
      config,
      'UPLOAD_URL_TTL_SECONDS',
      900,
    ),
    VAD_MODE: nonNegativeNumberValue(config, 'VAD_MODE', 2),
    WORKER_BASE_URL: stringValue(
      config,
      'WORKER_BASE_URL',
      'http://localhost:8000',
    ),
    WORKER_REQUEST_TIMEOUT_MS: numberValue(
      config,
      'WORKER_REQUEST_TIMEOUT_MS',
      3_600_000,
    ),
  };
  if (environment.SCAN_OVERLAP_MS >= environment.SCAN_WINDOW_MS) {
    throw new Error('SCAN_OVERLAP_MS must be less than SCAN_WINDOW_MS');
  }
  if (!Number.isInteger(environment.VAD_MODE) || environment.VAD_MODE > 3) {
    throw new Error('VAD_MODE must be an integer from 0 to 3');
  }
  if (
    environment.AUTH_OTP_DELIVERY_MODE !== 'development' &&
    environment.AUTH_OTP_DELIVERY_MODE !== 'disabled'
  ) {
    throw new Error(
      'AUTH_OTP_DELIVERY_MODE must be development or disabled',
    );
  }
  if (environment.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must contain at least 32 characters');
  }
  if (environment.AUTH_OTP_SECRET.length < 32) {
    throw new Error('AUTH_OTP_SECRET must contain at least 32 characters');
  }
  if (!/^\d{4,8}$/.test(environment.AUTH_DEVELOPMENT_OTP_CODE)) {
    throw new Error(
      'AUTH_DEVELOPMENT_OTP_CODE must contain between 4 and 8 digits',
    );
  }
  if (!['debug', 'info', 'warn', 'error'].includes(environment.LOG_LEVEL)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, or error');
  }
  return environment;
}
