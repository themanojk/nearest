import React, { useCallback } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, shadows } from '../../theme/theme';
import { useStore } from '../../state/store';
import { transport } from '../../services/transport';
import { DEVICE_DEFAULTS, PLAN } from '../../state/seed';
import Txt from '../../components/Txt';
import Glass from '../../components/Glass';
import Icon from '../../components/Icon';
import BrandMark from '../../components/BrandMark';
import ChildrenIllustration from '../../components/ChildrenIllustration';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import ProgressDots from './ProgressDots';

const DISCLOSURES = [
  "Recording laws vary by location — you're responsible for informing anyone regularly present.",
  'Nothing leaves the device until you start a sync. There is no live streaming.',
  'Findings are confidence-scored observations, not medical or legal conclusions.',
  'In an urgent situation, contact local emergency services — never rely on this app.',
];

export default function OnboardingFlow() {
  const { state, patch } = useStore();
  const insets = useSafeAreaInsets();
  const step = state.onboardStep;

  const go = useCallback((s: number) => patch({ onboardStep: s }), [patch]);

  const startPairing = useCallback(async () => {
    patch({ pairingSearching: true });
    try {
      await transport.scanAndPair();
      patch({ pairingSearching: false, onboardStep: 4 });
    } catch {
      patch({ pairingSearching: false });
    }
  }, [patch]);

  const topPad = insets.top + 8;
  const bottomPad = insets.bottom + 8;

  // ---- Step 0: Welcome ----------------------------------------------------
  if (step === 0) {
    return (
      <View style={{ flex: 1, paddingTop: topPad, paddingBottom: bottomPad }}>
        <View style={{ height: 330, alignItems: 'center', justifyContent: 'center' }}>
          <View
            style={{
              position: 'absolute',
              top: 34,
              width: 250,
              height: 250,
              borderRadius: 999,
              borderBottomLeftRadius: 40,
              borderBottomRightRadius: 40,
              backgroundColor: 'rgba(255,255,255,0.5)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.85)',
            }}
          />
          <ChildrenIllustration />
        </View>
        <View style={{ paddingHorizontal: spacing.onboardGutter, alignItems: 'center', gap: 14 }}>
          <Txt weight="serif" size={34} color={colors.ink} lh={38}>
            NearNest
          </Txt>
          <Txt size={15} color={colors.body} center lh={22} style={{ maxWidth: 280 }}>
            A wearable and app that turns your child's day into a calm, honest summary — never a
            live feed, never a claim you can't verify.
          </Txt>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ paddingHorizontal: spacing.onboardGutter }}>
          <PrimaryButton label="Get started" onPress={() => go(1)} />
        </View>
        <ProgressDots step={0} />
      </View>
    );
  }

  // ---- Step 1: Consent ----------------------------------------------------
  if (step === 1) {
    return (
      <View style={{ flex: 1, paddingTop: topPad, paddingBottom: bottomPad }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: 30, gap: 14 }}
          showsVerticalScrollIndicator={false}>
          <Txt weight="serif" size={24} color={colors.ink} lh={28}>
            Before you begin
          </Txt>
          <Txt size={13.5} color={colors.body} lh={20}>
            NearNest records audio near your child throughout the day. Please review how this
            works.
          </Txt>
          <View style={{ gap: 10 }}>
            {DISCLOSURES.map((d, i) => (
              <Glass key={i} variant="soft" radius={radii.tileSm} style={{ padding: 13 }}>
                <Txt size={13} color={colors.body} lh={19.5}>
                  {d}
                </Txt>
              </Glass>
            ))}
          </View>
          <Pressable
            onPress={() => patch({ consentChecked: !state.consentChecked })}
            style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 4 }}>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                marginTop: 1,
                borderWidth: 1.5,
                borderColor: colors.primaryGreenDark,
                backgroundColor: state.consentChecked ? colors.primaryGreenDark : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              {state.consentChecked && <Icon name="check" size={13} color={colors.white} strokeWidth={3} />}
            </View>
            <Txt size={13} color={colors.body} lh={19} style={{ flex: 1 }}>
              I understand and agree to the Terms, Privacy Notice and recording-consent guidance.
            </Txt>
          </Pressable>
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 8 }}>
          <GhostButton label="Back" onPress={() => go(0)} />
          <View style={{ flex: 1 }}>
            <PrimaryButton
              label="Continue"
              disabled={!state.consentChecked}
              onPress={() => go(2)}
            />
          </View>
        </View>
        <ProgressDots step={1} />
      </View>
    );
  }

  // ---- Step 2: Add device -------------------------------------------------
  if (step === 2) {
    return (
      <StepScaffold
        step={2}
        title="Add your device"
        body="Charge the wearable fully and keep it within a few feet of your phone before pairing."
        onBack={() => go(1)}
        primaryLabel="My device is charged"
        onPrimary={() => go(3)}>
        <IconTile size={140} radius={20}>
          <Icon name="watch" size={52} />
        </IconTile>
      </StepScaffold>
    );
  }

  // ---- Step 3: Pair -------------------------------------------------------
  if (step === 3) {
    const searching = state.pairingSearching;
    return (
      <StepScaffold
        step={3}
        title="Pair the device"
        body="Press and hold the button on the device for 3 seconds until the light pulses."
        primaryLabel={searching ? 'Searching…' : 'Start pairing'}
        primaryDisabled={searching}
        onPrimary={startPairing}>
        <View
          style={{
            width: 104,
            height: 104,
            borderRadius: 26,
            backgroundColor: colors.glassStrong,
            borderWidth: 1,
            borderColor: colors.glassBorderStrong,
            alignItems: 'center',
            justifyContent: 'center',
            ...(searching
              ? {
                  shadowColor: 'rgba(61,122,84,0.6)',
                  shadowOpacity: 1,
                  shadowRadius: 0,
                  shadowOffset: { width: 0, height: 0 },
                  borderColor: 'rgba(61,122,84,0.35)',
                }
              : null),
          }}>
          {searching && (
            <View
              style={{
                position: 'absolute',
                width: 120,
                height: 120,
                borderRadius: 34,
                backgroundColor: 'rgba(61,122,84,0.15)',
              }}
            />
          )}
          <Icon name="mic" size={28} />
        </View>
        <View
          style={{
            marginTop: 16,
            backgroundColor: colors.tintChip,
            borderRadius: radii.chip,
            paddingHorizontal: 12,
            paddingVertical: 7,
          }}>
          <Txt weight="semibold" size={12.5} color={colors.statusGreen}>
            {searching ? 'Searching for device…' : 'Waiting to start'}
          </Txt>
        </View>
      </StepScaffold>
    );
  }

  // ---- Step 4: Device found ----------------------------------------------
  if (step === 4) {
    return (
      <StepScaffold
        step={4}
        title="Device found"
        body="Confirm this code matches the light pattern on your device."
        primaryLabel="Confirm match"
        onPrimary={() => go(5)}>
        <IconTile size={64} radius={16}>
          <Icon name="check" size={26} strokeWidth={2.4} />
        </IconTile>
        <View
          style={{
            marginTop: 20,
            backgroundColor: colors.glassStrong,
            borderRadius: radii.tileSm,
            paddingVertical: 12,
            paddingHorizontal: 20,
          }}>
          <Txt weight="serif" size={26} color={colors.primaryGreenDark} ls={3}>
            NN · 7734
          </Txt>
        </View>
      </StepScaffold>
    );
  }

  // ---- Step 5: Set up device ---------------------------------------------
  if (step === 5) {
    return (
      <View style={{ flex: 1, paddingTop: topPad, paddingBottom: bottomPad }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: 30, gap: 18 }}
          showsVerticalScrollIndicator={false}>
          <Txt weight="serif" size={24} color={colors.ink} lh={28}>
            Set up the device
          </Txt>
          <Field
            label="Device name"
            value={state.deviceNameInput}
            onChangeText={(t) => patch({ deviceNameInput: t })}
          />
          <Field
            label="Child nickname"
            value={state.childNicknameInput}
            onChangeText={(t) => patch({ childNicknameInput: t })}
          />
          <Field label="Time zone" value={DEVICE_DEFAULTS.timeZone} readOnly />
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 8 }}>
          <GhostButton label="Back" onPress={() => go(4)} />
          <View style={{ flex: 1 }}>
            <PrimaryButton label="Continue" onPress={() => go(6)} />
          </View>
        </View>
        <ProgressDots step={5} />
      </View>
    );
  }

  // ---- Step 6: Plan -------------------------------------------------------
  return (
    <View style={{ flex: 1, paddingTop: topPad, paddingBottom: bottomPad }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: 30, gap: 14 }}
        showsVerticalScrollIndicator={false}>
        <Txt weight="serif" size={24} color={colors.ink} lh={28}>
          Choose your plan
        </Txt>
        <Glass variant="strong" radius={radii.card} shadow="card" style={{ padding: 20, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Txt weight="serif" size={19} color={colors.ink}>
              {PLAN.name}
            </Txt>
            <View
              style={{
                backgroundColor: colors.tintChipStrong,
                borderRadius: radii.chip,
                paddingHorizontal: 8,
                paddingVertical: 4,
              }}>
              <Txt weight="bold" size={11} color={colors.ink}>
                {PLAN.trial}
              </Txt>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            <Txt weight="bold" size={25} color={colors.ink}>
              {PLAN.price}
            </Txt>
            <Txt weight="medium" size={13} color={colors.body} style={{ marginBottom: 3 }}>
              {PLAN.cadence}
            </Txt>
          </View>
          <Txt size={12.5} color={colors.body} lh={18}>
            {PLAN.features}
          </Txt>
        </Glass>
        <Txt size={11.5} color={colors.muted} lh={17}>
          {PLAN.trialFootnote}
        </Txt>
      </ScrollView>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: 8 }}>
        <PrimaryButton
          label="Start free trial"
          onPress={() => patch({ phase: 'app', activeTab: 'today' })}
        />
      </View>
      <ProgressDots step={6} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StepScaffold({
  step,
  title,
  body,
  children,
  onBack,
  primaryLabel,
  primaryDisabled,
  onPrimary,
}: {
  step: number;
  title: string;
  body: string;
  children: React.ReactNode;
  onBack?: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: 30, gap: 14 }}>
        <Txt weight="serif" size={24} color={colors.ink} lh={28}>
          {title}
        </Txt>
        <Txt size={13.5} color={colors.body} lh={20}>
          {body}
        </Txt>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
      <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg }}>
        {onBack && <GhostButton label="Back" onPress={onBack} />}
        <View style={{ flex: 1 }}>
          <PrimaryButton label={primaryLabel} disabled={primaryDisabled} onPress={onPrimary} />
        </View>
      </View>
      <ProgressDots step={step} />
    </View>
  );
}

function IconTile({
  size,
  radius,
  children,
}: {
  size: number;
  radius: number;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: colors.glassStrong,
        borderWidth: 1,
        borderColor: colors.glassBorderStrong,
        alignItems: 'center',
        justifyContent: 'center',
        ...shadows.smallTile,
      }}>
      {children}
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  readOnly,
}: {
  label: string;
  value: string;
  onChangeText?: (t: string) => void;
  readOnly?: boolean;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Txt weight="semibold" size={12} color={colors.body}>
        {label}
      </Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={!readOnly}
        style={{
          backgroundColor: colors.glassFieldBg,
          borderWidth: 1,
          borderColor: colors.glassBorderStrong,
          borderRadius: radii.tileSm,
          paddingHorizontal: 13,
          paddingVertical: 12,
          fontSize: 14,
          fontFamily: 'Work Sans',
          color: readOnly ? colors.muted : colors.ink,
        }}
      />
    </View>
  );
}
