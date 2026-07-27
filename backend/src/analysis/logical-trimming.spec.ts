import { createProcessingRegions } from './logical-trimming';

const options = {
  contextAfterMs: 400,
  contextBeforeMs: 250,
  maxGapMs: 500,
  minRegionMs: 500,
};

describe('createProcessingRegions', () => {
  it('merges nearby speech and adds context on the source timeline', () => {
    expect(
      createProcessingRegions(
        [
          { startMs: 1_000, endMs: 1_500, confidence: 0.8 },
          { startMs: 1_900, endMs: 2_200, confidence: 0.9 },
          { startMs: 5_000, endMs: 5_200, confidence: 0.7 },
        ],
        10_000,
        options,
      ),
    ).toEqual([
      { startMs: 750, endMs: 2_600, sourceIntervalCount: 2 },
      { startMs: 4_750, endMs: 5_600, sourceIntervalCount: 1 },
    ]);
  });

  it('clamps padding and minimum duration to media boundaries', () => {
    expect(
      createProcessingRegions(
        [{ startMs: 10, endMs: 50, confidence: 0.8 }],
        300,
        options,
      ),
    ).toEqual([{ startMs: 0, endMs: 300, sourceIntervalCount: 1 }]);
  });

  it('merges regions whose context padding overlaps', () => {
    expect(
      createProcessingRegions(
        [
          { startMs: 1_000, endMs: 1_100, confidence: 0.8 },
          { startMs: 1_700, endMs: 1_800, confidence: 0.8 },
        ],
        3_000,
        options,
      ),
    ).toEqual([
      { startMs: 750, endMs: 2_200, sourceIntervalCount: 2 },
    ]);
  });

  it('returns no processing regions when speech is absent', () => {
    expect(createProcessingRegions([], 10_000, options)).toEqual([]);
  });
});
