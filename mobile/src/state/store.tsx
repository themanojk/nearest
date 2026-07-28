import React, {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useCallback,
  useEffect,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AuthSession,
  logoutSession,
  markSessionOnboarded,
  restoreAuthenticatedSession,
} from '../services/auth';
import {
  AppNotification,
  ProcessingStep,
  Report,
  SyncStage,
  Tab,
  Verdict,
  ProfileView,
} from './types';
import {
  ALLOWANCE,
  DEVICE_DEFAULTS,
  PROCESSING_STEPS,
  SEED_NOTIFICATIONS,
  SEED_REPORTS,
} from './seed';

export type State = {
  phase: 'auth' | 'onboarding' | 'app';
  authReady: boolean;
  hasOnboarded: boolean; // completed pairing + plan at least once
  authedPhone: string | null; // signed-in phone number (display-formatted)
  authedUserId: string | null;
  onboardStep: number; // 0..6
  consentChecked: boolean;
  pairingSearching: boolean;
  pairingError: string | null;
  pairingSessionId: string | null;
  pairedDeviceCode: string | null;
  onboardingChildId: string | null;
  setupSaving: boolean;

  deviceNameInput: string;
  childNicknameInput: string;
  wifiSsidInput: string;
  wifiPasswordInput: string;

  activeTab: Tab;
  historyView: 'list' | 'detail';
  selectedReportId: string | null;
  selectedEventId: string | null;
  profileView: ProfileView;

  syncStage: SyncStage;
  syncError: string | null;
  transferProgress: number;
  transferBytesPerSecond: number;
  transferEtaSeconds: number | null;
  transferBytes: number;
  transferTotalBytes: number;
  networkBenchmarkBytesPerSecond: number;
  networkBenchmarkRunning: boolean;
  uploadProgress: number;
  uploadedFileCount: number;
  totalFileCount: number;
  processingSteps: ProcessingStep[];

  syncsUsed: number;
  lastSyncLabel: string;
  deviceBattery: number | null;
  deviceStorage: number | null;
  recordingState: 'unknown' | 'checking' | 'idle' | 'starting' | 'recording' | 'error';
  recordingError: string | null;

  reportsExtra: Report[];
  historyCleared: boolean;

  feedback: Record<string, Verdict>;

  notifPanelOpen: boolean;
  notifCleared: boolean;

  showUnpairConfirm: boolean;
  showLogoutConfirm: boolean;
  firmwareState: null | 'checking' | 'uptodate';
  showFirmwareDialog: boolean;

  showPhotoBanner: boolean;
};

// DEV-ONLY: merged over the initial state to land on a specific screen for
// visual verification. Must be {} for shipping.
const DEV_OVERRIDE: Partial<State> = {};

const baseInitialState: State = {
  phase: 'onboarding', // starts on the welcome/intro; login follows "Get started"
  authReady: false,
  hasOnboarded: false,
  authedPhone: null,
  authedUserId: null,
  onboardStep: 0,
  consentChecked: false,
  pairingSearching: false,
  pairingError: null,
  pairingSessionId: null,
  pairedDeviceCode: null,
  onboardingChildId: null,
  setupSaving: false,

  deviceNameInput: DEVICE_DEFAULTS.name,
  childNicknameInput: DEVICE_DEFAULTS.nickname,
  wifiSsidInput: '',
  wifiPasswordInput: '',

  activeTab: 'today',
  historyView: 'list',
  selectedReportId: null,
  selectedEventId: null,
  profileView: 'main',

  syncStage: null,
  syncError: null,
  transferProgress: 0,
  transferBytesPerSecond: 0,
  transferEtaSeconds: null,
  transferBytes: 0,
  transferTotalBytes: 0,
  networkBenchmarkBytesPerSecond: 0,
  networkBenchmarkRunning: false,
  uploadProgress: 0,
  uploadedFileCount: 0,
  totalFileCount: 0,
  processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),

  syncsUsed: 0,
  lastSyncLabel: 'Never',
  deviceBattery: null,
  deviceStorage: null,
  recordingState: 'unknown',
  recordingError: null,

  reportsExtra: [],
  historyCleared: false,

  feedback: {},

  notifPanelOpen: false,
  notifCleared: false,

  showUnpairConfirm: false,
  showLogoutConfirm: false,
  firmwareState: null,
  showFirmwareDialog: false,

  showPhotoBanner: false,
};

