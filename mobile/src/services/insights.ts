import { authenticatedRequest } from './auth';
export type AnalysisInsight = {
  audioDeletedAt?: string;
  analysisId: string;
  childId: string;
  fileName: string;
  createdAt: string;
  status: string;
  progress: number;
  failureReason?: string;
  conversationStage?: { status: string };
  riskStage?: { status: string };
  riskSummary?: { incidentCount: number; highSeverityCount: number };
  contextStage?: { status: string };
  contextSummary?: {
    flaggedSessionCount: number;
    highSeverityCount: number;
    profanityOccurrenceCount: number;
  };
  acousticStage?: { status: string };
  acousticSummary?: { healthEventCount: number; highSeverityCount: number };
  scanSummary?: { speechDurationMs: number; decodedDurationMs: number };
  conversationSummary?: { sessionCount: number; utteranceCount: number };
  transcriptionSummary?: { wordCount: number };
  mediaMetadata?: { durationMs: number };
};
export type Incident = {
  incidentId: string;
  incidentType: string;
  severity: string;
  rationale: string;
  startMs: number;
  endMs: number;
  confidence: number;
};
export type Indicator =
  | 'Alert'
  | 'Needs review'
  | 'Analysis failed'
  | 'Processing'
  | 'Normal'
  | 'No data';
export function indicator(items: AnalysisInsight[]): Indicator {
  if (!items.length) return 'No data';
  if (
    items.some(
      item =>
        (item.riskSummary?.highSeverityCount ?? 0) > 0 ||
        (item.contextSummary?.highSeverityCount ?? 0) > 0 ||
        (item.acousticSummary?.highSeverityCount ?? 0) > 0,
    )
  )
    return 'Alert';
  if (
    items.some(
      item =>
        (item.riskSummary?.incidentCount ?? 0) > 0 ||
        (item.contextSummary?.flaggedSessionCount ?? 0) > 0 ||
        (item.acousticSummary?.healthEventCount ?? 0) > 0,
    )
  )
    return 'Needs review';
  if (
    items.some(
      item =>
        item.status === 'FAILED' ||
        [item.riskStage, item.contextStage, item.acousticStage].some(
          stage => stage?.status === 'FAILED',
        ),
    )
  )
    return 'Analysis failed';
  if (
    items.some(
      item => item.riskStage?.status !== 'COMPLETED' || !item.riskSummary,
    )
  )
    return 'Processing';
  return 'Normal';
}
export function uploadDay(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')}`;
}
export async function loadAnalyses(): Promise<AnalysisInsight[]> {
  const result: AnalysisInsight[] = [];
  for (let page = 1; ; page++) {
    const response = await authenticatedRequest<{
      items: AnalysisInsight[];
      total: number;
    }>(`/audio-analysis?page=${page}&limit=100`);
    result.push(...response.items);
    if (!response.items.length || page * 100 >= response.total) break;
  }
  return [...new Map(result.map(item => [item.analysisId, item])).values()];
}
export function loadIncidents(id: string, page = 1) {
  return authenticatedRequest<{ items: Incident[]; total: number }>(
    `/audio-analysis/${encodeURIComponent(
      id,
    )}/risk-incidents?page=${page}&limit=20`,
  );
}
export function insightLines(item: AnalysisInsight): string[] {
  const lines: string[] = [];
  if (item.riskSummary)
    lines.push(
      `${item.riskSummary.incidentCount} flagged incidents · ${item.riskSummary.highSeverityCount} high severity`,
    );
  if (item.contextSummary)
    lines.push(
      `${item.contextSummary.flaggedSessionCount} conversations flagged · ${item.contextSummary.profanityOccurrenceCount} profanity occurrences`,
    );
  if (item.acousticSummary)
    lines.push(
      `${item.acousticSummary.healthEventCount} health-related sound events`,
    );
  return lines;
}

export function incidentLabel(value: string): string {
  const labels: Record<string, string> = {
    insult: 'Insulting language', coercion: 'Pressure or blackmail',
    unsafe_contact: 'Potentially unsafe contact request', substance_pressure: 'Pressure to try substances',
    medical_distress: 'Possible urgent physical distress', neglect_disclosure: 'Possible unmet care needs',
    secrecy_request: 'Request to keep a secret', violence_disclosure: 'Reported physical harm',
    inappropriate_request: 'Inappropriate personal request', threat: 'Threatening language',
    imminent_danger: 'Possible immediate danger', self_harm: 'Self-harm-related language',
    profanity_exposure: 'Repeated or strong profanity',
    verbal_aggression: 'Aggressive language', bullying: 'Possible bullying',
    profanity: 'Strong language', distress: 'Signs of distress',
    physical_threat: 'Possible physical threat', health_concern: 'Health-related sounds',
  };
  const normalized = value.toLowerCase();
  return labels[normalized] || normalized.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
export function incidentClip(event: Incident, durationMs?: number) {
  if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.startMs < 0 || event.endMs <= event.startMs) return undefined;
  if (durationMs !== undefined && durationMs > 0 && event.startMs >= durationMs) return undefined;
  return { startMs: event.startMs, endMs: Math.min(event.endMs, durationMs && durationMs > 0 ? durationMs : event.endMs) };
}

export function regenerateInsights(id: string): Promise<AnalysisInsight> {
  return authenticatedRequest<AnalysisInsight>(
    `/audio-analysis/${encodeURIComponent(id)}/classify-context`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) },
  );
}
