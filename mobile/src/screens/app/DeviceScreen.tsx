import React, { useCallback, useEffect } from 'react';
import { ScrollView, Pressable } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useStore } from '../../state/store';
import { DEVICE_DEFAULTS } from '../../state/seed';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';
import { PrimaryButton } from '../../components/Buttons';
import { transport } from '../../services/transport';

export default function DeviceScreen() {
  const { state, patch } = useStore();
  const refreshRecordingStatus = useCallback(async () => {
    patch({ recordingState: 'checking', recordingError: null });
    try {
      const recordingState = await transport.getRecordingStatus();
      const telemetry = await transport.getDeviceTelemetry().catch(() => null);
      patch({
        recordingState,
        recordingError: null,
        ...(telemetry
          ? {
              deviceBattery: telemetry.batteryPercent,
              deviceStorage: Math.round(
                (telemetry.storageUsedBytes / telemetry.storageTotalBytes) *
                  100,
              ),
            }
          : {}),
      });
    } catch (error) {
      patch({
        recordingState: 'error',
        recordingError:
          error instanceof Error
            ? error.message
            : 'Could not read the recording status',
      });
    }
  }, [patch]);

  useEffect(() => {
    void refreshRecordingStatus();
  }, [refreshRecordingStatus]);

  const startRecording = useCallback(async () => {
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

  const recording =
    state.recordingState === 'recording' ||
    state.recordingState === 'starting';
  const statusLabel =
    state.recordingState === 'recording'
      ? 'Recording in progress'
      : state.recordingState === 'starting'
        ? 'Starting recording…'
        : state.recordingState === 'checking'
          ? 'Checking device…'
          : state.recordingState === 'error'
            ? 'Device unavailable'
            : 'Ready to record';

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 12 }}
      showsVerticalScrollIndicator={false}>
      <Glass variant="strong" radius={radii.card} shadow="card" style={{ padding: 20, gap: 8 }}>
        <Txt weight="semibold" size={15} color={colors.ink}>
          {state.deviceNameInput}
        </Txt>
        <Txt size={12.5} color={colors.body} lh={19}>
          Firmware {DEVICE_DEFAULTS.firmware} · Up to date
        </Txt>
        <Txt size={12.5} color={colors.body} lh={19}>
          Recording mode: Manual start
        </Txt>
        <Txt size={12.5} color={colors.body} lh={19}>
          {state.deviceBattery === null ? 'Battery unavailable' : `${state.deviceBattery}% battery`}
          {' · '}
          {state.deviceStorage === null
            ? 'Storage unavailable'
            : `${state.deviceStorage}% storage used`}
        </Txt>
      </Glass>

      <Glass
        variant="strong"
        radius={radii.card}
        shadow="card"
        style={{ padding: 20, gap: 12 }}>
        <Txt weight="semibold" size={15} color={colors.ink}>
          Recording
        </Txt>
        <Txt
          weight="semibold"
          size={13}
          color={recording ? colors.statusGreen : colors.body}>
          {statusLabel}
        </Txt>
        <Txt size={12.5} color={colors.body} lh={19}>
          Recording starts only when you request it here. The wearable remains
          idle after boot and after a sync.
        </Txt>
        {state.recordingError && (
          <Txt size={12} color={colors.destructive} lh={17}>
            {state.recordingError}
          </Txt>
        )}
        <PrimaryButton
          label={recording ? statusLabel : 'Start recording'}
          disabled={
            recording ||
            state.recordingState === 'checking'
          }
          loading={state.recordingState === 'starting'}
          onPress={startRecording}
          paddingVertical={13}
        />
        {state.recordingState === 'error' && (
          <Pressable onPress={refreshRecordingStatus}>
            <Txt weight="semibold" size={12.5} color={colors.primaryGreenDark}>
              Retry device connection
            </Txt>
          </Pressable>
        )}
      </Glass>

      <Pressable onPress={() => patch({ showUnpairConfirm: true })}>
        {({ pressed }) => (
          <Glass
            variant="soft"
            radius={radii.cardSm}
            style={{ padding: 16, opacity: pressed ? 0.85 : 1 }}>
            <Txt weight="semibold" size={14} color={colors.destructive}>
              Unpair device
            </Txt>
          </Glass>
        )}
      </Pressable>
    </ScrollView>
  );
}
