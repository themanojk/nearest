import React, { useEffect, useRef, useState } from 'react';
import { AppState, View, ScrollView } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useAllowance, useStore } from '../../state/store';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';
import Chip from '../../components/Chip';
import ProgressBar from '../../components/ProgressBar';
import HomeInsights from '../../components/HomeInsights';
import { transport } from '../../services/transport';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'baseline' }}>
      <Txt size={11.5} color={colors.body}>
        {label}{' '}
      </Txt>
      <Txt weight="bold" size={11.5} color={colors.ink}>
        {value}
      </Txt>
    </View>
  );
}

export default function TodayScreen() {
  const { state, patch } = useStore();
  const { used, total, remaining, resets } = useAllowance();
  const [uploadedCount, setUploadedCount] = useState<number | null>(null);
  const telemetryInFlight = useRef(false);

  useEffect(() => {
    if (state.syncStage !== null) return;
    let disposed = false;
    let appState = AppState.currentState;
    const refreshTelemetry = async () => {
      if (disposed || appState !== 'active' || telemetryInFlight.current) return;
      telemetryInFlight.current = true;
      try {
        const telemetry = await transport.getDeviceTelemetry();
        if (disposed || appState !== 'active') return;
        patch({
          deviceBattery: telemetry.batteryPercent,
          deviceStorage: Math.round(
            (telemetry.storageUsedBytes / telemetry.storageTotalBytes) * 100,
          ),
        });
      } catch {
        // Keep the last reading when disconnected; retry on the next tick.
      } finally {
        telemetryInFlight.current = false;
      }
    };
    void refreshTelemetry();
    const timer = setInterval(() => void refreshTelemetry(), 10_000);
    const subscription = AppState.addEventListener('change', nextState => {
      const wasActive = appState === 'active';
      appState = nextState;
      if (!wasActive && nextState === 'active') void refreshTelemetry();
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [patch, state.syncStage]);


  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 16 }}
      showsVerticalScrollIndicator={false}>
      {state.showPhotoBanner && (
        <View
          style={{
            height: 140,
            borderRadius: radii.tile,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.8)',
            backgroundColor: 'rgba(255,255,255,0.4)',
          }}
        />
      )}


      {/* Device card */}
      <Glass variant="strong" radius={radii.card} shadow="card" style={{ padding: 20, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Txt weight="medium" size={16} color={colors.ink}>
            {state.deviceNameInput}
          </Txt>
          <Chip label="Nearby" bg={colors.tintChip} color={colors.statusGreen} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 6 }}>
          <Stat
            label="Battery"
            value={
              state.deviceBattery === null
                ? '—'
                : `${state.deviceBattery}%`
            }
          />
          <Stat
            label="Storage"
            value={
              state.deviceStorage === null
                ? '—'
                : `${state.deviceStorage}%`
            }
          />
          <Stat label="Uploaded recordings" value={uploadedCount === null ? '—' : String(uploadedCount)} />
          <Stat label="" value={`${remaining}/${total} syncs`} />
        </View>
        <Txt size={11} color={colors.muted}>
          Last sync: {state.lastSyncLabel}
        </Txt>
      </Glass>

      {/* Allowance */}
      <View style={{ gap: 6 }}>
        <ProgressBar value={total ? used / total : 0} />
        <Txt size={10.5} color={colors.muted}>
          Sync allowance resets {resets}
        </Txt>
      </View>

      <HomeInsights onCount={setUploadedCount} refreshKey={state.syncsUsed} paused={state.syncStage !== null && !['complete', 'failed', 'preflight'].includes(state.syncStage)} />

      {/* Standing disclaimer */}
      <Glass variant="soft" radius={radii.cardSm} style={{ padding: 14 }}>
        <Txt size={11.5} color={colors.body} lh={17}>
          Automated analysis can be incomplete or incorrect. Absence of alerts doesn't guarantee
          absence of risk.
        </Txt>
      </Glass>
    </ScrollView>
  );
}
