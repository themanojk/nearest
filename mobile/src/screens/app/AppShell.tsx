import React, { useCallback } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, shadows } from '../../theme/theme';
import { useStore } from '../../state/store';
import { transport } from '../../services/transport';
import { Tab } from '../../state/types';
import Txt from '../../components/Txt';
import Glass from '../../components/Glass';
import Icon from '../../components/Icon';
import BrandMark from '../../components/BrandMark';
import { PrimaryButton } from '../../components/Buttons';

import TodayScreen from './TodayScreen';
import HistoryScreen from './HistoryScreen';
import DeviceScreen from './DeviceScreen';
import ProfileScreen from './ProfileScreen';

import SyncFlow from '../../modals/SyncFlow';
import EventSheet from '../../modals/EventSheet';
import NotificationsPanel from '../../modals/NotificationsPanel';
import Dialogs from '../../modals/Dialogs';

const TABS: { key: Tab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'history', label: 'History' },
  { key: 'device', label: 'Device' },
  { key: 'profile', label: 'Profile' },
];

export default function AppShell() {
  const { state, patch, setTab, notifications } = useStore();
  const insets = useSafeAreaInsets();

  const checkFirmware = useCallback(async () => {
    patch({ showFirmwareDialog: true, firmwareState: 'checking' });
    try {
      await transport.checkFirmware();
      patch({ firmwareState: 'uptodate' });
    } catch {
      patch({ showFirmwareDialog: false, firmwareState: null });
    }
  }, [patch]);

  const bar: Record<Tab, { hint: string; cta: string; onPress: () => void }> = {
    today: {
      hint: 'Nothing leaves the device until you start a sync.',
      cta: "Sync today's recording",
      onPress: () => patch({ syncStage: 'preflight' }),
    },
    history: {
      hint: 'Raw audio is deleted 7 days after a report completes.',
      cta: 'Sync a new recording',
      onPress: () => patch({ syncStage: 'preflight' }),
    },
    device: {
      hint: 'Recording runs on the device only — no live streaming.',
      cta: 'Check for firmware updates',
      onPress: checkFirmware,
    },
    profile: {
      hint: 'You control retention, sharing and deletion at any time.',
      cta: 'Manage subscription',
      onPress: () => patch({ profileView: 'subscription' }),
    },
  };

  const activeBar = bar[state.activeTab];
  const hasUnread = !state.notifCleared && notifications.length > 0;

  const renderTab = () => {
    switch (state.activeTab) {
      case 'today':
        return <TodayScreen />;
      case 'history':
        return <HistoryScreen />;
      case 'device':
        return <DeviceScreen />;
      case 'profile':
        return <ProfileScreen />;
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingHorizontal: 22,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BrandMark size={24} strokeWidth={3} />
          <Txt weight="serif" size={22} color={colors.ink}>
            NearNest
          </Txt>
        </View>
        <Pressable onPress={() => patch({ notifPanelOpen: true })} hitSlop={6}>
          <Glass
            variant="soft"
            radius={radii.tileSm}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bell" size={16} />
          </Glass>
          {hasUnread && (
            <View
              style={{
                position: 'absolute',
                top: -1,
                right: -1,
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: colors.primaryGreenDark,
                borderWidth: 2,
                borderColor: colors.notifDotBorder,
              }}
            />
          )}
        </Pressable>
      </View>

      {/* Tab pills */}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 22, gap: 8, paddingBottom: 6 }}>
          {TABS.map((t) => {
            const active = state.activeTab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 16,
                  borderRadius: radii.chip,
                  borderWidth: 1,
                  backgroundColor: active ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)',
                  borderColor: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)',
                  ...(active ? shadows.smallTile : null),
                }}>
                <Txt weight="semibold" size={12} color={active ? colors.ink : colors.body}>
                  {t.label}
                </Txt>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>{renderTab()}</View>

      {/* Bottom action bar */}
      <Glass
        variant="strong"
        radius={radii.card}
        style={{
          marginHorizontal: 16,
          marginBottom: 16 + insets.bottom,
          paddingVertical: 14,
          paddingHorizontal: 16,
          gap: 10,
          ...shadows.bar,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="shield" size={15} color={colors.statusGreen} />
          <Txt size={11.5} color={colors.body} style={{ flex: 1 }}>
            {activeBar.hint}
          </Txt>
        </View>
        <PrimaryButton
          label={activeBar.cta}
          fontSize={14.5}
          paddingVertical={13}
          onPress={activeBar.onPress}
        />
      </Glass>

      {/* Modals */}
      <SyncFlow />
      <EventSheet />
      <NotificationsPanel />
      <Dialogs />
    </View>
  );
}
