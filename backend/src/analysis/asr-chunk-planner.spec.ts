import { planAsrChunks } from './asr-chunk-planner';

describe('planAsrChunks', () => {
  const options = { maxChunkMs: 30_000 };

  it('creates continuous active windows without joining distant audio', () => {
    expect(
      planAsrChunks(
        [
          { startMs: 1_000, endMs: 10_000, sourceIntervalCount: 2 },
          { startMs: 11_000, endMs: 20_000, sourceIntervalCount: 1 },
          { startMs: 30_000, endMs: 40_000, sourceIntervalCount: 1 },
        ],
        options,
        50_000,
      ),
    ).toEqual([
      {
        startMs: 0,
        endMs: 30_000,
        durationMs: 30_000,
        ranges: [{ startMs: 0, endMs: 30_000 }],
        sourceRegionCount: 2,
      },
      {
        startMs: 30_000,
        endMs: 50_000,
        durationMs: 20_000,
        ranges: [{ startMs: 30_000, endMs: 50_000 }],
        sourceRegionCount: 1,
      },
    ]);
  });

  it('splits continuous regions at the maximum ASR duration', () => {
    expect(
      planAsrChunks(
        [{ startMs: 5_000, endMs: 140_000, sourceIntervalCount: 8 }],
        options,
        150_000,
      ),
    ).toEqual([
      {
        startMs: 0,
        endMs: 30_000,
        durationMs: 30_000,
        ranges: [{ startMs: 0, endMs: 30_000 }],
        sourceRegionCount: 1,
      },
      {
        startMs: 30_000,
        endMs: 60_000,
        durationMs: 30_000,
        ranges: [{ startMs: 30_000, endMs: 60_000 }],
        sourceRegionCount: 1,
      },
      {
        startMs: 60_000,
        endMs: 90_000,
        durationMs: 30_000,
        ranges: [{ startMs: 60_000, endMs: 90_000 }],
        sourceRegionCount: 1,
      },
      {
        startMs: 90_000,
        endMs: 120_000,
        durationMs: 30_000,
        ranges: [{ startMs: 90_000, endMs: 120_000 }],
        sourceRegionCount: 1,
      },
      {
        startMs: 120_000,
        endMs: 150_000,
        durationMs: 30_000,
        ranges: [{ startMs: 120_000, endMs: 150_000 }],
        sourceRegionCount: 1,
      },
    ]);
  });

  it('returns no chunks when there are no processing regions', () => {
    expect(planAsrChunks([], options, 120_000)).toEqual([]);
  });
});
