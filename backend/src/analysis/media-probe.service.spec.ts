import {
  MediaProbeError,
  parseProbeOutput,
} from './media-probe.service';

describe('parseProbeOutput', () => {
  it('normalizes FFprobe output into integer media metadata', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_name: 'aac',
            sample_rate: '48000',
            channels: 2,
            channel_layout: 'stereo',
          },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '12.345',
          size: '98765',
          bit_rate: '128000',
        },
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        durationMs: 12_345,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        sizeBytes: 98_765,
        bitRate: 128_000,
        audioStreams: [
          {
            index: 0,
            codecName: 'aac',
            sampleRate: 48_000,
            channels: 2,
            channelLayout: 'stereo',
          },
        ],
      }),
    );
    expect(result.probedAt).toBeInstanceOf(Date);
  });

  it('rejects output without a readable audio stream', () => {
    expect(() =>
      parseProbeOutput(
        JSON.stringify({
          streams: [],
          format: { duration: '1.0' },
        }),
      ),
    ).toThrow('no readable audio stream');
  });

  it('rejects malformed FFprobe output without exposing its contents', () => {
    expect(() => parseProbeOutput('not-json')).toThrow(MediaProbeError);
  });
});
