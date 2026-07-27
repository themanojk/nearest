import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  completeUpload,
  createAnalysis,
  getAudioPlayback,
  getAnalysis,
  getAnalyses,
  getConversations,
  getScanWindows,
  getSegments,
  getTranscriptions,
  getTimelineEvents,
  getAcousticEvents,
  getRiskIncidents,
  startDiarization,
  startContextClassification,
  startAcousticDetection,
  startRiskAggregation,
  uploadFile,
} from './api';
import { AudioPlayer } from './components/AudioPlayer';
import { DecibelOverview } from './components/DecibelOverview';
import { StageCard } from './components/StageCard';
import type {
  Analysis,
  AcousticEvent,
  RiskIncident,
  ConversationSession,
  Segment,
  StageStatus,
  TimelineEvent,
  TranscriptionChunk,
} from './types';

type UiPhase =
  | 'IDLE'
  | 'PREPARING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED';

interface ActivityItem {
  id: number;
  message: string;
  time: string;
}

const SEGMENTS_PER_PAGE = 300;

const contentTypes: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

function getOrCreateTenantId() {
  const existing = window.localStorage.getItem('kid-audio-tenant');
  if (existing) {
    return existing;
  }
  const tenantId = `browser-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  window.localStorage.setItem('kid-audio-tenant', tenantId);
  return tenantId;
}

function inferContentType(file: File) {
  if (file.type.startsWith('audio/')) {
    return file.type;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return contentTypes[extension];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${seconds}s`;
}

