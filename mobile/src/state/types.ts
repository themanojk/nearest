import { Severity } from '../theme/theme';

export type EventSeverity = Severity; // 'high' | 'review' | 'info'

export type SafetyEvent = {
  id: string;
  title: string;
  severity: EventSeverity;
  time: string; // "11:02 AM"
  confidence: string; // "high confidence"
  category: string; // "Health · Repeated cough"
  evidence: string;
  context: string;
  limitations: string;
};

export type Report = {
  id: string;
  dateLabel: string; // "Tue, 23 Jul"
  durationMeta: string; // "7h 55m recorded · 7h 30m processed"
  quality: string; // "good quality"
  reviewCount: number; // events needing review
  environment: string;
  conversation: string;
  healthNote: string;
  profanityLine: string;
  events: SafetyEvent[];
  isToday?: boolean;
};

export type NotifSeverity = 'warn' | 'review' | 'info';

export type AppNotification = {
  id: string;
  severity: NotifSeverity;
  title: string;
  body: string;
  time: string;
};

export type Tab = 'today' | 'history' | 'device' | 'profile';
export type ProfileView = 'main' | 'subscription' | 'privacy';
export type HistoryView = 'list' | 'detail';

export type SyncStage =
  | null
  | 'preflight'
  | 'transferring'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'failed';

export type Verdict = 'useful' | 'incorrect' | 'notsure';

export type ProcessingStep = { label: string; done: boolean };
