import TransferLogs from '../components/TransferLogs';
import { transferLog } from '../services/transferLog';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
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
import {
  getCompletedRecordingIds,
} from '../services/audioTransfer';
import type { DeviceRecordingManifest } from '../services/transport';

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

function formatTransferRate(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) return null;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number | null) {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60
    ? `${minutes}m left`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
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
  const { state, patch, completeSync, resetSync } = useStore();
  const { remaining } = useAllowance();
  const handleRef = useRef<SyncHandle | null>(null);
  const [catalog, setCatalog] = useState<DeviceRecordingManifest[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionTouched, setSelectionTouched] = useState(false);

  useEffect(() => {
    if (state.syncStage !== 'preflight') return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError(null);
    setSelectionTouched(false);
    transferLog('CATALOG reading recordings from wearable');
    void Promise.all([
      transport.listRecordingManifests(),
      getCompletedRecordingIds(),
    ])
      .then(([recordings, completed]) => {
        if (!active) return;
        const pending = recordings.filter((recording) => !completed.has(recording.recordingId));
        for (const recording of recordings) {
          transferLog(
            `CATALOG ${recording.fileName} bytes=${recording.sizeBytes} ${completed.has(recording.recordingId) ? 'hidden: already uploaded' : 'shown: pending upload'}`,
          );
        }
        transferLog(`CATALOG received=${recordings.length} shown=${pending.length} hidden=${recordings.length - pending.length}`);
        setCatalog(pending);
        setSelectedIds([]);
      })
      .catch((error: unknown) => {
        if (!active) return;
        transferLog(`CATALOG failed: ${error instanceof Error ? error.message : 'Could not read recordings'}`);
        setCatalogError(
          error instanceof Error ? error.message : 'Could not read recordings',
        );
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state.syncStage]);

  const stopTimers = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
  }, []);

  useEffect(() => () => stopTimers(), [stopTimers]);

  const beginSync = useCallback(
    () => {
      patch({
        syncStage: 'transferring',
        syncError: null,
        transferProgress: 0,
        transferBytesPerSecond: 0,
        transferEtaSeconds: null,
        transferBytes: 0,
        transferTotalBytes: 0,
        networkBenchmarkBytesPerSecond: 0,
        networkBenchmarkPacketLossPercent: null,
        networkBenchmarkRunning: false,
        uploadProgress: 0,
        uploadedFileCount: 0,
        totalFileCount: 0,
        processingSteps: PROCESSING_STEPS.map((s) => ({ ...s })),
      });
      handleRef.current = transport.startSync({
        onFileProgress: (completedFiles, totalFiles) =>
          patch({ uploadedFileCount: completedFiles, totalFileCount: totalFiles }),
        onNetworkBenchmark: (bytesPerSecond, packetLossPercent) =>
          patch({
            networkBenchmarkBytesPerSecond: bytesPerSecond,
            networkBenchmarkPacketLossPercent:
              packetLossPercent ?? null,
          }),
        onNetworkBenchmarkState: (running) =>
          patch({ networkBenchmarkRunning: running }),
        onTransfer: (p) =>
          patch({
            syncStage: 'transferring',
            transferProgress: p,
            recordingState: 'idle',
          }),
        onTransferTelemetry: ({
          bytesPerSecond,
          etaSeconds,
          totalBytes,
          transferredBytes,
        }) =>
          patch({
            transferBytesPerSecond: bytesPerSecond,
            transferEtaSeconds: etaSeconds,
            transferBytes: transferredBytes,
            transferTotalBytes: totalBytes,
          }),
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
        onFailed: (reason) =>
          patch({ syncError: reason, syncStage: 'failed' }),
      }, selectionTouched ? { recordingIds: selectedIds } : undefined);
    },
    [patch, completeSync, selectedIds, selectionTouched],
  );

  const cancel = useCallback(() => {
    stopTimers();
    resetSync();
  }, [stopTimers, resetSync]);

  const startNextRecording = useCallback(async () => {
    patch({ recordingState: 'starting', recordingError: null });
    try {
      await transport.startRecording();
      patch({ recordingState: 'recording', recordingError: null });
    } catch (error) {
      patch({
        recordingState: 'error',
        recordingError:
          error instanceof Error
            ? error.message
            : 'Could not start recording',
      });
    }
  }, [patch]);

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
                Estimated audio:{' '}
                <Txt weight="bold" size={13} color={colors.ink}>
                  7h 40m
                </Txt>
              </Txt>
              <Txt size={13} color={colors.body} lh={19}>
                Device battery:{' '}
                {state.deviceBattery === null
                  ? 'unavailable'
                  : `${state.deviceBattery}%`}{' '}
                · Phone storage: sufficient
              </Txt>
            </Glass>
            <Txt size={12} color={colors.muted} lh={17}>
              This will use 1 sync once the transfer is confirmed. {Math.max(0, remaining - 1)}{' '}
              remain after.
            </Txt>
            <Txt weight="semibold" size={13} color={colors.ink}>
              Recordings to sync
            </Txt>
            {catalogLoading && (
              <Txt size={12} color={colors.muted}>Reading pending recordings…</Txt>
            )}
            {!catalogLoading && catalog.length === 0 && !catalogError && (
              <Txt size={12} color={colors.muted} lh={17}>
                No pending recordings. Completed files are hidden automatically.
              </Txt>
            )}
            {catalogError && (
              <Txt size={12} color={colors.destructive} lh={17}>
                {catalogError}
              </Txt>
            )}
            {catalog.length > 0 && (
              <ScrollView style={{ maxHeight: 150 }} contentContainerStyle={{ gap: 6 }}>
                {catalog.map((recording) => {
                  const checked = selectionTouched
                    ? selectedIds.includes(recording.recordingId)
                    : true;
                  return (
                    <Pressable
                      key={recording.recordingId}
                      onPress={() => {
                        setSelectionTouched(true);
                        setSelectedIds((current) =>
                          current.includes(recording.recordingId)
                            ? current.filter((id) => id !== recording.recordingId)
                            : [...current, recording.recordingId],
                        );
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 9,
                        padding: 9,
                        borderRadius: 10,
                        backgroundColor: 'rgba(61,122,84,0.08)',
                      }}>
                      <View
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 5,
                          borderWidth: 1,
                          borderColor: checked ? colors.primaryGreenDark : colors.muted,
                          backgroundColor: checked ? colors.primaryGreenDark : 'transparent',
                        }}
                      />
                      <Txt size={12} color={colors.ink} numberOfLines={1} style={{ flex: 1 }}>
                        {recording.fileName}
                      </Txt>
                      <Txt size={11} color={colors.muted}>
                        {Math.ceil(recording.sizeBytes / (1024 * 1024))} MB
                      </Txt>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            <PrimaryButton label="Start sync" onPress={beginSync} />
          </>
        )}

        {stage === 'transferring' && (
          <>
            <Txt weight="serif" size={19} color={colors.ink}>
              Transferring from device…
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              The phone is copying recordings over the wearable&apos;s private
              Wi-Fi hotspot. The wearable has no internet access.
            </Txt>
            <ProgressBar value={state.transferProgress} />
            {state.networkBenchmarkRunning && (
              <Txt size={12} color={colors.muted}>
                Measuring TCP and UDP network speed…
              </Txt>
            )}
            {state.networkBenchmarkBytesPerSecond > 0 && (
              <Txt size={12} color={colors.muted}>
                Network-only result:{' '}
                {formatTransferRate(state.networkBenchmarkBytesPerSecond)}
                {state.networkBenchmarkPacketLossPercent !== null
                  ? ` · UDP loss ${state.networkBenchmarkPacketLossPercent.toFixed(3)}%`
                  : ''}
              </Txt>
            )}
            <StageChip
              label={[
                `${Math.round(state.transferProgress * 100)}%`,
                state.transferTotalBytes > 0
                  ? `${Math.floor(state.transferBytes / (1024 * 1024))}/${Math.ceil(
                      state.transferTotalBytes / (1024 * 1024),
                    )} MB`
                  : null,
                formatTransferRate(state.transferBytesPerSecond),
                formatEta(state.transferEtaSeconds),
                'keep the app open',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          </>
        )}

        {stage === 'uploading' && (
          <>
            <Txt weight="serif" size={19} color={colors.ink}>
              Uploading to NearNest…
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              The phone has left the wearable hotspot and is uploading the
              cached 10 MB chunks through its normal internet connection.
            </Txt>
            <ProgressBar value={state.uploadProgress} />
            <StageChip
              label={
                state.totalFileCount > 0
                  ? `${state.uploadedFileCount}/${state.totalFileCount} files · ${Math.round(
                      state.uploadProgress * 100,
                    )}%`
                  : `${Math.round(state.uploadProgress * 100)}%`
              }
            />
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
            <PrimaryButton
              label={
                state.recordingState === 'recording'
                  ? 'Recording started'
                  : state.recordingState === 'starting'
                    ? 'Starting recording…'
                    : 'Start next recording'
              }
              disabled={
                state.recordingState === 'recording' ||
                state.recordingState === 'starting'
              }
              onPress={startNextRecording}
            />
            {state.recordingError && (
              <Txt size={12} color={colors.destructive} lh={17}>
                {state.recordingError}
              </Txt>
            )}
          </>
        )}

        {stage === 'complete' && (
          <>
            <ResultTile kind="ok" />
            <Txt weight="serif" size={19} color={colors.ink}>
              Recordings uploaded
            </Txt>
            <Txt size={13} color={colors.body} lh={19}>
              {state.totalFileCount > 0
                ? `${state.uploadedFileCount}/${state.totalFileCount} recordings are safely stored. `
                : 'Your recordings are safely stored. '}
              Server analysis runs separately and does not block synchronization.
            </Txt>
            {state.recordingState !== 'recording' && (
              <PrimaryButton
                label={
                  state.recordingState === 'starting'
                    ? 'Starting recording…'
                    : 'Start next recording'
                }
                disabled={state.recordingState === 'starting'}
                onPress={startNextRecording}
              />
            )}
            <PrimaryButton
              label="Done"
              onPress={() => {
                stopTimers();
                patch({
                  syncStage: null,
                  transferProgress: 0,
                  transferBytesPerSecond: 0,
                  transferEtaSeconds: null,
                  transferBytes: 0,
                  transferTotalBytes: 0,
                  networkBenchmarkBytesPerSecond: 0,
                  networkBenchmarkPacketLossPercent: null,
                  networkBenchmarkRunning: false,
                  uploadProgress: 0,
                  uploadedFileCount: 0,
                  totalFileCount: 0,
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
              {state.syncError ??
                'Connection to the device was lost. Your recordings remain safe on the device.'}
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
        <TransferLogs />
      </Card>
    </Overlay>
  );
}