function formatTimestamp(milliseconds: number) {
  const totalSeconds = milliseconds / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText =
    hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${minuteText}:${seconds.toFixed(1).padStart(4, '0')}`
    : `${minuteText}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function stageDetail(status: StageStatus, attempts: number, complete: string) {
  if (status === 'COMPLETED') return complete;
  if (status === 'RUNNING') return `Attempt ${Math.max(attempts, 1)} is active`;
  if (status === 'FAILED') return `Stopped after ${attempts} attempts`;
  if (status === 'QUEUED' || status === 'QUEUEING') return 'Waiting for a worker';
  return 'Not started yet';
}

function maskSensitiveTerm(term: string) {
  if (term.length <= 2) return '*'.repeat(term.length);
  return `${term[0]}${'*'.repeat(Math.min(8, term.length - 2))}${term.at(-1)}`;
}

export function App() {
  const [tenantId] = useState(getOrCreateTenantId);
  const [childId, setChildId] = useState('child-001');
  const [transcriptionLanguageMode, setTranscriptionLanguageMode] =
    useState<'AUTO' | 'ENGLISH' | 'HINDI_HINGLISH'>('AUTO');
  const [file, setFile] = useState<File>();
  const [phase, setPhase] = useState<UiPhase>('IDLE');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis>();
  const [storedAnalyses, setStoredAnalyses] = useState<Analysis[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState('');
  const [storedAnalysesLoading, setStoredAnalysesLoading] = useState(true);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [scanWindows, setScanWindows] = useState<Segment[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionChunk[]>([]);
  const [transcriptionTotal, setTranscriptionTotal] = useState(0);
  const [conversations, setConversations] = useState<ConversationSession[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [timelineEventTotal, setTimelineEventTotal] = useState(0);
  const [acousticEvents, setAcousticEvents] = useState<AcousticEvent[]>([]);
  const [acousticEventTotal, setAcousticEventTotal] = useState(0);
  const [riskIncidents, setRiskIncidents] = useState<RiskIncident[]>([]);
  const [riskIncidentTotal, setRiskIncidentTotal] = useState(0);
  const [segmentPage, setSegmentPage] = useState(1);
  const [segmentTotal, setSegmentTotal] = useState(0);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [regionsExpanded, setRegionsExpanded] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [playbackError, setPlaybackError] = useState<string>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string>();
  const runToken = useRef(0);
  const previousStages = useRef<Record<string, string>>({});
  const activityId = useRef(0);
  const scanResultsLoaded = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackAnalysisId = analysis?.mediaMetadata
    ? analysis.analysisId
    : undefined;

  useEffect(
    () => () => {
      runToken.current += 1;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void getAnalyses(tenantId)
      .then((page) => {
        if (!active) return;
        const reusable = page.items
          .filter(
            (item) => item.transcriptionStage.status === 'COMPLETED',
          )
          .sort((left, right) => {
            const enrichmentScore = (item: Analysis) =>
              Number(item.riskStage.status === 'COMPLETED') * 16 +
              Number(item.acousticStage.status === 'COMPLETED') * 8 +
              Number(item.contextStage.status === 'COMPLETED') * 4 +
              Number(item.conversationStage.status === 'COMPLETED') * 2 +
              Number(item.diarizationStage.status === 'COMPLETED');
            return (
              enrichmentScore(right) - enrichmentScore(left) ||
              Date.parse(right.createdAt) - Date.parse(left.createdAt)
            );
          });
        setStoredAnalyses(reusable);
        setSelectedAnalysisId(
          (current) => current || reusable[0]?.analysisId || '',
        );
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load stored analyses',
        );
      })
      .finally(() => {
        if (active) setStoredAnalysesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId]);

  useEffect(() => {
    let active = true;
    if (!playbackAnalysisId) {
      return () => {
        active = false;
      };
    }
    void getAudioPlayback(tenantId, playbackAnalysisId)
      .then((playback) => {
        if (active) setPlaybackUrl(playback.url);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setPlaybackError(
          caught instanceof Error
            ? caught.message
            : 'Could not load the original recording',
        );
      })
    return () => {
      active = false;
    };
  }, [playbackAnalysisId, tenantId]);

  const segmentPageCount = useMemo(
    () => Math.max(1, Math.ceil(segmentTotal / SEGMENTS_PER_PAGE)),
    [segmentTotal],
  );

  function addActivity(message: string) {
    activityId.current += 1;
    setActivity((current) =>
      [
        {
          id: activityId.current,
          message,
          time: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 30),
    );
  }

  function playAudioAt(startMs: number) {
    const audio = audioRef.current;
    if (!audio || !playbackUrl) {
      setPlaybackError('The original recording is still loading.');
      return;
    }
    const startSeconds = Math.max(0, startMs / 1000);
    setPlaybackError(undefined);
    try {
      audio.currentTime = Math.min(
        startSeconds,
        Number.isFinite(audio.duration) ? audio.duration : startSeconds,
      );
      void audio.play().catch(() => {
        setPlaybackError(
          'Playback could not start. Press play in the audio player.',
        );
      });
    } catch {
      setPlaybackError('Could not jump to this timestamp.');
    }
  }

  function recordStageTransitions(snapshot: Analysis) {
    const nextStages = {
      analysis: snapshot.status,
      ingest: snapshot.ingestStage.status,
      scan: snapshot.scanStage.status,
      transcription: snapshot.transcriptionStage.status,
      diarization: snapshot.diarizationStage.status,
      conversations: snapshot.conversationStage.status,
      context: snapshot.contextStage.status,
      acoustic: snapshot.acousticStage.status,
      risk: snapshot.riskStage.status,
    };
    Object.entries(nextStages).forEach(([name, status]) => {
      if (
        previousStages.current[name] &&
        previousStages.current[name] !== status
      ) {
        addActivity(`${name} changed to ${status.toLowerCase()}`);
      }
    });
    previousStages.current = nextStages;
  }

  async function pollAnalysis(
    analysisId: string,
    token: number,
  ): Promise<void> {
    while (token === runToken.current) {
      const snapshot = await getAnalysis(tenantId, analysisId);
      if (token !== runToken.current) return;
      setAnalysis(snapshot);
      recordStageTransitions(snapshot);

      if (
        snapshot.scanStage.status === 'COMPLETED' &&
        !scanResultsLoaded.current
      ) {
        const [page, windows] = await Promise.all([
          getSegments(
            tenantId,
            analysisId,
            1,
            SEGMENTS_PER_PAGE,
            'PROCESSING_REGION',
          ),
          getScanWindows(tenantId, analysisId),
        ]);
        if (token !== runToken.current) return;
        setSegments(page.items);
        setScanWindows(windows);
        setSegmentPage(page.page);
        setSegmentTotal(page.total);
        scanResultsLoaded.current = true;
      }

      if (snapshot.conversationStage.status === 'COMPLETED') {
        const conversationPage = await getConversations(
          tenantId,
          analysisId,
        );
        if (token !== runToken.current) return;
        setConversations(conversationPage.items);
        setConversationTotal(conversationPage.total);
      }

      if (snapshot.contextStage.status === 'COMPLETED') {
        const eventPage = await getTimelineEvents(tenantId, analysisId);
        if (token !== runToken.current) return;
        setTimelineEvents(eventPage.items);
        setTimelineEventTotal(eventPage.total);
      }

      if (snapshot.acousticStage.status === 'COMPLETED') {
        const eventPage = await getAcousticEvents(tenantId, analysisId);
        if (token !== runToken.current) return;
        setAcousticEvents(eventPage.items);
        setAcousticEventTotal(eventPage.total);
      }

      if (snapshot.riskStage.status === 'COMPLETED') {
        const incidentPage = await getRiskIncidents(tenantId, analysisId);
        if (token !== runToken.current) return;
        setRiskIncidents(incidentPage.items);
        setRiskIncidentTotal(incidentPage.total);
      }

      if (
        snapshot.transcriptionStage.status === 'RUNNING' ||
        snapshot.transcriptionStage.status === 'QUEUED' ||
        snapshot.transcriptionStage.status === 'COMPLETED'
      ) {
        const transcriptPage = await getTranscriptions(
          tenantId,
          analysisId,
        );
        if (token !== runToken.current) return;
        setTranscriptions(transcriptPage.items);
        setTranscriptionTotal(transcriptPage.total);
      }

      if (
        snapshot.status === 'FAILED' ||
        snapshot.scanStage.status === 'FAILED' ||
        snapshot.transcriptionStage.status === 'FAILED' ||
        snapshot.diarizationStage.status === 'FAILED' ||
        snapshot.conversationStage.status === 'FAILED' ||
        snapshot.contextStage.status === 'FAILED' ||
        snapshot.acousticStage.status === 'FAILED'
        || snapshot.riskStage.status === 'FAILED'
      ) {
        setPhase('FAILED');
        throw new Error('Audio processing failed. Check the backend logs.');
      }
      const enrichmentRunning = [
        snapshot.diarizationStage.status,
        snapshot.contextStage.status,
        snapshot.acousticStage.status,
        snapshot.riskStage.status,
      ].some((status) => status === 'RUNNING' || status === 'QUEUED');
      if (
        !enrichmentRunning &&
        snapshot.transcriptionStage.status === 'COMPLETED'
      ) {
        setPhase('READY');
        addActivity('Analysis results are ready');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !childId.trim()) return;

    const contentType = inferContentType(file);
    if (!contentType) {
      setError('Choose a supported WAV, MP3, M4A, AAC, FLAC, OGG, or WebM file.');
      return;
    }

    runToken.current += 1;
    const token = runToken.current;
    previousStages.current = {};
    scanResultsLoaded.current = false;
    setAnalysis(undefined);
    setSegments([]);
    setScanWindows([]);
    setTranscriptions([]);
    setTranscriptionTotal(0);
    setConversations([]);
    setConversationTotal(0);
    setTimelineEvents([]);
    setTimelineEventTotal(0);
    setAcousticEvents([]);
    setAcousticEventTotal(0);
    setRiskIncidents([]);
    setRiskIncidentTotal(0);
    setSegmentPage(1);
    setSegmentTotal(0);
    setSegmentsLoading(false);
    setRegionsExpanded(false);
    setTranscriptExpanded(false);
    setPlaybackUrl('');
    setPlaybackError(undefined);
    setActivity([]);
    setUploadProgress(0);
    setError(undefined);
    setPhase('PREPARING');

    try {
      addActivity('Creating analysis job');
      const created = await createAnalysis(tenantId, {
        childId: childId.trim(),
        fileName: file.name,
        contentType,
        sizeBytes: file.size,
        transcriptionLanguageMode,
      });
      if (token !== runToken.current) return;
      setAnalysis(created);
      previousStages.current = {
        analysis: created.status,
        ingest: created.ingestStage.status,
        scan: created.scanStage.status,
        transcription: created.transcriptionStage.status,
        diarization: created.diarizationStage.status,
        conversations: created.conversationStage.status,
        context: created.contextStage.status,
        acoustic: created.acousticStage.status,
        risk: created.riskStage.status,
      };

      setPhase('UPLOADING');
      addActivity(`Uploading ${formatBytes(file.size)} directly to object storage`);
      await uploadFile(created.upload, file, setUploadProgress);
      if (token !== runToken.current) return;

      addActivity('Upload complete; requesting object verification');
      const queued = await completeUpload(tenantId, created.analysisId);
      if (token !== runToken.current) return;
      setAnalysis(queued);
      recordStageTransitions(queued);
      setPhase('PROCESSING');
      addActivity('Ingestion job submitted');
      await pollAnalysis(created.analysisId, token);
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error ? caught.message : 'Unexpected processing error';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  async function openStoredAnalysis() {
    if (!selectedAnalysisId) return;
    runToken.current += 1;
    const token = runToken.current;
    previousStages.current = {};
    scanResultsLoaded.current = false;
    setFile(undefined);
    setSegments([]);
    setScanWindows([]);
    setTranscriptions([]);
    setTranscriptionTotal(0);
    setConversations([]);
    setConversationTotal(0);
    setTimelineEvents([]);
    setTimelineEventTotal(0);
    setAcousticEvents([]);
    setAcousticEventTotal(0);
    setRiskIncidents([]);
    setRiskIncidentTotal(0);
    setSegmentPage(1);
    setSegmentTotal(0);
    setRegionsExpanded(false);
    setTranscriptExpanded(false);
    setPlaybackUrl('');
    setPlaybackError(undefined);
    setUploadProgress(100);
    setError(undefined);
    setPhase('PROCESSING');

    try {
      const snapshot = await getAnalysis(tenantId, selectedAnalysisId);
      if (token !== runToken.current) return;
      setAnalysis(snapshot);
      previousStages.current = {
        analysis: snapshot.status,
        ingest: snapshot.ingestStage.status,
        scan: snapshot.scanStage.status,
        transcription: snapshot.transcriptionStage.status,
        diarization: snapshot.diarizationStage.status,
        conversations: snapshot.conversationStage.status,
        context: snapshot.contextStage.status,
        acoustic: snapshot.acousticStage.status,
        risk: snapshot.riskStage.status,
      };

      const requests: Array<Promise<void>> = [];
      if (snapshot.scanStage.status === 'COMPLETED') {
        requests.push(
          Promise.all([
            getSegments(
              tenantId,
              snapshot.analysisId,
              1,
              SEGMENTS_PER_PAGE,
              'PROCESSING_REGION',
            ),
            getScanWindows(tenantId, snapshot.analysisId),
          ]).then(([page, windows]) => {
            if (token !== runToken.current) return;
            setSegments(page.items);
            setScanWindows(windows);
            setSegmentPage(page.page);
            setSegmentTotal(page.total);
            scanResultsLoaded.current = true;
          }),
        );
      }
      if (
        snapshot.transcriptionStage.status === 'COMPLETED' ||
        snapshot.transcriptionStage.status === 'RUNNING'
      ) {
        requests.push(
          getTranscriptions(tenantId, snapshot.analysisId).then((page) => {
            if (token !== runToken.current) return;
            setTranscriptions(page.items);
            setTranscriptionTotal(page.total);
          }),
        );
      }
      if (snapshot.conversationStage.status === 'COMPLETED') {
        requests.push(
          getConversations(tenantId, snapshot.analysisId).then((page) => {
            if (token !== runToken.current) return;
            setConversations(page.items);
            setConversationTotal(page.total);
          }),
        );
      }
      if (snapshot.contextStage.status === 'COMPLETED') {
        requests.push(
          getTimelineEvents(tenantId, snapshot.analysisId).then((page) => {
            if (token !== runToken.current) return;
            setTimelineEvents(page.items);
            setTimelineEventTotal(page.total);
          }),
        );
      }
      if (snapshot.acousticStage.status === 'COMPLETED') {
        requests.push(
          getAcousticEvents(tenantId, snapshot.analysisId).then((page) => {
            if (token !== runToken.current) return;
            setAcousticEvents(page.items);
            setAcousticEventTotal(page.total);
          }),
        );
      }
      if (snapshot.riskStage.status === 'COMPLETED') {
        requests.push(
          getRiskIncidents(tenantId, snapshot.analysisId).then((page) => {
            if (token !== runToken.current) return;
            setRiskIncidents(page.items);
            setRiskIncidentTotal(page.total);
          }),
        );
      }
      await Promise.all(requests);
      if (token !== runToken.current) return;

      const stillProcessing =
        snapshot.status === 'PROCESSING' ||
        snapshot.status === 'QUEUED' ||
        snapshot.status === 'QUEUEING';
      if (stillProcessing) {
        addActivity(`Resumed ${snapshot.fileName}`);
        await pollAnalysis(snapshot.analysisId, token);
      } else {
        setPhase(snapshot.status === 'FAILED' ? 'FAILED' : 'READY');
        addActivity(`Loaded stored analysis ${snapshot.fileName}`);
      }
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not open the stored analysis';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  function reset() {
    runToken.current += 1;
    setPhase('IDLE');
    setFile(undefined);
    setAnalysis(undefined);
    setSegments([]);
    setScanWindows([]);
    setTranscriptions([]);
    setTranscriptionTotal(0);
    setConversations([]);
    setConversationTotal(0);
    setTimelineEvents([]);
    setTimelineEventTotal(0);
    setAcousticEvents([]);
    setAcousticEventTotal(0);
    setRiskIncidents([]);
    setRiskIncidentTotal(0);
    setSegmentPage(1);
    setSegmentTotal(0);
    setSegmentsLoading(false);
    setRegionsExpanded(false);
    setTranscriptExpanded(false);
    setPlaybackUrl('');
    setPlaybackError(undefined);
    setActivity([]);
    setUploadProgress(0);
    setError(undefined);
    previousStages.current = {};
    scanResultsLoaded.current = false;
  }

  async function changeSegmentPage(nextPage: number) {
    if (
      !analysis ||
      nextPage < 1 ||
      nextPage > segmentPageCount ||
      segmentsLoading
    ) {
      return;
    }
    setSegmentsLoading(true);
    try {
      const page = await getSegments(
        tenantId,
        analysis.analysisId,
        nextPage,
        SEGMENTS_PER_PAGE,
        'PROCESSING_REGION',
      );
      setSegments(page.items);
      setSegmentPage(page.page);
      setSegmentTotal(page.total);
      document
        .querySelector('.timeline')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not load the requested segment page',
      );
    } finally {
      setSegmentsLoading(false);
    }
  }

  async function refreshCompletedAnalysis() {
    if (!analysis || segmentsLoading) return;
    setSegmentsLoading(true);
    try {
      const snapshot = await getAnalysis(tenantId, analysis.analysisId);
      const [
        page,
        windows,
        transcriptPage,
        conversationPage,
        eventPage,
        acousticPage,
        incidentPage,
      ] = await Promise.all([
        getSegments(
          tenantId,
          analysis.analysisId,
          1,
          SEGMENTS_PER_PAGE,
          'PROCESSING_REGION',
        ),
        getScanWindows(tenantId, analysis.analysisId),
        getTranscriptions(tenantId, analysis.analysisId),
        getConversations(tenantId, analysis.analysisId),
        getTimelineEvents(tenantId, analysis.analysisId),
        getAcousticEvents(tenantId, analysis.analysisId),
        getRiskIncidents(tenantId, analysis.analysisId),
      ]);
      setAnalysis(snapshot);
      setSegments(page.items);
      setScanWindows(windows);
      setSegmentPage(page.page);
      setSegmentTotal(page.total);
      setTranscriptions(transcriptPage.items);
      setTranscriptionTotal(transcriptPage.total);
      setConversations(conversationPage.items);
      setConversationTotal(conversationPage.total);
      setTimelineEvents(eventPage.items);
      setTimelineEventTotal(eventPage.total);
      setAcousticEvents(acousticPage.items);
      setAcousticEventTotal(acousticPage.total);
      setRiskIncidents(incidentPage.items);
      setRiskIncidentTotal(incidentPage.total);
      scanResultsLoaded.current = true;
      addActivity('Analysis results refreshed');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not refresh analysis results',
      );
    } finally {
      setSegmentsLoading(false);
    }
  }

  async function beginDiarization(force = false) {
    if (!analysis) return;
    runToken.current += 1;
    const token = runToken.current;
    setError(undefined);
    setPhase('PROCESSING');
    try {
      addActivity('Submitting speaker diarization');
      const queued = await startDiarization(
        tenantId,
        analysis.analysisId,
        force,
      );
      if (token !== runToken.current) return;
      setAnalysis(queued);
      recordStageTransitions(queued);
      await pollAnalysis(analysis.analysisId, token);
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not start speaker diarization';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  async function beginContextClassification(force = false) {
    if (!analysis) return;
    runToken.current += 1;
    const token = runToken.current;
    setError(undefined);
    setPhase('PROCESSING');
    try {
      addActivity('Submitting transcript quality and safety screening');
      const queued = await startContextClassification(
        tenantId,
        analysis.analysisId,
        force,
      );
      if (token !== runToken.current) return;
      setAnalysis(queued);
      recordStageTransitions(queued);
      await pollAnalysis(analysis.analysisId, token);
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not start context classification';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  async function beginAcousticDetection(force = false) {
    if (!analysis) return;
    runToken.current += 1;
    const token = runToken.current;
    setError(undefined);
    setPhase('PROCESSING');
    try {
      addActivity('Submitting retained audio for acoustic-event detection');
      const queued = await startAcousticDetection(
        tenantId,
        analysis.analysisId,
        force,
      );
      if (token !== runToken.current) return;
      setAnalysis(queued);
      recordStageTransitions(queued);
      await pollAnalysis(analysis.analysisId, token);
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not start acoustic-event detection';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  async function beginRiskAggregation(force = false) {
    if (!analysis) return;
    runToken.current += 1;
    const token = runToken.current;
    setError(undefined);
    setPhase('PROCESSING');
    try {
      addActivity('Combining transcript and acoustic evidence');
      const queued = await startRiskAggregation(
        tenantId,
        analysis.analysisId,
        force,
      );
      if (token !== runToken.current) return;
      setAnalysis(queued);
      recordStageTransitions(queued);
      await pollAnalysis(analysis.analysisId, token);
    } catch (caught) {
      if (token !== runToken.current) return;
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not aggregate risk incidents';
      setError(message);
      setPhase('FAILED');
      addActivity(message);
    }
  }

  const uploadStatus: StageStatus | 'UPLOADING' =
    phase === 'FAILED' && !analysis
      ? 'FAILED'
      : uploadProgress === 100
        ? 'COMPLETED'
        : phase === 'UPLOADING'
          ? 'UPLOADING'
          : 'PENDING';
  const profanityOccurrences = conversations.flatMap((session) =>
    (session.profanity?.occurrences ?? []).map((occurrence) => ({
      ...occurrence,
      sessionId: session.sessionId,
    })),
  );
  const healthEvents = acousticEvents.filter(
    (event) => event.category === 'health_sound',
  );
  const nonHealthAcousticEvents = acousticEvents.filter(
    (event) => event.category !== 'health_sound',
  );

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Kid Audio Intelligence</p>
          <h1>Audio processing, made visible.</h1>
        </div>
        <div className={`live-indicator live-${phase.toLowerCase()}`}>
          <span />
          {phase === 'IDLE' ? 'Ready for audio' : phase.toLowerCase()}
        </div>
      </header>

      <section className="workspace">
        <form className="upload-panel" onSubmit={handleSubmit}>
          <div className="section-heading">
            <div>
              <p className="section-kicker">Saved or new</p>
              <h2>Choose an analysis</h2>
            </div>
            <span className="tenant-label">Local workspace</span>
          </div>

          <div className="stored-analysis">
            <label className="field">
              <span>Use processed data</span>
              <select
                value={selectedAnalysisId}
                onChange={(event) => setSelectedAnalysisId(event.target.value)}
                disabled={storedAnalysesLoading || storedAnalyses.length === 0}
              >
                {storedAnalyses.length === 0 ? (
                  <option value="">
                    {storedAnalysesLoading
                      ? 'Loading stored analyses…'
                      : 'No completed transcripts'}
                  </option>
                ) : (
                  storedAnalyses.map((item) => (
                    <option value={item.analysisId} key={item.analysisId}>
                      {item.fileName} · {item.transcriptionSummary?.wordCount ?? 0}{' '}
                      words · {item.analysisId.slice(-8)} ·{' '}
                      {new Date(item.createdAt).toLocaleString()}
                    </option>
                  ))
                )}
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={!selectedAnalysisId || storedAnalysesLoading}
              onClick={() => void openStoredAnalysis()}
            >
              Open processed analysis
            </button>
            <p>
              Loads saved results only. Upload, scanning, and transcription
              will not run again.
            </p>
          </div>

          <div className="form-divider">
            <span>or process a new recording</span>
          </div>

          <label className="field">
            <span>Child reference</span>
            <input
              value={childId}
              onChange={(event) => setChildId(event.target.value)}
              maxLength={128}
              disabled={phase !== 'IDLE' && phase !== 'READY' && phase !== 'FAILED'}
              required
            />
          </label>

          <label className="field">
            <span>Transcription language</span>
            <select
              value={transcriptionLanguageMode}
              onChange={(event) =>
                setTranscriptionLanguageMode(
                  event.target.value as
                    | 'AUTO'
                    | 'ENGLISH'
                    | 'HINDI_HINGLISH',
                )
              }
              disabled={phase !== 'IDLE' && phase !== 'READY' && phase !== 'FAILED'}
            >
              <option value="AUTO">Auto — Hindi and English</option>
              <option value="HINDI_HINGLISH">
                Hindi / Hinglish — mixed Hindi and English
              </option>
              <option value="ENGLISH">English</option>
            </select>
            <small>
              Hindi/Hinglish keeps Hindi in Devanagari and English in Latin text.
            </small>
          </label>

          <label className={`drop-zone ${file ? 'has-file' : ''}`}>
            <input
              type="file"
              accept="audio/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.webm"
              onChange={(event) => setFile(event.target.files?.[0])}
              disabled={phase !== 'IDLE' && phase !== 'READY' && phase !== 'FAILED'}
              required
            />
            <span className="drop-icon" aria-hidden="true">↥</span>
            {file ? (
              <>
                <strong>{file.name}</strong>
                <small>{formatBytes(file.size)} · {file.type || 'audio file'}</small>
              </>
            ) : (
              <>
                <strong>Choose an audio file</strong>
                <small>WAV, MP3, M4A, AAC, FLAC, OGG or WebM</small>
              </>
            )}
          </label>

          {phase === 'IDLE' ? (
            <button className="primary-button" type="submit" disabled={!file}>
              Start analysis
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={reset}>
              Start another analysis
            </button>
          )}

          {error && <p className="error-message" role="alert">{error}</p>}
        </form>

        <section className="monitor-panel" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Live pipeline</p>
              <h2>{analysis ? analysis.fileName : 'Waiting for a recording'}</h2>
            </div>
            {analysis && (
              <span className="analysis-id">
                {analysis.analysisId.slice(-8)}
              </span>
            )}
          </div>

          <div className="stage-grid">
            <StageCard
              index="01"
              label="Secure upload"
              status={uploadStatus}
              progress={uploadProgress}
              detail={
                uploadProgress > 0
                  ? `${uploadProgress}% transferred`
                  : 'Direct browser-to-storage transfer'
              }
            />
            <StageCard
              index="02"
              label="Media ingestion"
              status={analysis?.ingestStage.status ?? 'PENDING'}
              progress={analysis?.ingestStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.ingestStage.status,
                      analysis.ingestStage.attempts,
                      'Media metadata extracted',
                    )
                  : 'Awaiting upload'
              }
            />
            <StageCard
              index="03"
              label="Tier-1 scan"
              status={analysis?.scanStage.status ?? 'PENDING'}
              progress={analysis?.scanStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.scanStage.status,
                      analysis.scanStage.attempts,
                      'Logical windows and speech candidates ready',
                    )
                  : 'Awaiting ingestion'
              }
            />
            <StageCard
              index="04"
              label="Selective ASR"
              status={analysis?.transcriptionStage.status ?? 'PENDING'}
              progress={analysis?.transcriptionStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.transcriptionStage.status,
                      analysis.transcriptionStage.attempts,
                      `${analysis.transcriptionSummary?.wordCount.toLocaleString() ?? 0} words transcribed`,
                    )
                  : 'Awaiting speech regions'
              }
            />
            <StageCard
              index="05"
              label="Speaker diarization"
              status={analysis?.diarizationStage.status ?? 'PENDING'}
              progress={analysis?.diarizationStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.diarizationStage.status,
                      analysis.diarizationStage.attempts,
                      `${analysis.diarizationSummary?.speakerCount ?? 0} local speakers · ${analysis.diarizationSummary?.turnCount ?? 0} turns`,
                    )
                  : 'Awaiting transcript'
              }
            />
            <StageCard
              index="06"
              label="Conversation builder"
              status={analysis?.conversationStage.status ?? 'PENDING'}
              progress={analysis?.conversationStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.conversationStage.status,
                      analysis.conversationStage.attempts,
                      `${analysis.conversationSummary?.sessionCount ?? 0} conversation sessions`,
                    )
                  : 'Awaiting speaker turns'
              }
            />
            <StageCard
              index="07"
              label="Safety context"
              status={analysis?.contextStage.status ?? 'PENDING'}
              progress={analysis?.contextStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.contextStage.status,
                      analysis.contextStage.attempts,
                      `${analysis.contextSummary?.safetySignalCount ?? 0} candidate signals`,
                    )
                  : 'Awaiting conversations'
              }
            />
            <StageCard
              index="08"
              label="Acoustic events"
              status={analysis?.acousticStage.status ?? 'PENDING'}
              progress={analysis?.acousticStage.progress ?? 0}
              detail={
                analysis
                  ? stageDetail(
                      analysis.acousticStage.status,
                      analysis.acousticStage.attempts,
                      `${analysis.acousticSummary?.eventCount ?? 0} candidate sounds`,
                    )
                  : 'Awaiting retained audio'
              }
            />
            <StageCard
              index="09"
              label="Risk aggregation"
              status={analysis?.riskStage?.status ?? 'PENDING'}
              progress={analysis?.riskStage?.progress ?? 0}
              detail={
                analysis?.riskStage
                  ? stageDetail(
                      analysis.riskStage.status,
                      analysis.riskStage.attempts,
                      `${analysis.riskSummary?.incidentCount ?? 0} review incidents`,
                    )
                  : 'Awaiting safety evidence'
              }
            />
          </div>

          <div className="activity-feed">
            <div className="activity-title">
              <h3>Activity</h3>
              <span>{activity.length} events</span>
            </div>
            {activity.length === 0 ? (
              <p className="empty-copy">Pipeline events will appear here.</p>
            ) : (
              <ol>
                {activity.map((item) => (
                  <li key={item.id}>
                    <time>{item.time}</time>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </section>

      {analysis?.mediaMetadata && (
        <section className="results-section audio-player-section" id="audio-player">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Source review</p>
              <h2>Listen to the original recording</h2>
            </div>
            <span className="model-label">
              {formatDuration(analysis.mediaMetadata.durationMs)}
            </span>
          </div>
          {!playbackUrl && !playbackError ? (
            <p className="empty-copy">Preparing secure audio playback…</p>
          ) : playbackUrl ? (
            <AudioPlayer
              key={analysis.analysisId}
              audioRef={audioRef}
              durationMs={analysis.mediaMetadata.durationMs}
              fileName={analysis.fileName}
              url={playbackUrl}
            />
          ) : (
            <p className="error-message" role="alert">
              {playbackError ?? 'The original recording is not available.'}
            </p>
          )}
          {playbackError && playbackUrl && (
            <p className="audio-error" role="alert">
              {playbackError}
            </p>
          )}
        </section>
      )}

      {analysis?.mediaMetadata && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Media profile</p>
              <h2>What arrived</h2>
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="Duration"
              value={formatDuration(analysis.mediaMetadata.durationMs)}
            />
            <Metric
              label="Format"
              value={analysis.mediaMetadata.formatName.split(',')[0]}
            />
            <Metric
              label="Codec"
              value={analysis.mediaMetadata.audioStreams[0]?.codecName ?? '—'}
            />
            <Metric
              label="Sample rate"
              value={
                analysis.mediaMetadata.audioStreams[0]?.sampleRate
                  ? `${analysis.mediaMetadata.audioStreams[0].sampleRate?.toLocaleString()} Hz`
                  : '—'
              }
            />
          </div>
        </section>
      )}

      {analysis?.scanSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Tier-1 result</p>
              <h2>Speech and signal overview</h2>
            </div>
            <div className="result-actions">
              <span className="model-label">
                {analysis.scanSummary.pipelineVersion}
              </span>
              <button
                className="refresh-results"
                type="button"
                onClick={() => void refreshCompletedAnalysis()}
                disabled={segmentsLoading}
              >
                {segmentsLoading ? 'Refreshing…' : 'Refresh results'}
              </button>
              {analysis.transcriptionStage.status === 'COMPLETED' &&
                (analysis.acousticStage.status === 'PENDING' ||
                  analysis.acousticStage.status === 'COMPLETED' ||
                  analysis.acousticStage.status === 'FAILED') && (
                  <button
                    className="refresh-results"
                    type="button"
                    onClick={() =>
                      void beginAcousticDetection(
                        analysis.acousticStage.status === 'COMPLETED',
                      )
                    }
                  >
                    {analysis.acousticStage.status === 'COMPLETED'
                      ? 'Reanalyse sounds'
                      : 'Detect safety sounds'}
                  </button>
                )}
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="Speech ratio"
              value={`${Math.round(analysis.scanSummary.speechRatio * 100)}%`}
            />
            <Metric
              label="Speech intervals"
              value={analysis.scanSummary.speechIntervalCount.toLocaleString()}
            />
            <Metric
              label="Scan windows"
              value={analysis.scanSummary.windowCount.toLocaleString()}
            />
            <Metric
              label="Processing time"
              value={`${analysis.scanSummary.processingSeconds.toFixed(2)}s`}
            />
            <Metric
              label="ASR-ready regions"
              value={analysis.scanSummary.processingRegionCount.toLocaleString()}
            />
            <Metric
              label="Audio retained"
              value={formatDuration(analysis.scanSummary.retainedDurationMs)}
            />
            <Metric
              label="Silence skipped"
              value={formatDuration(
                analysis.scanSummary.removedSilenceDurationMs,
              )}
            />
            <Metric
              label="Retained ratio"
              value={`${Math.round(analysis.scanSummary.retainedRatio * 100)}%`}
            />
          </div>

          <div className="decibel-overview">
            <div className="activity-title">
              <div>
                <h3>Full recording loudness</h3>
                <p>
                  An eagle-eye view of sound intensity from beginning to end.
                </p>
              </div>
              <span>{scanWindows.length.toLocaleString()} scan windows</span>
            </div>
            <DecibelOverview
              durationMs={analysis.scanSummary.decodedDurationMs}
              windows={scanWindows}
            />
          </div>

          <div className="timeline">
            <div className="activity-title">
              <div>
                <h3>Logical processing regions</h3>
                <span>{segmentTotal.toLocaleString()} regions</span>
              </div>
              <button
                type="button"
                className="collapse-toggle"
                aria-expanded={regionsExpanded}
                onClick={() => setRegionsExpanded((current) => !current)}
              >
                {regionsExpanded ? 'Hide regions' : 'Show regions'}
                <span aria-hidden="true">{regionsExpanded ? '↑' : '↓'}</span>
              </button>
            </div>
            {regionsExpanded && (
              <>
                <div className="region-range">
                  {segmentTotal === 0
                    ? '0 records'
                    : `${(segmentPage - 1) * SEGMENTS_PER_PAGE + 1}–${Math.min(
                        segmentPage * SEGMENTS_PER_PAGE,
                        segmentTotal,
                      )} of ${segmentTotal.toLocaleString()}`}
                </div>
                {segments.length === 0 ? (
                  <p className="empty-copy">
                    No speech-based processing regions were created.
                  </p>
                ) : (
                  <div className="segment-list">
                    {segments.map((segment) => (
                      <SegmentRow key={segment.segmentId} segment={segment} />
                    ))}
                  </div>
                )}
                {segmentTotal > SEGMENTS_PER_PAGE && (
                  <nav
                    className="pagination"
                    aria-label="Detected segments pages"
                  >
                    <button
                      type="button"
                      onClick={() => void changeSegmentPage(segmentPage - 1)}
                      disabled={segmentPage === 1 || segmentsLoading}
                    >
                      ← Previous
                    </button>
                    <span>
                      Page <strong>{segmentPage}</strong> of {segmentPageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => void changeSegmentPage(segmentPage + 1)}
                      disabled={
                        segmentPage === segmentPageCount || segmentsLoading
                      }
                    >
                      Next →
                    </button>
                  </nav>
                )}
              </>
            )}
          </div>

          {analysis.scanSummary.speechIntervalCount > 0 && (
            <p className="baseline-note">
              {analysis.scanSummary.processingRegionCount.toLocaleString()}{' '}
              padded processing region
              {analysis.scanSummary.processingRegionCount === 1
                ? ' preserves'
                : 's preserve'}{' '}
              the original timeline and{' '}
              {analysis.scanSummary.processingRegionCount === 1 ? 'is' : 'are'}{' '}
              ready for selective transcription. The source audio remains
              unchanged.
            </p>
          )}
        </section>
      )}

      {analysis?.transcriptionSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Tier-2 result</p>
              <h2>Timestamped transcript</h2>
            </div>
            <div className="result-actions">
              <span className="model-label">
                {analysis.transcriptionSummary.completedChunkCount.toLocaleString()}
                /{analysis.transcriptionSummary.chunkCount.toLocaleString()} chunks
              </span>
              {analysis.transcriptionStage.status === 'COMPLETED' &&
                (analysis.diarizationStage.status === 'PENDING' ||
                  analysis.diarizationStage.status === 'COMPLETED' ||
                  analysis.diarizationStage.status === 'FAILED') && (
                  <button
                    className="refresh-results"
                    type="button"
                    onClick={() =>
                      void beginDiarization(
                        analysis.diarizationStage.status === 'COMPLETED',
                      )
                    }
                  >
                    {analysis.diarizationStage.status === 'COMPLETED'
                      ? 'Reanalyse speakers'
                      : 'Analyse speakers'}
                  </button>
                )}
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="ASR chunks"
              value={analysis.transcriptionSummary.chunkCount.toLocaleString()}
            />
            <Metric
              label="Completed"
              value={analysis.transcriptionSummary.completedChunkCount.toLocaleString()}
            />
            <Metric
              label="Words"
              value={analysis.transcriptionSummary.wordCount.toLocaleString()}
            />
            <Metric
              label="Audio transcribed"
              value={formatDuration(
                analysis.transcriptionSummary.transcribedDurationMs,
              )}
            />
          </div>

          <div className="transcript-list">
            <div className="activity-title">
              <div>
                <h3>Transcript chunks</h3>
                <span>{transcriptionTotal.toLocaleString()} chunks</span>
              </div>
              <button
                type="button"
                className="collapse-toggle"
                aria-expanded={transcriptExpanded}
                onClick={() =>
                  setTranscriptExpanded((current) => !current)
                }
              >
                {transcriptExpanded ? 'Hide chunks' : 'Show chunks'}
                <span aria-hidden="true">
                  {transcriptExpanded ? '↑' : '↓'}
                </span>
              </button>
            </div>
            {transcriptExpanded && (
              <>
                <div className="region-range">
                  Showing {transcriptions.length.toLocaleString()} of{' '}
                  {transcriptionTotal.toLocaleString()}
                </div>
                {transcriptions.length === 0 ? (
                  <p className="empty-copy">
                    Transcript text will appear as ASR chunks complete.
                  </p>
                ) : (
                  transcriptions.map((chunk) => (
                    <TranscriptRow
                      chunk={chunk}
                      key={chunk.chunkId}
                      onListen={playbackUrl ? playAudioAt : undefined}
                    />
                  ))
                )}
              </>
            )}
          </div>
        </section>
      )}

      {analysis?.conversationSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Tier-2 enrichment</p>
              <h2>Speaker conversations</h2>
            </div>
            <div className="result-actions">
              <span className="model-label">
                {analysis.diarizationSummary?.model ?? 'speaker model'}
              </span>
              {analysis.conversationStage.status === 'COMPLETED' &&
                (analysis.contextStage.status === 'PENDING' ||
                  analysis.contextStage.status === 'COMPLETED' ||
                  analysis.contextStage.status === 'FAILED') && (
                  <button
                    className="refresh-results"
                    type="button"
                    onClick={() =>
                      void beginContextClassification(
                        analysis.contextStage.status === 'COMPLETED',
                      )
                    }
                  >
                    {analysis.contextStage.status === 'COMPLETED'
                      ? 'Reanalyse safety'
                      : 'Run safety analysis'}
                  </button>
                )}
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="Local speakers"
              value={(analysis.diarizationSummary?.speakerCount ?? 0).toLocaleString()}
            />
            <Metric
              label="Speaker turns"
              value={(analysis.diarizationSummary?.turnCount ?? 0).toLocaleString()}
            />
            <Metric
              label="Conversations"
              value={analysis.conversationSummary.sessionCount.toLocaleString()}
            />
            <Metric
              label="Diarization time"
              value={`${(analysis.diarizationSummary?.processingSeconds ?? 0).toFixed(2)}s`}
            />
          </div>
          <div className="conversation-list">
            <div className="activity-title">
              <h3>Conversation sessions</h3>
              <span>
                Showing {conversations.length.toLocaleString()} of{' '}
                {conversationTotal.toLocaleString()}
              </span>
            </div>
            {conversations.length === 0 ? (
              <p className="empty-copy">
                No confident spoken conversation was found.
              </p>
            ) : (
              conversations.map((session) => (
                <ConversationRow
                  key={session.sessionId}
                  session={session}
                  onListen={playbackUrl ? playAudioAt : undefined}
                />
              ))
            )}
          </div>
        </section>
      )}

      {analysis?.contextSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Automated screening</p>
              <h2>Safety context candidates</h2>
            </div>
            <span className="model-label">
              {analysis.contextSummary.model}
            </span>
          </div>
          <div className="metric-grid">
            <Metric
              label="Usable sessions"
              value={`${analysis.contextSummary.usableSessionCount}/${analysis.contextSummary.sessionCount}`}
            />
            <Metric
              label="Flagged sessions"
              value={analysis.contextSummary.flaggedSessionCount.toLocaleString()}
            />
            <Metric
              label="Candidate signals"
              value={analysis.contextSummary.safetySignalCount.toLocaleString()}
            />
            <Metric
              label="High severity"
              value={analysis.contextSummary.highSeverityCount.toLocaleString()}
            />
            <Metric
              label="Profanity sessions"
              value={analysis.contextSummary.profanitySessionCount.toLocaleString()}
            />
            <Metric
              label="Curse words"
              value={(
                analysis.contextSummary.profanityOccurrenceCount ?? 0
              ).toLocaleString()}
            />
            <Metric
              label="Language notifications"
              value={(
                analysis.contextSummary.profanityNotificationCount ?? 0
              ).toLocaleString()}
            />
            <Metric
              label="Screening time"
              value={`${analysis.contextSummary.processingSeconds.toFixed(3)}s`}
            />
          </div>
          <p className="baseline-note">
            These are automated review candidates, not verified incidents.
            Child involvement remains unknown until a consented voice
            enrollment is available.
          </p>
          <div className="event-list">
            <div className="activity-title">
              <h3>Timestamped evidence</h3>
              <span>
                Showing {timelineEvents.length.toLocaleString()} of{' '}
                {timelineEventTotal.toLocaleString()}
              </span>
            </div>
            {timelineEvents.length === 0 ? (
              <p className="empty-copy">
                No high-confidence safety phrases were detected.
              </p>
            ) : (
              timelineEvents.map((event) => (
                <TimelineEventRow
                  event={event}
                  key={event.eventId}
                  onListen={playbackUrl ? playAudioAt : undefined}
                />
              ))
            )}
          </div>
          <div className="event-list">
            <div className="activity-title">
              <h3>Language exposure</h3>
              <span>
                {profanityOccurrences.length.toLocaleString()} occurrences
              </span>
            </div>
            {profanityOccurrences.length === 0 ? (
              <p className="empty-copy">
                No curse-word exposure was detected.
              </p>
            ) : (
              profanityOccurrences.map((occurrence, index) => (
                <article
                  className={`event-row severity-${occurrence.severity}`}
                  key={`${occurrence.sessionId}-${occurrence.startMs}-${index}`}
                >
                  <div className="event-time">
                    <strong>{formatTimestamp(occurrence.startMs)}</strong>
                    <span>{occurrence.speakerId}</span>
                    <ListenButton
                      startMs={occurrence.startMs}
                      onListen={playbackUrl ? playAudioAt : undefined}
                    />
                  </div>
                  <div>
                    <div className="event-meta">
                      <span>{maskSensitiveTerm(occurrence.canonicalTerm)}</span>
                      <span>{occurrence.severity}</span>
                      <span>
                        {Math.round(occurrence.confidence * 100)}% confidence
                      </span>
                    </div>
                    <details>
                      <summary>Review transcript evidence</summary>
                      <p>{occurrence.evidence}</p>
                    </details>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      )}

      {analysis?.acousticSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Non-speech screening</p>
              <h2>Acoustic event candidates</h2>
            </div>
            <div className="result-actions">
              <span className="model-label">
                {analysis.acousticSummary.model}
              </span>
              {analysis.contextStage.status === 'COMPLETED' &&
                analysis.acousticStage.status === 'COMPLETED' &&
                (analysis.riskStage.status === 'PENDING' ||
                  analysis.riskStage.status === 'COMPLETED' ||
                  analysis.riskStage.status === 'FAILED') && (
                  <button
                    className="refresh-results"
                    type="button"
                    onClick={() =>
                      void beginRiskAggregation(
                        analysis.riskStage.status === 'COMPLETED',
                      )
                    }
                  >
                    {analysis.riskStage.status === 'COMPLETED'
                      ? 'Rebuild risk timeline'
                      : 'Build risk timeline'}
                  </button>
                )}
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              label="Audio batches"
              value={analysis.acousticSummary.processedChunkCount.toLocaleString()}
            />
            <Metric
              label="Model windows"
              value={analysis.acousticSummary.windowCount.toLocaleString()}
            />
            <Metric
              label="Candidate sounds"
              value={analysis.acousticSummary.eventCount.toLocaleString()}
            />
            <Metric
              label="Health sounds"
              value={(
                analysis.acousticSummary.healthEventCount ?? 0
              ).toLocaleString()}
            />
            <Metric
              label="Cough episodes"
              value={(
                analysis.acousticSummary.coughEventCount ?? 0
              ).toLocaleString()}
            />
            <Metric
              label="High severity"
              value={analysis.acousticSummary.highSeverityCount.toLocaleString()}
            />
            <Metric
              label="Inference time"
              value={`${analysis.acousticSummary.processingSeconds.toFixed(2)}s`}
            />
          </div>
          <p className="baseline-note">
            These labels are automated review candidates from retained audio,
            not verified incidents. Times refer to the original recording.
          </p>
          <div className="event-list">
            <div className="activity-title">
              <h3>Timestamped sounds</h3>
              <span>
                Showing {acousticEvents.length.toLocaleString()} of{' '}
                {acousticEventTotal.toLocaleString()}
              </span>
            </div>
            {nonHealthAcousticEvents.length === 0 ? (
              <p className="empty-copy">
                No safety-relevant acoustic events met the confidence threshold.
              </p>
            ) : (
              nonHealthAcousticEvents.map((event) => (
                <AcousticEventRow
                  event={event}
                  key={event.eventId}
                  onListen={playbackUrl ? playAudioAt : undefined}
                />
              ))
            )}
          </div>
          <div className="event-list">
            <div className="activity-title">
              <h3>Health-related sounds</h3>
              <span>{healthEvents.length.toLocaleString()} episodes</span>
            </div>
            {healthEvents.length === 0 ? (
              <p className="empty-copy">
                No cough, wheeze, or gasp met the review threshold.
              </p>
            ) : (
              healthEvents.map((event) => (
                <AcousticEventRow
                  event={event}
                  key={event.eventId}
                  onListen={playbackUrl ? playAudioAt : undefined}
                />
              ))
            )}
          </div>
        </section>
      )}

      {analysis?.riskSummary && (
        <section className="results-section">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Evidence fusion</p>
              <h2>Unified risk timeline</h2>
            </div>
            <span className="model-label">{analysis.riskSummary.model}</span>
          </div>
          <div className="metric-grid">
            <Metric
              label="Evidence signals"
              value={analysis.riskSummary.evidenceCount.toLocaleString()}
            />
            <Metric
              label="Review incidents"
              value={analysis.riskSummary.incidentCount.toLocaleString()}
            />
            <Metric
              label="Multimodal"
              value={analysis.riskSummary.multimodalIncidentCount.toLocaleString()}
            />
            <Metric
              label="High severity"
              value={analysis.riskSummary.highSeverityCount.toLocaleString()}
            />
            <Metric
              label="Aggregation time"
              value={`${analysis.riskSummary.processingSeconds.toFixed(3)}s`}
            />
          </div>
          <p className="baseline-note">
            Incidents group candidate evidence occurring within 15 seconds.
            They require human review and do not establish that harm occurred.
          </p>
          <div className="event-list">
            <div className="activity-title">
              <h3>Review queue</h3>
              <span>
                Showing {riskIncidents.length.toLocaleString()} of{' '}
                {riskIncidentTotal.toLocaleString()}
              </span>
            </div>
            {riskIncidents.length === 0 ? (
              <p className="empty-copy">
                No transcript or acoustic evidence was available to aggregate.
              </p>
            ) : (
              riskIncidents.map((incident) => (
                <RiskIncidentRow
                  incident={incident}
                  key={incident.incidentId}
                  onListen={playbackUrl ? playAudioAt : undefined}
                />
              ))
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SegmentRow({ segment }: { segment: Segment }) {
  const score = segment.speechRatio ?? segment.confidence ?? 0;
  const isProcessingRegion = segment.segmentType === 'PROCESSING_REGION';
  return (
    <article className="segment-row">
      <div className="segment-time">
        <span>Start</span>
        <strong>{formatTimestamp(segment.startMs)}</strong>
        <span>End · {formatTimestamp(segment.endMs)}</span>
      </div>
      <div className="segment-detail">
        <div>
          <strong>
            {isProcessingRegion
              ? 'ASR-ready region'
              : segment.segmentType === 'SPEECH_INTERVAL'
                ? 'Speech candidate'
                : 'Analysis window'}
          </strong>
          <span>{segment.labels.join(' · ') || 'No labels'}</span>
        </div>
        <div
          className="signal-track"
          aria-label={
            isProcessingRegion
              ? 'Selected for processing'
              : `${Math.round(score * 100)}% speech score`
          }
        >
          <span
            style={{
              width: isProcessingRegion
                ? '100%'
                : `${Math.max(2, score * 100)}%`,
            }}
          />
        </div>
      </div>
      <strong className="segment-score">
        {isProcessingRegion
          ? `${segment.sourceIntervalCount ?? 1} source ${
              (segment.sourceIntervalCount ?? 1) === 1
                ? 'interval'
                : 'intervals'
            }`
          : `${Math.round(score * 100)}%`}
      </strong>
    </article>
  );
}

interface ListenableRowProps {
  onListen?: (startMs: number) => void;
}

function ListenButton({
  onListen,
  startMs,
}: ListenableRowProps & { startMs: number }) {
  return (
    <button
      type="button"
      className="listen-button"
      disabled={!onListen}
      aria-label={`Play audio from ${formatTimestamp(startMs)}`}
      onClick={() => onListen?.(startMs)}
    >
      ▶ Listen
    </button>
  );
}

function TranscriptRow({
  chunk,
  onListen,
}: ListenableRowProps & { chunk: TranscriptionChunk }) {
  return (
    <article className="transcript-row">
      <div className="transcript-time">
        <strong>{formatTimestamp(chunk.startMs)}</strong>
        <span>through {formatTimestamp(chunk.endMs)}</span>
        <span>{formatDuration(chunk.durationMs)} selected</span>
        <ListenButton startMs={chunk.startMs} onListen={onListen} />
      </div>
      <div>
        <div className="transcript-meta">
          <span className={`transcript-status status-${chunk.status.toLowerCase()}`}>
            {chunk.status.toLowerCase()}
          </span>
          {chunk.language && <span>{chunk.language.toUpperCase()}</span>}
          {chunk.languageMode && (
            <span>{chunk.languageMode.replaceAll('_', ' ').toLowerCase()}</span>
          )}
          {chunk.model && <span>{chunk.model}</span>}
          {chunk.extractionSeconds !== undefined && (
            <span>extract {chunk.extractionSeconds.toFixed(2)}s</span>
          )}
          {chunk.inferenceSeconds !== undefined && (
            <span>infer {chunk.inferenceSeconds.toFixed(2)}s</span>
          )}
          {chunk.vadFallbackUsed && <span>VAD fallback</span>}
          {chunk.qualityRetryUsed && <span>language retry</span>}
        </div>
        <p>
          {chunk.text?.trim() ||
            (chunk.status === 'COMPLETED'
              ? 'No confident speech detected in this batch.'
              : chunk.status === 'FAILED'
                ? chunk.failureReason ?? 'Transcription failed'
                : chunk.status === 'RUNNING'
                  ? 'Transcribing this batch…'
                  : 'Waiting for transcription…')}
        </p>
      </div>
    </article>
  );
}

function ConversationRow({
  onListen,
  session,
}: ListenableRowProps & { session: ConversationSession }) {
  return (
    <article className="conversation-row">
      <div className="conversation-header">
        <div>
          <strong>
            {formatTimestamp(session.startMs)}–{formatTimestamp(session.endMs)}
          </strong>
          <span>{formatDuration(session.endMs - session.startMs)}</span>
        </div>
        <div className="conversation-labels">
          {session.conversationType && (
            <span>{session.conversationType.label.replaceAll('_', ' ')}</span>
          )}
          {session.quality && (
            <span>
              quality {Math.round(session.quality.score * 100)}%
            </span>
          )}
          <span>{session.speakers.join(' · ')}</span>
        </div>
      </div>
      <div className="utterance-list">
        {session.utterances.map((utterance, index) => (
          <div
            className="utterance"
            key={`${session.sessionId}-${utterance.startMs}-${index}`}
          >
            <span>{utterance.speakerId}</span>
            <time>{formatTimestamp(utterance.startMs)}</time>
            <p>{utterance.text}</p>
            <ListenButton startMs={utterance.startMs} onListen={onListen} />
          </div>
        ))}
      </div>
    </article>
  );
}

function TimelineEventRow({
  event,
  onListen,
}: ListenableRowProps & { event: TimelineEvent }) {
  return (
    <article className={`event-row severity-${event.severity}`}>
      <div className="event-time">
        <strong>{formatTimestamp(event.startMs)}</strong>
        <span>{event.speakerId}</span>
        <ListenButton startMs={event.startMs} onListen={onListen} />
      </div>
      <div>
        <div className="event-meta">
          <span>{event.eventType.replaceAll('_', ' ')}</span>
          <span>{event.severity}</span>
          <span>{Math.round(event.confidence * 100)}% confidence</span>
          <span>child involvement: unknown</span>
        </div>
        <p>{event.evidence}</p>
      </div>
    </article>
  );
}

function AcousticEventRow({
  event,
  onListen,
}: ListenableRowProps & { event: AcousticEvent }) {
  return (
    <article className={`event-row severity-${event.severity}`}>
      <div className="event-time">
        <strong>{formatTimestamp(event.startMs)}</strong>
        <span>to {formatTimestamp(event.endMs)}</span>
        <ListenButton startMs={event.startMs} onListen={onListen} />
      </div>
      <div>
        <div className="event-meta">
          <span>{event.label}</span>
          <span>{event.category.replaceAll('_', ' ')}</span>
          <span>{event.severity}</span>
          <span>{Math.round(event.confidence * 100)}% confidence</span>
        </div>
        <p>
          Review this section of the original recording for a possible{' '}
          {event.label.toLowerCase()} sound.
        </p>
      </div>
    </article>
  );
}

function RiskIncidentRow({
  incident,
  onListen,
}: ListenableRowProps & { incident: RiskIncident }) {
  return (
    <article className={`event-row severity-${incident.severity}`}>
      <div className="event-time">
        <strong>{formatTimestamp(incident.startMs)}</strong>
        <span>to {formatTimestamp(incident.endMs)}</span>
        <span>{incident.reviewStatus}</span>
        <ListenButton startMs={incident.startMs} onListen={onListen} />
      </div>
      <div>
        <div className="event-meta">
          <span>{incident.incidentType.replaceAll('_', ' ')}</span>
          <span>{incident.severity}</span>
          <span>{Math.round(incident.confidence * 100)}% confidence</span>
          <span>{incident.modalities.join(' + ')}</span>
          <span>{incident.evidence.length} signals</span>
        </div>
        <p>{incident.rationale}</p>
        {incident.evidence.some((item) => item.evidenceText) && (
          <div className="risk-evidence">
            {incident.evidence
              .filter((item) => item.evidenceText)
              .map((item, index) => (
                <span key={`${item.source}-${item.startMs}-${index}`}>
                  {formatTimestamp(item.startMs)} · {item.evidenceText}
                </span>
              ))}
          </div>
        )}
      </div>
    </article>
  );
}