const initialState: State = { ...baseInitialState, ...DEV_OVERRIDE };

type Action =
  | { type: 'patch'; patch: Partial<State> }
  | { type: 'setTab'; tab: Tab }
  | { type: 'completeSync' }
  | { type: 'resetSync' }
  | { type: 'logout' }
  | { type: 'clearHistory' }
  | { type: 'restoreSample' }
  | { type: 'setFeedback'; eventId: string; verdict: Verdict };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };

    case 'setTab':
      // Switching tabs resets sub-views (handoff §8).
      return {
        ...state,
        activeTab: action.tab,
        historyView: 'list',
        selectedReportId: null,
        profileView: 'main',
        selectedEventId: null,
        showUnpairConfirm: false,
        showLogoutConfirm: false,
        showFirmwareDialog: false,
        firmwareState: null,
      };

    case 'completeSync':
      // Upload completion is independent of the asynchronous analysis worker.
      return {
        ...state,
        syncStage: 'complete',
        syncError: null,
        syncsUsed: state.syncsUsed + 1,
        lastSyncLabel: 'Just now',
        historyCleared: false,
      };

    case 'resetSync':
      return {
        ...state,
        syncStage: null,
        syncError: null,
        transferProgress: 0,
        transferBytesPerSecond: 0,
        transferEtaSeconds: null,
        transferBytes: 0,
        transferTotalBytes: 0,
        networkBenchmarkBytesPerSecond: 0,
        networkBenchmarkRunning: false,
        uploadProgress: 0,
        uploadedFileCount: 0,
        totalFileCount: 0,
        processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),
      };

    case 'logout':
      // Returns to the sign-in screen and resets consent (§19). Reports stay,
      // and hasOnboarded is kept so signing back in skips onboarding.
      return {
        ...state,
        phase: 'auth',
        authedPhone: null,
        authedUserId: null,
        onboardStep: 0,
        consentChecked: false,
        pairingError: null,
        pairingSessionId: null,
        pairedDeviceCode: null,
        onboardingChildId: null,
        setupSaving: false,
        wifiPasswordInput: '',
        wifiSsidInput: '',
        activeTab: 'today',
        historyView: 'list',
        selectedReportId: null,
        selectedEventId: null,
        profileView: 'main',
        notifPanelOpen: false,
        showLogoutConfirm: false,
        syncStage: null,
        syncError: null,
      };

    case 'clearHistory':
      return {
        ...state,
        historyCleared: true,
        reportsExtra: [],
        historyView: 'list',
        selectedReportId: null,
      };

    case 'restoreSample':
      return { ...state, historyCleared: false, reportsExtra: [] };

    case 'setFeedback':
      return {
        ...state,
        feedback: { ...state.feedback, [action.eventId]: action.verdict },
      };

    default:
      return state;
  }
}

