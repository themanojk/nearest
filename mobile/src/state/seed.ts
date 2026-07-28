import { AppNotification, ProcessingStep, Report, SafetyEvent } from './types';

/** The two documented sample events (handoff §12). */
export const SAMPLE_EVENTS: SafetyEvent[] = [
  {
    id: 'evt-cough',
    title: 'Repeated coughing observed',
    severity: 'info',
    time: '11:02 AM',
    confidence: 'high confidence',
    category: 'Health · Repeated cough',
    evidence: '6 distinct coughing events within 22 minutes',
    context: 'Occurred during a quiet classroom period',
    limitations: 'Presented as an observation only, not a diagnosis.',
  },
  {
    id: 'evt-argument',
    title: 'Possible argument needs review',
    severity: 'review',
    time: '3:14 PM',
    confidence: 'medium confidence',
    category: 'Conversation · Argument or conflict',
    evidence: 'Raised voices detected; repeated disagreement in transcript excerpt',
    context:
      'Preceded by normal classroom activity; followed by a return to casual tone',
    limitations: 'Tone-based classifier — sarcasm or play can resemble conflict.',
  },
];

/** Seed report history (handoff §10 seed data). */
export const SEED_REPORTS: Report[] = [
  {
    id: 'rep-23jul',
    dateLabel: 'Tue, 23 Jul',
    durationMeta: '7h 55m recorded · 7h 30m processed',
    quality: 'good quality',
    reviewCount: 1,
    environment: 'Home (5h 40m), School (2h 15m)',
    conversation: 'Mostly casual conversation; one instructive session detected.',
    healthNote: 'Repeated coughing noted around midday.',
    profanityLine: 'Profanity detected nearby 2 times, not directed at child.',
    events: SAMPLE_EVENTS,
  },
  {
    id: 'rep-22jul',
    dateLabel: 'Mon, 22 Jul',
    durationMeta: '8h 05m recorded · 7h 50m processed',
    quality: 'good quality',
    reviewCount: 0,
    environment: 'Home (6h 10m), Park (1h 40m)',
    conversation: 'Mostly casual conversation.',
    healthNote: 'No notable health signals.',
    profanityLine: 'No profanity detected.',
    events: [],
  },
];

/** The report inserted at the top of history when a sync completes (§18.5). */
export function makeTodayReport(): Report {
  return {
    id: `rep-today-${Date.now()}`,
    dateLabel: 'Today',
    durationMeta: '7h 40m recorded · 7h 20m processed',
    quality: 'good quality',
    reviewCount: 2,
    environment: 'Home (5h 05m), School (2h 15m)',
    conversation: 'Mostly casual conversation; one instructive session detected.',
    healthNote: 'Repeated coughing noted around midday.',
    profanityLine: 'Profanity detected nearby 1 time, not directed at child.',
    events: SAMPLE_EVENTS.map((e) => ({ ...e, id: `${e.id}-today` })),
    isToday: true,
  };
}

export const SEED_NOTIFICATIONS: AppNotification[] = [
  {
    id: 'notif-allowance',
    severity: 'warn',
    title: 'Allowance running low',
    body: '18 syncs remaining this cycle.',
    time: 'Today 9:00 AM',
  },
  {
    id: 'notif-review',
    severity: 'review',
    title: 'Event needs review',
    body: "1 event needs your review in Tuesday's report.",
    time: 'Yesterday 8:52 PM',
  },
  {
    id: 'notif-ready',
    severity: 'info',
    title: 'Report ready',
    body: "Tuesday's report finished processing.",
    time: 'Yesterday 8:48 PM',
  },
];

export const PROCESSING_STEPS: ProcessingStep[] = [
  { label: 'Checking audio quality', done: false },
  { label: 'Detecting speech & sounds', done: false },
  { label: 'Transcribing conversations', done: false },
  { label: 'Running safety & risk analysis', done: false },
];

export const PLAN = {
  name: 'NearNest Plus',
  price: '$9.99',
  cadence: ' / month',
  trial: '7-DAY TRIAL',
  features:
    '40 syncs per month · unlimited report history · priority processing',
  trialFootnote:
    "You won't be charged until your trial ends. Cancel anytime from Settings.",
};

export const DEVICE_DEFAULTS = {
  name: "Aarav's Device",
  nickname: 'Aarav',
  timeZone: 'GMT+5:30 · Kolkata',
  firmware: '2.3.1',
  schedule: 'Weekdays, 8:00 AM – 4:00 PM',
};

export const ALLOWANCE = {
  used: 22,
  total: 40,
  resets: '12 Aug',
};
