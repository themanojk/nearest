import { SpeechIntervalResult } from './analysis.types';

export interface LogicalTrimmingOptions {
  contextAfterMs: number;
  contextBeforeMs: number;
  maxGapMs: number;
  minRegionMs: number;
}

export interface ProcessingRegion {
  endMs: number;
  sourceIntervalCount: number;
  startMs: number;
}

export function createProcessingRegions(
  intervals: SpeechIntervalResult[],
  durationMs: number,
  options: LogicalTrimmingOptions,
): ProcessingRegion[] {
  if (durationMs <= 0 || intervals.length === 0) {
    return [];
  }

  const valid = intervals
    .map(({ startMs, endMs }) => ({
      startMs: Math.max(0, Math.min(startMs, durationMs)),
      endMs: Math.max(0, Math.min(endMs, durationMs)),
      sourceIntervalCount: 1,
    }))
    .filter(({ startMs, endMs }) => endMs > startMs)
    .sort((left, right) => left.startMs - right.startMs);

  const mergedSpeech: ProcessingRegion[] = [];
  for (const interval of valid) {
    const previous = mergedSpeech.at(-1);
    if (previous && interval.startMs - previous.endMs <= options.maxGapMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
      previous.sourceIntervalCount += 1;
    } else {
      mergedSpeech.push({ ...interval });
    }
  }

  const padded = mergedSpeech.map((region) => {
    let startMs = Math.max(0, region.startMs - options.contextBeforeMs);
    let endMs = Math.min(durationMs, region.endMs + options.contextAfterMs);
    const missingDuration = options.minRegionMs - (endMs - startMs);
    if (missingDuration > 0) {
      const before = Math.floor(missingDuration / 2);
      const after = missingDuration - before;
      startMs = Math.max(0, startMs - before);
      endMs = Math.min(durationMs, endMs + after);

      const stillMissing = options.minRegionMs - (endMs - startMs);
      if (stillMissing > 0) {
        if (startMs === 0) {
          endMs = Math.min(durationMs, endMs + stillMissing);
        } else {
          startMs = Math.max(0, startMs - stillMissing);
        }
      }
    }
    return { ...region, startMs, endMs };
  });

  const regions: ProcessingRegion[] = [];
  for (const region of padded) {
    const previous = regions.at(-1);
    if (previous && region.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
      previous.sourceIntervalCount += region.sourceIntervalCount;
    } else {
      regions.push({ ...region });
    }
  }
  return regions;
}
