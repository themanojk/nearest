import { mergeAcousticEvents } from './acoustic-event.processor';

describe('mergeAcousticEvents', () => {
  it('merges adjacent detections with the same label', () => {
    const events = mergeAcousticEvents([
      {
        startMs: 1_000,
        endMs: 5_000,
        label: 'Screaming',
        category: 'distress_vocalization',
        severity: 'high',
        confidence: 0.7,
        sourceChunkId: 'one',
        modelName: 'model',
      },
      {
        startMs: 5_500,
        endMs: 8_000,
        label: 'Screaming',
        category: 'distress_vocalization',
        severity: 'high',
        confidence: 0.9,
        sourceChunkId: 'two',
        modelName: 'model',
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      startMs: 1_000,
      endMs: 8_000,
      confidence: 0.9,
    });
  });

  it('does not bridge distant original-timeline ranges', () => {
    const base = {
      label: 'Alarm',
      category: 'alarm',
      severity: 'medium',
      confidence: 0.8,
      sourceChunkId: 'one',
      modelName: 'model',
    };

    expect(
      mergeAcousticEvents([
        { ...base, startMs: 1_000, endMs: 2_000 },
        { ...base, startMs: 20_000, endMs: 21_000 },
      ]),
    ).toHaveLength(2);
  });
});
