export const RISK_MODEL = 'rules-risk-fusion/1.1.0';
const INCIDENT_GAP_MS = 15_000;
const MAX_INCIDENT_SPAN_MS = 30_000;
const DUPLICATE_GAP_MS = 2_000;
const severityRank: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface RiskCandidate {
  category?: string;
  confidence: number;
  endMs: number;
  evidenceText?: string;
  label: string;
  severity: string;
  source: 'transcript' | 'acoustic';
  startMs: number;
}

export interface AggregatedRiskIncident {
  confidence: number;
  endMs: number;
  evidence: RiskCandidate[];
  incidentType: string;
  modalities: Array<'transcript' | 'acoustic'>;
  rationale: string;
  severity: string;
  startMs: number;
}

export function aggregateRiskCandidates(
  input: RiskCandidate[],
): AggregatedRiskIncident[] {
  const candidates = deduplicateCandidates(input).sort(
    (left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs,
  );
  const groups: RiskCandidate[][] = [];
  for (const candidate of candidates) {
    const family = riskFamily(candidate);
    const group = [...groups].reverse().find((candidateGroup) => {
      const groupStart = Math.min(
        ...candidateGroup.map((item) => item.startMs),
      );
      const groupEnd = Math.max(
        ...candidateGroup.map((item) => item.endMs),
      );
      return (
        riskFamily(candidateGroup[0]) === family &&
        candidate.startMs <= groupEnd + INCIDENT_GAP_MS &&
        Math.max(groupEnd, candidate.endMs) - groupStart <=
          MAX_INCIDENT_SPAN_MS
      );
    });
    if (group) {
      group.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }
  return groups
    .map(buildIncident)
    .sort((left, right) => left.startMs - right.startMs);
}

function buildIncident(evidence: RiskCandidate[]): AggregatedRiskIncident {
  const modalities = [...new Set(evidence.map((item) => item.source))].sort();
  const primary = [...evidence].sort(
    (left, right) =>
      (severityRank[right.severity] ?? 0) -
        (severityRank[left.severity] ?? 0) ||
      right.confidence - left.confidence,
  )[0];
  const uniqueLabels = new Set(
    evidence.map((item) => `${item.source}:${item.label}`),
  ).size;
  const family = riskFamily(primary);
  const confidence = Math.min(
    0.98,
    Math.max(...evidence.map((item) => item.confidence)) +
      Math.min(0.08, Math.max(0, uniqueLabels - 1) * 0.04) +
      (modalities.length > 1 ? 0.08 : 0),
  );
  const maximumSeverity = evidence.reduce(
    (current, item) =>
      (severityRank[item.severity] ?? 0) > (severityRank[current] ?? 0)
        ? item.severity
        : current,
    'low',
  );
  const hasStrongTranscript = evidence.some(
    (item) =>
      item.source === 'transcript' &&
      item.confidence >= 0.7 &&
      (severityRank[item.severity] ?? 0) >= severityRank.medium,
  );
  const hasStrongAcoustic = evidence.some(
    (item) =>
      item.source === 'acoustic' &&
      item.confidence >= 0.7 &&
      (severityRank[item.severity] ?? 0) >= severityRank.medium,
  );
  let severity =
    family === 'personal_safety' &&
    hasStrongTranscript &&
    hasStrongAcoustic &&
    maximumSeverity === 'medium'
      ? 'high'
      : maximumSeverity;
  if (
    family === 'health' &&
    primary.label.toLocaleLowerCase() === 'cough' &&
    evidence.length >= 3 &&
    severity === 'low'
  ) {
    severity = 'medium';
  }
  const sourceText =
    modalities.length > 1
      ? 'Compatible transcript and acoustic evidence overlap in time'
      : `${modalities[0] === 'transcript' ? 'Transcript' : 'Acoustic'} evidence requires review`;
  const excerpt = primary.evidenceText?.trim();
  return {
    startMs: Math.min(...evidence.map((item) => item.startMs)),
    endMs: Math.max(...evidence.map((item) => item.endMs)),
    incidentType: primary.label,
    severity,
    confidence: Math.round(confidence * 10_000) / 10_000,
    modalities,
    evidence,
    rationale: `${sourceText}${excerpt ? `: “${excerpt.slice(0, 160)}”` : ''}; ${evidence.length} compatible signal${evidence.length === 1 ? '' : 's'} contributed.`,
  };
}

function deduplicateCandidates(input: RiskCandidate[]): RiskCandidate[] {
  const result: RiskCandidate[] = [];
  for (const candidate of [...input].sort(
    (left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs,
  )) {
    const duplicate = [...result].reverse().find(
      (item) =>
        item.source === candidate.source &&
        item.label === candidate.label &&
        candidate.startMs <= item.endMs + DUPLICATE_GAP_MS,
    );
    if (!duplicate) {
      result.push({ ...candidate });
      continue;
    }
    duplicate.startMs = Math.min(duplicate.startMs, candidate.startMs);
    duplicate.endMs = Math.max(duplicate.endMs, candidate.endMs);
    if (candidate.confidence > duplicate.confidence) {
      duplicate.confidence = candidate.confidence;
      duplicate.evidenceText =
        candidate.evidenceText ?? duplicate.evidenceText;
    }
  }
  return result;
}

function riskFamily(candidate: RiskCandidate): string {
  const label = candidate.label.toLocaleLowerCase();
  const category = candidate.category?.toLocaleLowerCase();
  if (
    candidate.source === 'transcript' &&
    ['profanity', 'profanity_exposure', 'insult'].includes(label)
  ) {
    return 'conduct';
  }
  if (
    candidate.source === 'transcript' ||
    category === 'distress_vocalization' ||
    category === 'impact'
  ) {
    return 'personal_safety';
  }
  if (category === 'health_sound') return 'health';
  if (category === 'alarm' || category === 'hazard') {
    return 'environmental_hazard';
  }
  return `acoustic:${category ?? label}`;
}