type Store = {
  state: State;
  patch: (p: Partial<State>) => void;
  setTab: (t: Tab) => void;
  completeSync: () => void;
  resetSync: () => void;
  logout: () => void;
  onAuthenticated: (session: AuthSession) => void;
  completeOnboarding: () => void;
  clearHistory: () => void;
  restoreSample: () => void;
  setFeedback: (eventId: string, verdict: Verdict) => void;
  // derived
  reports: Report[];
  notifications: AppNotification[];
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem('nearnest.completed-syncs.v1')
      .then((raw) => {
        if (!active || !raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const cycleStart = currentSyncCycleStart().getTime();
        const timestamps = parsed.filter(
          (value): value is number =>
            Number.isSafeInteger(value) && value >= cycleStart,
        );
        dispatch({
          type: 'patch',
          patch: {
            syncsUsed: timestamps.length,
            lastSyncLabel:
              timestamps.length > 0 ? formatLastSync(timestamps.at(-1)!) : 'Never',
          },
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void restoreAuthenticatedSession()
      .catch(() => null)
      .then((session) => {
        if (!active) return;
        const phone = session?.user.phone;
        dispatch({
          type: 'patch',
          patch: session
            ? {
                authReady: true,
                authedPhone: phone
                  ? `${phone.countryCode} ${phone.number}`
                  : null,
                authedUserId: session.user.id,
                hasOnboarded: session.hasOnboarded,
                onboardStep: session.hasOnboarded ? 0 : 1,
                phase: session.hasOnboarded ? 'app' : 'onboarding',
              }
            : { authReady: true },
        });
      });
    return () => {
      active = false;
    };
  }, []);

  const patch = useCallback((p: Partial<State>) => dispatch({ type: 'patch', patch: p }), []);
  const setTab = useCallback((tab: Tab) => dispatch({ type: 'setTab', tab }), []);
  const completeSync = useCallback(() => {
    dispatch({ type: 'completeSync' });
    const completedAt = Date.now();
    AsyncStorage.getItem('nearnest.completed-syncs.v1')
      .then((raw) => {
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        const existing = Array.isArray(parsed) ? parsed : [];
        const cycleStart = currentSyncCycleStart().getTime();
        const timestamps = existing.filter(
          (value): value is number =>
            Number.isSafeInteger(value) && value >= cycleStart,
        );
        timestamps.push(completedAt);
        return AsyncStorage.setItem(
          'nearnest.completed-syncs.v1',
          JSON.stringify(timestamps),
        );
      })
      .catch(() => undefined);
  }, []);
  const resetSync = useCallback(() => dispatch({ type: 'resetSync' }), []);
  const logout = useCallback(() => {
    dispatch({ type: 'logout' });
    void logoutSession();
  }, []);
  const onAuthenticated = useCallback((session: AuthSession) => {
    const phone = session.user.phone;
    dispatch({
      type: 'patch',
      patch: {
        authReady: true,
        authedPhone: phone ? `${phone.countryCode} ${phone.number}` : null,
        authedUserId: session.user.id,
        hasOnboarded: session.hasOnboarded,
        onboardStep: session.hasOnboarded ? 0 : 1,
        phase: session.hasOnboarded ? 'app' : 'onboarding',
      },
    });
  }, []);
  const completeOnboarding = useCallback(() => {
    void markSessionOnboarded().finally(() =>
      dispatch({
        type: 'patch',
        patch: {
          phase: 'app',
          hasOnboarded: true,
          activeTab: 'today',
        },
      }),
    );
  }, []);
  const clearHistory = useCallback(() => dispatch({ type: 'clearHistory' }), []);
  const restoreSample = useCallback(() => dispatch({ type: 'restoreSample' }), []);
  const setFeedback = useCallback(
    (eventId: string, verdict: Verdict) =>
      dispatch({ type: 'setFeedback', eventId, verdict }),
    [],
  );

  const reports = useMemo<Report[]>(
    () => (state.historyCleared ? [] : [...state.reportsExtra, ...SEED_REPORTS]),
    [state.historyCleared, state.reportsExtra],
  );

  const notifications = useMemo<AppNotification[]>(
    () => (state.notifCleared ? [] : SEED_NOTIFICATIONS),
    [state.notifCleared],
  );

  const value = useMemo<Store>(
    () => ({
      state,
      patch,
      setTab,
      completeSync,
      resetSync,
      logout,
      onAuthenticated,
      completeOnboarding,
      clearHistory,
      restoreSample,
      setFeedback,
      reports,
      notifications,
    }),
    [
      state,
      patch,
      setTab,
      completeSync,
      resetSync,
      logout,
      onAuthenticated,
      completeOnboarding,
      clearHistory,
      restoreSample,
      setFeedback,
      reports,
      notifications,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

/** Convenience selectors. */
export function useAllowance() {
  const { state } = useStore();
  const total = ALLOWANCE.total;
  const used = state.syncsUsed;
  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    resets: formatSyncReset(nextSyncReset()),
  };
}

function currentSyncCycleStart(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (start.getDate() < 12) {
    start.setMonth(start.getMonth() - 1);
  }
  start.setDate(12);
  return start;
}

function nextSyncReset(now = new Date()): Date {
  const reset = new Date(now);
  reset.setHours(0, 0, 0, 0);
  if (reset.getDate() >= 12) {
    reset.setMonth(reset.getMonth() + 1);
  }
  reset.setDate(12);
  return reset;
}

function formatSyncReset(reset: Date): string {
  return reset.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function formatLastSync(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  });
}
