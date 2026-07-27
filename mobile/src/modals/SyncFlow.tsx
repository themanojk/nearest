import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import { colors, radii, shadows } from '../theme/theme';
import { useAllowance, useStore } from '../state/store';
import { transport, SyncHandle } from '../services/transport';
import { PROCESSING_STEPS } from '../state/seed';
import Overlay from '../components/Overlay';
import Glass from '../components/Glass';
import Txt from '../components/Txt';
import Icon from '../components/Icon';
import ProgressBar from '../components/ProgressBar';
import { PrimaryButton, GhostButton } from '../components/Buttons';

function Card({ children }: { children: React.ReactNode }) {
  return (
    <Glass
      variant="modal"
      radius={radii.shell}
      style={{ width: 330, maxWidth: '90%', padding: 24, gap: 14, ...shadows.dialog }}>
      {children}
    </Glass>
  );
}

function StageChip({ label }: { label: string }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: colors.tintChip,
        borderRadius: radii.chip,
        paddingHorizontal: 10,
        paddingVertical: 5,
      }}>
      <Txt weight="semibold" size={12} color={colors.statusGreen}>
        {label}
      </Txt>
    </View>
  );
}

function ResultTile({ kind }: { kind: 'ok' | 'warn' }) {
  return (
    <View
      style={{
        width: 56,
        height: 56,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: kind === 'ok' ? colors.glassStrong : 'rgba(255,251,235,0.9)',
        borderWidth: 1,
        borderColor: kind === 'ok' ? colors.glassBorderStrong : colors.warnSurfaceBorder,
      }}>
      {kind === 'ok' ? (
        <Icon name="check" size={26} strokeWidth={2.4} />
      ) : (
        <Txt weight="bold" size={26} color={colors.warnDeep}>
          !
        </Txt>
      )}
    </View>
  );
}

export default function SyncFlow() {
  const { state, patch, completeSync, resetSync, setTab } = useStore();
  const { remaining } = useAllowance();
  const handleRef = useRef<SyncHandle | null>(null);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimers = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    if (failTimer.current) {
      clearTimeout(failTimer.current);
      failTimer.current = null;
    }
  }, []);

  useEffect(() => () => stopTimers(), [stopTimers]);

  const beginSync = useCallback(
    (simulateFailure = false) => {
      patch({
        syncStage: 'transferring',
        transferProgress: 0,
        uploadProgress: 0,
        processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),
      });
      handleRef.current = transport.startSync({
        onTransfer: (p) => patch({ syncStage: 'transferring', transferProgress: p }),
        onUpload: (p) => patch({ syncStage: 'uploading', uploadProgress: p }),
        onProcessingStep: (i) =>
          patch({
            syncStage: 'processing',
            processingSteps: PROCESSING_STEPS.map((s, idx) => ({
              ...s,
              done: idx <= i,
            })),
          }),
        onComplete: () => completeSync(),
        onFailed: () => patch({ syncStage: 'failed' }),
      });
      if (simulateFailure) {
        // Drop the connection partway through the transfer.
        failTimer.current = setTimeout(() => {
          stopTimers();
          patch({ syncStage: 'failed' });
        }, 900);
      }
    },
    [patch, completeSync, stopTimers],
  );

  const cancel = useCallback(() => {
    stopTimers();
    resetSync();
  }, [stopTimers, resetSync]);

  const stage = state.syncStage;

  return (
    <Overlay
      visible={stage !== null}
      dismissOnBackdrop={false}
      scrim={colors.scrimDialog}
      align="center">
      <Card>
        {stage === 'preflight' && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Txt weight="serif" size={19} color={colors.ink}>
                Sync now
              </Txt>
              <Pressable onPress={cancel} hitSlop={8}>
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            <Glass variant="soft" radius={radii.cardSm} style={{ padding: 14, gap: 6 }}>
              <Txt size={13} color={colors.body} lh={19}>
                Estimated recording:{' '}
                <Txt weight="bold" size={13} color={colors.ink}>
                  7h 40m
                </Txt>
              </Txt>
              <Txt size={13} color={colors.body} lh={19}>
                Device battery: {state.deviceBattery}% · Phone storage: sufficient
              </Txt>
            </Glass>
            <Txt size={12} color={colors.muted} lh={17}>
              This will use 1 sync once the transfer is confirmed. {Math.max(0, remaining - 1)}{' '}
              remain after.
            </Txt>
            <PrimaryButton label="Start sync" onPress={() => beginSync(false)} />
            <Pressable onPress={() => beginSync(true)} style={{ alignItems: 'center', paddingTop: 2 }}>
              <Txt size={12} color={colors.faint}>
                Simulate a failed sync
              </Txt>
            </Pressable>
          </>
        )}

        {stage === 'transferring' && (
          <>
            <Txt weight="serif" size={19} color={colors.ink}>
              Transferring from device…
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              Keep the app open and the device nearby.
            </Txt>
            <ProgressBar value={state.transferProgress} />
            <StageChip label={`${Math.round(state.transferProgress * 100)}% · safe to exit`} />
          </>
        )}

        {stage === 'uploading' && (
          <>
            <Txt weight="serif" size={19} color={colors.ink}>
              Uploading to NearNest…
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              Encrypted transfer to secure cloud storage.
            </Txt>
            <ProgressBar value={state.uploadProgress} />
            <StageChip label={`${Math.round(state.uploadProgress * 100)}%`} />
          </>
        )}

        {stage === 'processing' && (
          <>
            <Txt weight="serif" size={19} color={colors.ink}>
              Analyzing today's audio
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              This runs on our servers — you can close the app.
            </Txt>
            <View style={{ gap: 12, marginTop: 4 }}>
              {state.processingSteps.map((s, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: s.done ? colors.primaryGreenDark : 'rgba(61,122,84,0.2)',
                    }}>
                    {s.done && <Icon name="check" size={13} color={colors.white} strokeWidth={3} />}
                  </View>
                  <Txt size={13} color={s.done ? colors.ink : colors.faint}>
                    {s.label}
                  </Txt>
                </View>
              ))}
            </View>
          </>
        )}

        {stage === 'complete' && (
          <>
            <ResultTile kind="ok" />
            <Txt weight="serif" size={19} color={colors.ink}>
              Report ready
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              2 events need your review. Absence of other alerts doesn't guarantee absence of risk —
              review is always worthwhile.
            </Txt>
            <PrimaryButton
              label="View today's feed"
              onPress={() => {
                stopTimers();
                setTab('today');
                patch({
                  syncStage: null,
                  transferProgress: 0,
                  uploadProgress: 0,
                });
              }}
            />
          </>
        )}

        {stage === 'failed' && (
          <>
            <ResultTile kind="warn" />
            <Txt weight="serif" size={19} color={colors.ink}>
              Sync interrupted
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              Connection to the device was lost. No sync credit was used — your recording is safe on
              the device.
            </Txt>
            <PrimaryButton
              label="Try again"
              onPress={() => {
                resetSync();
                patch({ syncStage: 'preflight' });
              }}
            />
            <GhostButton label="Cancel" onPress={cancel} />
          </>
        )}
      </Card>
    </Overlay>
  );
}
