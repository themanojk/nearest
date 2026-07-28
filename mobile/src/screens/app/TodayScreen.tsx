import React, { useCallback, useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useAllowance, useStore } from '../../state/store';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';
import Chip from '../../components/Chip';
import ProgressBar from '../../components/ProgressBar';
import EventRow from '../../components/EventRow';
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
  const { state, patch, reports, restoreSample } = useStore();
  const { used, total, remaining, resets } = useAllowance();
  const refreshTelemetry = useCallback(async () => {
    try {
      const telemetry = await transport.getDeviceTelemetry();
      patch({
        deviceBattery: telemetry.batteryPercent,
        deviceStorage: Math.round(
          (telemetry.storageUsedBytes / telemetry.storageTotalBytes) * 100,
        ),
      });
    } catch {
      // Preserve the last successful reading while the wearable is out of
      // range. The next screen visit retries the BLE telemetry request.
    }
  }, [patch]);

  useEffect(() => {
    void refreshTelemetry();
  }, [refreshTelemetry]);

  const todayReport = reports.find((r) => r.isToday);

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

      {/* Today's moments */}
      <View style={{ gap: 10 }}>
        <Txt weight="serif" size={17} color={colors.ink}>
          Today's moments
        </Txt>
        {todayReport ? (
          todayReport.events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              onPress={() =>
                patch({ selectedReportId: todayReport.id, selectedEventId: e.id })
              }
            />
          ))
        ) : (
          <Glass variant="soft" radius={radii.cardSm} style={{ padding: 14, gap: 8 }}>
            <Txt size={12.5} color={colors.body} lh={19}>
              No sync yet today. Tap the sync button to capture today's moments.
            </Txt>
            {state.historyCleared && (
              <Pressable onPress={restoreSample}>
                <Txt weight="semibold" size={12.5} color={colors.statusGreen}>
                  Restore sample data
                </Txt>
              </Pressable>
            )}
          </Glass>
        )}
      </View>

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
