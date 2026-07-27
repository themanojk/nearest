import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaMetadata } from './schemas/analysis-job.schema';

const execFileAsync = promisify(execFile);

interface RawProbeStream {
  channel_layout?: string;
  channels?: number;
  codec_name?: string;
  index?: number;
  sample_rate?: string;
}

interface RawProbeResult {
  format?: {
    bit_rate?: string;
    duration?: string;
    format_name?: string;
    size?: string;
  };
  streams?: RawProbeStream[];
}

export class MediaProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProbeError';
  }
}

function optionalPositiveInteger(value: string | number | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

export function parseProbeOutput(output: string): MediaMetadata {
  let probe: RawProbeResult;
  try {
    probe = JSON.parse(output) as RawProbeResult;
  } catch {
    throw new MediaProbeError('FFprobe returned invalid JSON');
  }

  const durationSeconds = Number(probe.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaProbeError('Audio duration could not be determined');
  }

  const audioStreams = (probe.streams ?? []).flatMap((stream) => {
    if (stream.index === undefined || !stream.codec_name) {
      return [];
    }
    return [
      {
        index: stream.index,
        codecName: stream.codec_name,
        sampleRate: optionalPositiveInteger(stream.sample_rate),
        channels: optionalPositiveInteger(stream.channels),
        channelLayout: stream.channel_layout,
      },
    ];
  });
  if (audioStreams.length === 0) {
    throw new MediaProbeError('The uploaded object has no readable audio stream');
  }

  return {
    durationMs: Math.round(durationSeconds * 1000),
    formatName: probe.format?.format_name ?? 'unknown',
    bitRate: optionalPositiveInteger(probe.format?.bit_rate),
    sizeBytes: optionalPositiveInteger(probe.format?.size),
    audioStreams,
    probedAt: new Date(),
  };
}

@Injectable()
export class MediaProbeService {
  private readonly ffprobePath: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.ffprobePath = config.getOrThrow<string>('FFPROBE_PATH');
    this.timeoutMs = config.getOrThrow<number>('FFPROBE_TIMEOUT_MS');
  }

  async probe(inputUrl: string): Promise<MediaMetadata> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobePath,
        [
          '-v',
          'error',
          '-select_streams',
          'a',
          '-show_entries',
          'format=duration,format_name,bit_rate,size:stream=index,codec_name,sample_rate,channels,channel_layout',
          '-of',
          'json',
          inputUrl,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: this.timeoutMs,
        },
      );
      return parseProbeOutput(stdout);
    } catch (error) {
      if (error instanceof MediaProbeError) {
        throw error;
      }
      throw new MediaProbeError('FFprobe could not read the uploaded audio');
    }
  }
}
