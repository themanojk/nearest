import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ObjectStorageService } from './storage.service';
import { writeFileSync, existsSync } from 'node:fs';
import * as childProcess from 'node:child_process';

function setup() {
  const service = new ObjectStorageService({ getOrThrow: (key: string) => ({
    S3_BUCKET: 'audio', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test', S3_ENDPOINT: 'http://localhost:9000',
    S3_PUBLIC_ENDPOINT: 'http://localhost:9000', FFMPEG_PATH: 'ffmpeg',
  }[key]) } as ConfigService);
  const send = jest.fn();
  Object.assign(service, { client: { send } });
  jest.spyOn(service, 'createReadUrl').mockResolvedValue('http://internal/source.flac');
  return { service, send };
}

describe('FLAC playback preparation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reuses an existing WAV without running ffmpeg', async () => {
    const { service, send } = setup();
    send.mockResolvedValue({});
    expect(await service.ensureFlacPlayback('source.flac')).toBe('source.flac.playback-v1.wav');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(service.createReadUrl).not.toHaveBeenCalled();
  });

  it('converts once for concurrent callers, uploads WAV, and removes temporary files', async () => {
    const { service, send } = setup();
    const header = Buffer.alloc(42);
    header.write('fLaC'); header[4] = 128; header[7] = 34;
    header[18] = 3; header[19] = 232; // 16000 Hz in STREAMINFO
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => header } })
      .mockResolvedValue({});
    let output = '';
    const exec = jest.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
      const argv = args[1] as string[];
      output = argv[argv.length - 1];
      writeFileSync(output, Buffer.alloc(64));
      (args[3] as (error: null, stdout: string, stderr: string) => void)(null, '', '');
    }) as typeof childProcess.execFile);
    const results = await Promise.all([
      service.ensureFlacPlayback('source.flac'), service.ensureFlacPlayback('source.flac'),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['pcm_s16le', 'asetrate=16000', 'http://internal/source.flac']));
    const upload = send.mock.calls[2][0] as PutObjectCommand;
    expect(upload).toBeInstanceOf(PutObjectCommand);
    expect(upload.input).toMatchObject({ ContentType: 'audio/wav', ContentLength: 64 });
    expect(existsSync(output)).toBe(false);
  });

  it('does not treat permission failures as missing cached audio', async () => {
    const { service, send } = setup();
    send.mockRejectedValue({ $metadata: { httpStatusCode: 403 } });
    await expect(service.ensureFlacPlayback('source.flac')).rejects.toThrow('could not be checked');
    expect(service.createReadUrl).not.toHaveBeenCalled();
  });
});
