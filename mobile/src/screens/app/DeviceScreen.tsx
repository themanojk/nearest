import React from 'react';
import { ScrollView, Pressable } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useStore } from '../../state/store';
import { DEVICE_DEFAULTS } from '../../state/seed';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';

export default function DeviceScreen() {
  const { state, patch } = useStore();
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
          Recording schedule: {DEVICE_DEFAULTS.schedule}
        </Txt>
        <Txt size={12.5} color={colors.body} lh={19}>
          {state.deviceBattery}% battery · {state.deviceStorage}% storage used
        </Txt>
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
