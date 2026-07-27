import { ProcessingRegion } from './logical-trimming';

export interface AsrRange {
  endMs: number;
  startMs: number;
}

export interface AsrChunk {
  durationMs: number;
  endMs: number;
  ranges: AsrRange[];
  sourceRegionCount: number;
  startMs: number;
}

export interface AsrChunkOptions {
  maxChunkMs: number;
}

export function planAsrChunks(
  regions: ProcessingRegion[],
  options: AsrChunkOptions,
  sourceDurationMs: number,
): AsrChunk[] {
  if (sourceDurationMs <= 0 || regions.length === 0) {
    return [];
  }
  const chunks = new Map<number, AsrChunk>();

  for (const region of [...regions].sort(
    (left, right) => left.startMs - right.startMs,
  )) {
    const firstWindowStart =
      Math.floor(region.startMs / options.maxChunkMs) *
      options.maxChunkMs;
    for (
      let startMs = firstWindowStart;
      startMs < region.endMs && startMs < sourceDurationMs;
      startMs += options.maxChunkMs
    ) {
      const endMs = Math.min(
        startMs + options.maxChunkMs,
        sourceDurationMs,
      );
      const existing = chunks.get(startMs);
      if (existing) {
        existing.sourceRegionCount += 1;
        continue;
      }
      chunks.set(startMs, {
        startMs,
        endMs,
        durationMs: endMs - startMs,
        ranges: [{ startMs, endMs }],
        sourceRegionCount: 1,
      });
    }
  }
  return [...chunks.values()].sort(
    (left, right) => left.startMs - right.startMs,
  );
}
