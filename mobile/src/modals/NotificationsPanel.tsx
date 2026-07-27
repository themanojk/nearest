import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, shadows } from '../theme/theme';
import { useStore } from '../state/store';
import { NotifSeverity } from '../state/types';
import Overlay from '../components/Overlay';
import Glass from '../components/Glass';
import Txt from '../components/Txt';
import Icon from '../components/Icon';

const dotColor: Record<NotifSeverity, string> = {
  warn: colors.warnText,
  review: colors.destructive,
  info: colors.primaryGreenDark,
};

export default function NotificationsPanel() {
  const { state, patch, notifications } = useStore();
  const insets = useSafeAreaInsets();

  const close = () => patch({ notifPanelOpen: false });

  return (
    <Overlay
      visible={state.notifPanelOpen}
      onRequestClose={close}
      scrim={colors.scrimDialog}
      align="top"
      contentStyle={{ marginTop: insets.top + 60, marginHorizontal: 16 }}>
      <Glass
        variant="modal"
        radius={radii.card}
        style={{ maxHeight: 420, ...shadows.dialog, overflow: 'hidden' }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}>
          <Txt weight="bold" size={15} color={colors.ink}>
            Notifications
          </Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Pressable onPress={() => patch({ notifCleared: !state.notifCleared })} hitSlop={8}>
              <Txt weight="semibold" size={12} color={colors.statusGreen}>
                {state.notifCleared ? 'Restore' : 'Clear all'}
              </Txt>
            </Pressable>
            <Pressable onPress={close} hitSlop={8}>
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
        </View>

        {notifications.length === 0 ? (
          <View style={{ alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingVertical: 32 }}>
            <Txt weight="serif" size={16} color={colors.ink}>
              You're all caught up
            </Txt>
            <Txt size={13} color={colors.body} center>
              No new notifications right now.
            </Txt>
          </View>
        ) : (
          <ScrollView>
            {notifications.map((n, i) => (
              <View
                key={n.id}
                style={{
                  flexDirection: 'row',
                  gap: 10,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: 'rgba(255,255,255,0.5)',
                }}>
                <View
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 5,
                    marginTop: 4,
                    backgroundColor: dotColor[n.severity],
                  }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt weight="semibold" size={13.5} color={colors.ink}>
                    {n.title}
                  </Txt>
                  <Txt size={12.5} color={colors.body} lh={18}>
                    {n.body}
                  </Txt>
                  <Txt size={11} color={colors.muted} style={{ marginTop: 2 }}>
                    {n.time}
                  </Txt>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </Glass>
    </Overlay>
  );
}
