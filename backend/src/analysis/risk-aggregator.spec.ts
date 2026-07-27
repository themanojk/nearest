import { aggregateRiskCandidates } from './risk-aggregator';

describe('aggregateRiskCandidates', () => {
  it('combines overlapping transcript and acoustic evidence', () => {
    const incidents = aggregateRiskCandidates([
      {
        startMs: 10_000,
        endMs: 12_000,
        source: 'transcript',
        label: 'threat',
        severity: 'medium',
        confidence: 0.7,
      },
      {
        startMs: 13_000,
        endMs: 16_000,
        source: 'acoustic',
        label: 'Screaming',
        category: 'distress_vocalization',
        severity: 'medium',
        confidence: 0.8,
      },
    ]);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      startMs: 10_000,
      endMs: 16_000,
      severity: 'high',
      modalities: ['acoustic', 'transcript'],
    });
    expect(incidents[0].confidence).toBeGreaterThan(0.9);
  });

  it('keeps temporally distant evidence in separate incidents', () => {
    const base = {
      source: 'acoustic' as const,
      label: 'Alarm',
      severity: 'medium',
      confidence: 0.8,
    };
    expect(
      aggregateRiskCandidates([
        { ...base, startMs: 1_000, endMs: 2_000 },
        { ...base, startMs: 30_000, endMs: 31_000 },
      ]),
    ).toHaveLength(2);
  });

  it('returns no incidents when screening found no evidence', () => {
    expect(aggregateRiskCandidates([])).toEqual([]);
  });

  it('does not fuse incompatible evidence just because it is nearby', () => {
    const incidents = aggregateRiskCandidates([
      {
        startMs: 10_000,
        endMs: 12_000,
        source: 'transcript',
        label: 'profanity_exposure',
        severity: 'medium',
        confidence: 0.9,
        evidenceText: 'explicit language',
      },
      {
        startMs: 11_000,
        endMs: 13_000,
        source: 'acoustic',
        label: 'Fire alarm',
        category: 'alarm',
        severity: 'high',
        confidence: 0.85,
      },
    ]);

    expect(incidents).toHaveLength(2);
    expect(incidents.map((item) => item.incidentType)).toEqual([
      'profanity_exposure',
      'Fire alarm',
    ]);
  });

  it('keeps an isolated cough low and escalates repeated cough episodes', () => {
    const cough = {
      source: 'acoustic' as const,
      label: 'Cough',
      category: 'health_sound',
      severity: 'low',
      confidence: 0.76,
    };

    expect(
      aggregateRiskCandidates([
        { ...cough, startMs: 1_000, endMs: 2_000 },
      ])[0].severity,
    ).toBe('low');
    expect(
      aggregateRiskCandidates([
        { ...cough, startMs: 1_000, endMs: 2_000 },
        { ...cough, startMs: 6_000, endMs: 7_000 },
        { ...cough, startMs: 11_000, endMs: 12_000 },
      ])[0].severity,
    ).toBe('medium');
  });

  it('deduplicates repeated labels without inflating confidence', () => {
    const incidents = aggregateRiskCandidates([
      {
        startMs: 1_000,
        endMs: 2_000,
        source: 'transcript',
        label: 'imminent_danger',
        severity: 'high',
        confidence: 0.94,
        evidenceText: 'I am in danger',
      },
      {
        startMs: 2_500,
        endMs: 3_500,
        source: 'transcript',
        label: 'imminent_danger',
        severity: 'high',
        confidence: 0.91,
        evidenceText: 'I am in danger',
      },
    ]);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].evidence).toHaveLength(1);
    expect(incidents[0].confidence).toBe(0.94);
    expect(incidents[0].rationale).toContain('I am in danger');
  });

  it('caps temporal chaining into bounded incidents', () => {
    const base = {
      source: 'transcript' as const,
      label: 'distress',
      severity: 'medium',
      confidence: 0.8,
    };
    expect(
      aggregateRiskCandidates([
        { ...base, startMs: 0, endMs: 1_000 },
        { ...base, startMs: 15_000, endMs: 16_000 },
        { ...base, startMs: 30_000, endMs: 31_000 },
      ]),
    ).toHaveLength(2);
  });
});
