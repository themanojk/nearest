import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { authenticatedRequest } from '../services/auth';
import {
  indicator,
  incidentClip,
  incidentLabel,
  insightLines,
  loadAnalyses,
  loadIncidents,
  uploadDay,
  type AnalysisInsight,
  type Incident,
} from '../services/insights';
import Glass from './Glass';
import Icon, { type IconName } from './Icon';
import InsightAudio from './InsightAudio';
import Txt from './Txt';
import Chip from './Chip';
import { colors, radii } from '../theme/theme';

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const offset = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(
    2,
    '0',
  )}`;
function Metric({ icon, label, value, detail }: { icon: IconName; label: string; value: string; detail: string }) {
  return <View style={{ width: '48%', flexGrow: 1, backgroundColor: colors.glassStrong, borderRadius: radii.cardSm, padding: 14, gap: 7 }}>
    <Icon name={icon} size={20} />
    <Txt size={23} weight="bold">{value}</Txt>
    <Txt size={12} weight="semibold">{label}</Txt>
    <Txt size={11} color={colors.body}>{detail}</Txt>
  </View>;
}
function Finding({ event, item }: { event: Incident; item: AnalysisInsight }) {
  const high = ['HIGH', 'CRITICAL'].includes(event.severity.toUpperCase());
  const clip = incidentClip(event, item.mediaMetadata?.durationMs);
  const tone = high ? colors.destructive : colors.warnDeep;
  return <View style={{ backgroundColor: high ? colors.highReviewBg : colors.warnSurfaceBg, borderRadius: radii.cardSm, padding: 14, gap: 9, borderLeftWidth: 3, borderLeftColor: tone }}>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Icon name="alert" size={20} color={tone} />
      <Txt size={12} weight="bold" color={tone}>{high ? 'High priority · Review first' : `${incidentLabel(event.severity)} priority · Review context`}</Txt>
    </View>
    <Txt size={16} weight="semibold">{incidentLabel(event.incidentType)}</Txt>
    <Txt size={12} weight="semibold">Why it was flagged</Txt>
    <Txt size={13} color={colors.body}>{event.rationale || 'Listen to the recording to understand the context.'}</Txt>
    <Txt size={11} color={colors.body}>
      {Number.isFinite(event.confidence) ? `Model confidence ${Math.round(Math.max(0, Math.min(1, event.confidence)) * 100)}% · ` : ''}Child involvement unconfirmed
    </Txt>
    {clip ? <InsightAudio id={item.analysisId} clip={clip} unavailable={item.audioDeletedAt ? 'Audio deleted' : undefined} />
      : <Txt size={12} color={colors.body}>Exact audio timing is unavailable. Use the full recording above.</Txt>}
  </View>;
}
function Badge({ items }: { items: AnalysisInsight[] }) {
  const label = indicator(items);
  return (
    <Chip
      label={label}
      bg={label === 'Alert' ? colors.highReviewBg : label === 'Needs review' ? colors.reviewBadgeBg : colors.tintChip}
      color={
        label === 'Alert' || label === 'Analysis failed'
          ? colors.destructive
          : label === 'Normal'
          ? colors.statusGreen
          : colors.body
      }
    />
  );
}
function RecordingInsight({ item }: { item: AnalysisInsight }) {
  const [expanded, setExpanded] = useState(false);
  const requestVersion = useRef(0);
  const requestedPage = useRef(1);
  useEffect(() => () => { requestVersion.current++; }, []);
  const [events, setEvents] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next: number) {
    requestedPage.current = next;
    const version = ++requestVersion.current;
    setBusy(true);
    setError('');
    try {
      const result = await loadIncidents(item.analysisId, next);
      if (version !== requestVersion.current) return;
      setEvents(old => (next === 1 ? result.items : [...old, ...result.items]));
      setTotal(result.total);
      setPage(next);
    } catch (err) {
      if (version === requestVersion.current) setError(errorText(err));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  return (
    <Glass variant="soft" radius={radii.cardSm} style={{ padding: 16, gap: 8 }}>
      <Txt size={14} weight="semibold">
        {item.fileName}
      </Txt>
      <Txt size={11} color={colors.muted}>
        Uploaded{' '}
        {new Date(item.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
        {item.mediaMetadata
          ? ` · ${offset(item.mediaMetadata.durationMs)} audio`
          : ''}
      </Txt>
      <View style={{ alignItems: 'flex-start' }}>
        <Badge items={[item]} />
      </View>
      <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}>
        <Icon name={item.riskStage?.status === 'COMPLETED' ? 'check' : 'clock'} size={16} />
        <Txt size={12} color={colors.body}>
          {item.status === 'FAILED' || item.riskStage?.status === 'FAILED' ? 'Analysis needs attention' : item.riskStage?.status === 'COMPLETED' ? 'Risk review complete' : item.status === 'AWAITING_UPLOAD' ? 'Waiting for upload' : `Reviewing audio · ${Math.round(Math.max(0, Math.min(100, item.progress || 0)))}%`}
        </Txt>
      </View>
      <InsightAudio
        id={item.analysisId}
        durationMs={item.mediaMetadata?.durationMs}
        unavailable={
          item.audioDeletedAt
            ? 'Audio deleted'
            : item.status === 'AWAITING_UPLOAD'
            ? 'Audio not uploaded yet'
            : undefined
        }
      />
      {insightLines(item).map(line => (
        <Txt key={line} size={12}>
          {line}
        </Txt>
      ))}
      {!!item.failureReason && (
        <Txt size={12} color={colors.destructive}>
          {item.failureReason}
        </Txt>
      )}
      {item.riskStage?.status === 'COMPLETED' && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded, busy }}
          disabled={busy}
          onPress={() => {
            setExpanded(!expanded);
            if (!expanded) void load(1);
          }}
          style={{ paddingVertical: 8 }}
        >
          <Txt size={13} color={colors.primaryGreenDark}>
            {expanded ? 'Hide flagged moments' : `Review flagged moments (${item.riskSummary?.incidentCount ?? 0})`}
          </Txt>
        </Pressable>
      )}
      {expanded && (
        <View style={{ gap: 10 }}>
          <Txt size={11} color={colors.muted}>
            High-priority moments appear first among loaded results. Times are positions within this recording.
          </Txt>
          {[...events].sort((a, b) => (['HIGH', 'CRITICAL'].includes(b.severity.toUpperCase()) ? 1 : 0) - (['HIGH', 'CRITICAL'].includes(a.severity.toUpperCase()) ? 1 : 0) || a.startMs - b.startMs).map(event => <Finding key={event.incidentId} event={event} item={item} />)}
          {busy && <Txt size={12}>Loading insights…</Txt>}
          {!!error && (
            <Pressable
              onPress={() => {
                void load(requestedPage.current);
              }}
            >
              <Txt size={12} color={colors.destructive}>
                {error} · Tap to retry
              </Txt>
            </Pressable>
          )}
          {!busy && !error && total === 0 && (
            <Txt size={12}>No flagged incidents in this recording.</Txt>
          )}
          {!busy && events.length < total && (
            <Pressable
              onPress={() => {
                void load(page + 1);
              }}
            >
              <Txt size={12}>Load more insights</Txt>
            </Pressable>
          )}
        </View>
      )}
    </Glass>
  );
}
export default function HomeInsights({
  refreshKey,
  paused,
  onCount,
}: {
  refreshKey: number;
  paused: boolean;
  onCount?: (count: number) => void;
}) {
  const [items, setItems] = useState<AnalysisInsight[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [child, setChild] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let running = false;
    const load = async () => {
      if (
        paused ||
        running ||
        (AppState.currentState !== null && AppState.currentState !== 'active')
      )
        return;
      running = true;
      if (alive) setLoading(true);
      try {
        const results = await loadAnalyses();
        if (alive) {
          setItems(results);
          onCount?.(
            results.filter(item => item.status !== 'AWAITING_UPLOAD').length,
          );
          setUpdated(new Date());
          setError('');
        }
      } catch (err) {
        if (alive) setError(errorText(err));
      } finally {
        running = false;
        if (alive) setLoading(false);
      }
    };
    refresh.current = () => {
      void load();
    };
    void load();
    // Refresh while open, including after background processing completes.
    const timer = setInterval(() => {
      void load();
    }, 15000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refreshKey, paused, onCount]);
  useEffect(() => {
    let alive = true;
    authenticatedRequest<{
      data: Array<{ id: string; name: string; nickname?: string }>;
    }>('/children')
      .then(result => {
        if (alive)
          setNames(
            Object.fromEntries(
              result.data.map(profile => [
                profile.id,
                profile.nickname || profile.name,
              ]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const children = [...new Set(items.map(item => item.childId))];
  const selected = children.includes(child) ? child : children[0];
  const childItems = items
    .filter(item => item.childId === selected)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const day = childItems[0] ? uploadDay(childItems[0].createdAt) : null;
  const recent = childItems.filter(item => uploadDay(item.createdAt) === day);
  const complete = recent.filter(
    item => item.riskStage?.status === 'COMPLETED' && item.riskSummary,
  ).length;
  const incidents = recent.reduce(
    (sum, item) => sum + (item.riskSummary?.incidentCount ?? 0),
    0,
  );
  const conversations = recent.reduce(
    (sum, item) => sum + (item.contextSummary?.flaggedSessionCount ?? 0),
    0,
  );
  const sounds = recent.reduce(
    (sum, item) => sum + (item.acousticSummary?.healthEventCount ?? 0),
    0,
  );
  const high = recent.reduce(
    (sum, item) => sum + (item.riskSummary?.highSeverityCount ?? 0),
    0,
  );
  const speechItems = recent.filter(item => item.scanSummary);
  const speechMs = speechItems.reduce((sum, item) => sum + (item.scanSummary?.speechDurationMs ?? 0), 0);
  const conversationItems = recent.filter(item => item.conversationSummary);
  const sessionCount = conversationItems.reduce((sum, item) => sum + (item.conversationSummary?.sessionCount ?? 0), 0);
  const durationItems = recent.filter(item => item.mediaMetadata);
  const durationTotal = durationItems.reduce((sum, item) => sum + (item.mediaMetadata?.durationMs ?? 0), 0);
  const coverage = (count: number) => `${count}/${recent.length} recordings available`;
  return (
    <View style={{ gap: 14 }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Txt weight="serif" size={21}>
          Daily insights
        </Txt>
        <Pressable
          disabled={loading || paused}
          accessibilityRole="button"
          onPress={() => refresh.current()}
          style={{ padding: 8 }}
        >
          <Txt size={12}>{loading ? 'Refreshing…' : 'Refresh'}</Txt>
        </Pressable>
      </View>
      {children.length > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {children.map(id => (
            <Pressable key={id} onPress={() => setChild(id)}>
              <Txt weight={id === selected ? 'bold' : 'regular'} size={12}>
                {names[id] || `Child ${id.slice(-6)}`}
              </Txt>
            </Pressable>
          ))}
        </View>
      )}
      {!!error && (
        <Txt size={12} color={colors.destructive}>
          Could not refresh insights: {error}.{' '}
          {updated ? 'Showing last loaded results.' : 'Tap Refresh to retry.'}
        </Txt>
      )}
      {paused && (
        <Txt size={12}>Results will refresh when syncing finishes.</Txt>
      )}
      <Glass
        variant="strong"
        radius={radii.card}
        shadow="card"
        style={{ padding: 20, gap: 10 }}
      >
        <Txt size={14} weight="semibold">
          {recent.length
            ? `${names[selected] || 'Latest day'} · ${new Date(
                recent[0].createdAt,
              ).toLocaleDateString()}`
            : 'No recordings yet'}
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name={indicator(recent) === 'Alert' ? 'alert' : 'shield'} size={28} color={indicator(recent) === 'Alert' ? colors.destructive : colors.primaryGreenDark} />
          <Badge items={recent} />
        </View>
        <Txt size={20} weight="semibold">
          {indicator(recent) === 'Alert' ? 'Some moments need a closer look' : indicator(recent) === 'Needs review' ? 'Listen and understand the context' : indicator(recent) === 'Normal' ? 'No risk incidents flagged' : 'Your audio review at a glance'}
        </Txt>
        <Txt size={13}>
          {recent.length
            ? `${complete}/${recent.length} recordings fully assessed · ${incidents} flagged incidents`
            : 'Upload a recording to see real analysis here.'}
        </Txt>
        {indicator(recent) === 'Normal' && (
          <Txt size={12}>No flagged incidents in the completed analysis.</Txt>
        )}
        {complete < recent.length && (
          <Txt size={12}>
            This overview is partial. Pending or failed analyses are not counted
            as normal.
          </Txt>
        )}
        <Txt size={11} color={colors.muted}>
          Grouped by upload day in your phone’s timezone. Recording dates are
          not available yet.
        </Txt>
        {updated && (
          <Txt size={10} color={colors.muted}>
            Updated {updated.toLocaleTimeString()}
          </Txt>
        )}
      </Glass>
      {recent.length > 0 && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Metric icon="alert" label="Risk moments" value={recent.some(i => i.riskSummary) ? String(incidents) : '—'} detail={`${high} high priority · ${complete}/${recent.length} assessed`} />
            <Metric icon="check" label="Review coverage" value={`${complete}/${recent.length}`} detail="Recordings with risk results" />
            <Metric icon="clock" label="Recorded audio" value={durationItems.length ? `${Math.round(durationTotal / 60000)} min` : '—'} detail={coverage(durationItems.length)} />
            <Metric icon="mic" label="Speech detected" value={speechItems.length ? `${Math.round(speechMs / 60000)} min` : '—'} detail={coverage(speechItems.length)} />
            <Metric icon="chat" label="Conversations" value={conversationItems.length ? String(sessionCount) : '—'} detail={`${conversations} flagged · ${coverage(conversationItems.length)}`} />
            <Metric icon="activity" label="Health-related sounds" value={recent.some(i => i.acousticSummary) ? String(sounds) : '—'} detail="Detected sounds, not a diagnosis" />
          </View>
          <Txt size={13}>
            {high > 0
              ? `${high} high-severity incidents need your review.`
              : incidents > 0
              ? `${incidents} incidents were flagged for review.`
              : complete === recent.length
              ? 'Completed recordings have no flagged risk incidents.'
              : 'Insights will appear as analysis completes.'}
          </Txt>
          <Txt size={13}>
            {conversations} conversations flagged · {sounds} health-related
            sound events. These may overlap with the risk incidents above.
          </Txt>
          <Txt size={12} color={colors.body}>
            An alert reflects model findings, not a confirmed event. Review the
            recording and supporting context.
          </Txt>
          <Txt size={17} weight="serif">
            Recordings & insights
          </Txt>
          {recent.map(item => (
            <RecordingInsight key={item.analysisId} item={item} />
          ))}
        </>
      )}
    </View>
  );
}
