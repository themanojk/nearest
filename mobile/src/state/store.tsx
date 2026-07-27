import React, {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useCallback,
} from 'react';
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
  makeTodayReport,
  PROCESSING_STEPS,
  SEED_NOTIFICATIONS,
  SEED_REPORTS,
} from './seed';

export type State = {
  phase: 'onboarding' | 'app';
  onboardStep: number; // 0..6
  consentChecked: boolean;
  pairingSearching: boolean;

  deviceNameInput: string;
  childNicknameInput: string;

  activeTab: Tab;
  historyView: 'list' | 'detail';
  selectedReportId: string | null;
  selectedEventId: string | null;
  profileView: ProfileView;

  syncStage: SyncStage;
  transferProgress: number;
  uploadProgress: number;
  processingSteps: ProcessingStep[];

  syncsUsed: number;
  lastSyncLabel: string;
  deviceBattery: number;
  deviceStorage: number;

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
  phase: 'onboarding',
  onboardStep: 0,
  consentChecked: false,
  pairingSearching: false,

  deviceNameInput: DEVICE_DEFAULTS.name,
  childNicknameInput: DEVICE_DEFAULTS.nickname,

  activeTab: 'today',
  historyView: 'list',
  selectedReportId: null,
  selectedEventId: null,
  profileView: 'main',

  syncStage: null,
  transferProgress: 0,
  uploadProgress: 0,
  processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),

  syncsUsed: ALLOWANCE.used,
  lastSyncLabel: 'Yesterday, 8:42 PM',
  deviceBattery: 62,
  deviceStorage: 71,

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
      // A sync credit is only consumed on completion (§18).
      return {
        ...state,
        syncStage: 'complete',
        syncsUsed: state.syncsUsed + 1,
        lastSyncLabel: 'Just now',
        reportsExtra: [makeTodayReport(), ...state.reportsExtra],
        historyCleared: false,
      };

    case 'resetSync':
      return {
        ...state,
        syncStage: null,
        transferProgress: 0,
        uploadProgress: 0,
        processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),
      };

    case 'logout':
      // Returns to onboarding step 0 and resets consent (§19). Reports stay.
      return {
        ...state,
        phase: 'onboarding',
        onboardStep: 0,
        consentChecked: false,
        activeTab: 'today',
        historyView: 'list',
        selectedReportId: null,
        selectedEventId: null,
        profileView: 'main',
        notifPanelOpen: false,
        showLogoutConfirm: false,
        syncStage: null,
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

  const patch = useCallback((p: Partial<State>) => dispatch({ type: 'patch', patch: p }), []);
  const setTab = useCallback((tab: Tab) => dispatch({ type: 'setTab', tab }), []);
  const completeSync = useCallback(() => dispatch({ type: 'completeSync' }), []);
  const resetSync = useCallback(() => dispatch({ type: 'resetSync' }), []);
  const logout = useCallback(() => dispatch({ type: 'logout' }), []);
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
  return { used, total, remaining: total - used, resets: ALLOWANCE.resets };
}
