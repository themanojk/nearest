import {
  indicator,
  loadAnalyses,
  uploadDay,
  type AnalysisInsight,
} from './insights';
import { authenticatedRequest } from './auth';
jest.mock('./auth', () => ({ authenticatedRequest: jest.fn() }));
const complete: AnalysisInsight = {
  analysisId: '1',
  childId: 'child',
  fileName: 'rec.wav',
  createdAt: '2026-10-16T06:00:00Z',
  status: 'COMPLETED',
  progress: 100,
  riskStage: { status: 'COMPLETED' },
  riskSummary: { incidentCount: 0, highSeverityCount: 0 },
};
test('normal requires completed risk assessment and its summary', () => {
  expect(indicator([complete])).toBe('Normal');
  expect(indicator([{ ...complete, riskStage: undefined }])).toBe('Processing');
  expect(indicator([{ ...complete, riskSummary: undefined }])).toBe(
    'Processing',
  );
  expect(indicator([])).toBe('No data');
});
test('failed and unfinished recordings cannot make a day normal', () => {
  expect(indicator([complete, { ...complete, status: 'FAILED' }])).toBe(
    'Analysis failed',
  );
  expect(
    indicator([complete, { ...complete, riskStage: { status: 'QUEUED' } }]),
  ).toBe('Processing');
});
test('real findings take precedence while other recordings are pending', () => {
  const pending = { ...complete, riskStage: undefined };
  expect(
    indicator([
      pending,
      { ...complete, riskSummary: { incidentCount: 2, highSeverityCount: 1 } },
    ]),
  ).toBe('Alert');
  expect(
    indicator([
      { ...complete, riskSummary: { incidentCount: 1, highSeverityCount: 0 } },
    ]),
  ).toBe('Needs review');
});
test('day grouping follows local calendar dates', () => {
  const date = new Date(2026, 9, 16, 0, 5);
  expect(uploadDay(date.toISOString())).toBe('2026-10-16');
});
test('fetches beyond the first page and removes overlapping records', async () => {
  (authenticatedRequest as jest.Mock)
    .mockResolvedValueOnce({ items: [complete], total: 101 })
    .mockResolvedValueOnce({
      items: [complete, { ...complete, analysisId: '2' }],
      total: 101,
    });
  expect((await loadAnalyses()).map(item => item.analysisId)).toEqual([
    '1',
    '2',
  ]);
  expect(authenticatedRequest).toHaveBeenLastCalledWith(
    '/audio-analysis?page=2&limit=100',
  );
});

test('clips use valid original recording offsets and clamp the end', () => {
  const { incidentClip } = require('./insights');
  const event = { startMs: 12000, endMs: 20000 };
  expect(incidentClip(event, 18000)).toEqual({ startMs: 12000, endMs: 18000 });
  expect(incidentClip(event)).toEqual(event);
  expect(incidentClip({ startMs: -1, endMs: 2000 })).toBeUndefined();
  expect(incidentClip({ startMs: 2000, endMs: 1000 })).toBeUndefined();
  expect(incidentClip({ startMs: NaN, endMs: 2000 })).toBeUndefined();
  expect(incidentClip(event, 10000)).toBeUndefined();
});
