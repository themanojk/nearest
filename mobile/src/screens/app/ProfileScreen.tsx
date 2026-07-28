import React from 'react';
import { ScrollView, Pressable } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useAllowance, useStore } from '../../state/store';
import { PLAN } from '../../state/seed';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';
import Icon from '../../components/Icon';
import ProgressBar from '../../components/ProgressBar';
import { PrimaryButton, OutlineButton } from '../../components/Buttons';

function NavRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <Glass
          variant="soft"
          radius={radii.cardSm}
          style={{
            padding: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            opacity: pressed ? 0.85 : 1,
          }}>
          <Txt weight="medium" size={14} color={colors.ink}>
            {label}
          </Txt>
          <Icon name="chevronRight" size={18} color={colors.muted} />
        </Glass>
      )}
    </Pressable>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <Pressable
      onPress={onBack}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 }}>
      <Icon name="chevronLeft" size={20} color={colors.ink} />
      <Txt weight="serif" size={19} color={colors.ink}>
        {title}
      </Txt>
    </Pressable>
  );
}

export default function ProfileScreen() {
  const { state, patch, clearHistory } = useStore();
  const { used, total, remaining, resets } = useAllowance();

  // ---- Subscription -------------------------------------------------------
  if (state.profileView === 'subscription') {
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 14 }}
        showsVerticalScrollIndicator={false}>
        <BackHeader title="Subscription" onBack={() => patch({ profileView: 'main' })} />
        <Glass variant="strong" radius={radii.card} shadow="card" style={{ padding: 20, gap: 12 }}>
          <Txt weight="semibold" size={15} color={colors.ink}>
            {PLAN.name} — {PLAN.price}/mo
          </Txt>
          <ProgressBar value={total ? used / total : 0} />
          <Txt size={12.5} color={colors.body}>
            {used} used · {remaining} remaining · resets {resets}
          </Txt>
        </Glass>
        <PrimaryButton label="Upgrade plan" onPress={() => {}} />
        <OutlineButton
          label="Cancel subscription"
          color={colors.body}
          borderColor="rgba(61,122,84,0.3)"
          onPress={() => {}}
        />
      </ScrollView>
    );
  }

  // ---- Privacy & data -----------------------------------------------------
  if (state.profileView === 'privacy') {
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 12 }}
        showsVerticalScrollIndicator={false}>
        <BackHeader title="Privacy & data" onBack={() => patch({ profileView: 'main' })} />
        <Glass variant="soft" radius={radii.cardSm} style={{ padding: 16, gap: 6 }}>
          <Txt weight="semibold" size={14} color={colors.ink}>
            Raw audio retention
          </Txt>
          <Txt size={13} color={colors.body} lh={19}>
            Deleted automatically 7 days after report completion.
          </Txt>
        </Glass>
        <OutlineButton
          label="Delete all recordings"
          color={colors.destructive}
          borderColor={colors.destructiveBorder}
          onPress={clearHistory}
        />
        <OutlineButton
          label="Delete account"
          color={colors.destructive}
          borderColor={colors.destructiveBorder}
          onPress={() => {}}
        />
      </ScrollView>
    );
  }

  // ---- Main ---------------------------------------------------------------
  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 10 }}
      showsVerticalScrollIndicator={false}>
      <NavRow label="Subscription & allowance" onPress={() => patch({ profileView: 'subscription' })} />
      <NavRow label="Privacy & data" onPress={() => patch({ profileView: 'privacy' })} />
      <NavRow label="Notifications" onPress={() => patch({ notifPanelOpen: true })} />
      <NavRow label="Support" onPress={() => {}} />

      <Pressable onPress={() => patch({ showLogoutConfirm: true })} style={{ marginTop: 6 }}>
        {({ pressed }) => (
          <Glass
            variant="soft"
            radius={radii.cardSm}
            style={{
              padding: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              opacity: pressed ? 0.85 : 1,
            }}>
            <Icon name="logout" size={16} color={colors.destructive} />
            <Txt weight="semibold" size={14} color={colors.destructive}>
              Log out
            </Txt>
          </Glass>
        )}
      </Pressable>

      <Txt size={11} color={colors.muted} center style={{ marginTop: 8 }}>
        NearNest 1.0.4 · signed in as {state.authedPhone ?? '+91 90000 00000'}
      </Txt>
    </ScrollView>
  );
}
