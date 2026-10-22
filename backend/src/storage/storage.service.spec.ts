import { ConfigService } from '@nestjs/config';
import { ObjectStorageService } from './storage.service';

describe('storage read endpoints', () => {
  it('signs worker reads internally and phone playback publicly', async () => {
    const values: Record<string, unknown> = {
      S3_BUCKET: 'audio', S3_CONFIGURE_BUCKET_CORS: false,
      FRONTEND_ORIGIN: 'http://localhost:5173', READ_URL_TTL_SECONDS: 300,
      UPLOAD_URL_TTL_SECONDS: 300, S3_FORCE_PATH_STYLE: true,
      S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test-access',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      S3_ENDPOINT: 'http://localhost:59000',
      S3_PUBLIC_ENDPOINT: 'http://192.168.31.188:59000',
    };
    const service = new ObjectStorageService({
      getOrThrow: (key: string) => values[key],
    } as ConfigService);
    const internal = new URL(await service.createReadUrl('test/source.wav'));
    const playback = new URL((await service.createPlaybackUrl('test/source.wav')).url);
    expect(internal.origin).toBe('http://localhost:59000');
    expect(playback.origin).toBe('http://192.168.31.188:59000');
    expect(internal.pathname).toBe('/audio/test/source.wav');
    expect(playback.pathname).toBe(internal.pathname);
    expect(internal.searchParams.has('X-Amz-Signature')).toBe(true);
    expect(playback.searchParams.has('X-Amz-Signature')).toBe(true);
  });
});
