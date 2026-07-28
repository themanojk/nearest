import React, { useCallback } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, shadows } from '../../theme/theme';
import { useStore } from '../../state/store';
import { transport } from '../../services/transport';
import {
  completePairingSession,
  createChildProfile,
  discoverPairingDevice,
  listOwnedDevices,
  startPairingSession,
  verifyPairingDevice,
} from '../../services/devices';
import { DEVICE_DEFAULTS, PLAN } from '../../state/seed';
import Txt from '../../components/Txt';
import Glass from '../../components/Glass';
import Icon from '../../components/Icon';
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
  const { state, patch, completeOnboarding } = useStore();
  const insets = useSafeAreaInsets();
  const step = state.onboardStep;

  const go = useCallback((s: number) => patch({ onboardStep: s }), [patch]);

  const startPairing = useCallback(async () => {
    patch({ pairingSearching: true, pairingError: null });
    try {
      const scanned = await transport.scanAndPair();
      if (scanned.trust === 'simulated') {
        patch({
          pairedDeviceCode: scanned.code,
          pairingSearching: false,
          onboardStep: 4,
        });
        return;
      }

      const existingDevice = (await listOwnedDevices()).find(
        (device) =>
          device.serialNumber === scanned.serialNumber &&
          device.pairingStatus === 'paired' &&
          device.lifecycleStatus === 'active',
      );
      if (existingDevice) {
        patch({
          pairedDeviceCode: scanned.code,
          pairingSearching: false,
        });
        completeOnboarding();
        return;
      }

      const started = await startPairingSession();
      const discovered = await discoverPairingDevice(
        started.id,
        scanned.serialNumber,
      );
      if (!discovered.challenge) {
        throw new Error('The server did not issue a device challenge');
      }
      const signature = await transport.signPairingChallenge(
        discovered.challenge.payload,
      );
      await verifyPairingDevice(
        started.id,
        discovered.challenge.challengeId,
        signature,
      );
      patch({
        pairedDeviceCode: scanned.code,
        pairingSessionId: started.id,
        pairingSearching: false,
        onboardStep: 4,
      });
    } catch (error) {
      patch({
        pairingSearching: false,
        pairingError:
          error instanceof Error ? error.message : 'Pairing could not be completed',
      });
    }
  }, [completeOnboarding, patch]);

  const saveSetup = useCallback(async () => {
    const nickname = state.childNicknameInput.trim();
    const deviceName = state.deviceNameInput.trim();
    if (!nickname || !deviceName) {
      patch({
        pairingError: 'Device name and child nickname are required',
      });
      return;
    }
    patch({ setupSaving: true, pairingError: null });
    try {
      let childId = state.onboardingChildId;
      if (!childId) {
        const child = await createChildProfile(nickname);
        childId = child.id;
        // Preserve the created child across a retry if pairing completion
        // fails after this request succeeds.
        patch({ onboardingChildId: childId });
      }
      if (state.pairingSessionId) {
        await completePairingSession(
          state.pairingSessionId,
          childId,
          deviceName,
        );
      }
      patch({
        onboardingChildId: childId,
        setupSaving: false,
        onboardStep: 6,
        wifiPasswordInput: '',
      });
    } catch (error) {
      patch({
        setupSaving: false,
        pairingError:
          error instanceof Error ? error.message : 'Device setup could not be saved',
      });
    }
  }, [
    patch,
    state.childNicknameInput,
    state.deviceNameInput,
    state.onboardingChildId,
    state.pairingSessionId,
  ]);

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
          <PrimaryButton
            label="Get started"
            onPress={() => (state.authedPhone ? go(1) : patch({ phase: 'auth' }))}
          />
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
        body="Keep the wearable nearby. Android will ask for the six-digit Bluetooth code printed on its label."
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
        {state.pairingError && (
          <Txt size={12.5} color={colors.destructive} center>
            {state.pairingError}
          </Txt>
        )}
      </StepScaffold>
    );
  }

  // ---- Step 4: Device found ----------------------------------------------
  if (step === 4) {
    return (
      <StepScaffold
        step={4}
        title="Device found"
        body="Confirm the final two digits match the Bluetooth code printed on the wearable label."
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
            {state.pairedDeviceCode ?? 'NN · ----'}
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
          <Glass style={{ padding: 14 }}>
            <Txt size={13} color={colors.body} lh={19}>
              The wearable does not join your home Wi-Fi or access the
              internet. During sync it creates a temporary private network for
              this phone.
            </Txt>
          </Glass>
          <Field label="Time zone" value={DEVICE_DEFAULTS.timeZone} readOnly />
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 8 }}>
          <GhostButton label="Back" onPress={() => go(4)} />
          <View style={{ flex: 1 }}>
            <PrimaryButton
              label={state.setupSaving ? 'Saving…' : 'Continue'}
              disabled={state.setupSaving}
              onPress={saveSetup}
            />
          </View>
        </View>
        {state.pairingError && (
          <Txt
            size={12.5}
            color={colors.destructive}
            center
            style={{ paddingHorizontal: spacing.lg, paddingTop: 8 }}>
            {state.pairingError}
          </Txt>
        )}
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
          onPress={completeOnboarding}
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
  secureTextEntry,
  autoCapitalize,
}: {
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  label: string;
  value: string;
  onChangeText?: (t: string) => void;
  readOnly?: boolean;
  secureTextEntry?: boolean;
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
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        style={{
          backgroundColor: colors.glassFieldBg,
          borderWidth: 1,
          borderColor: colors.glassBorderStrong,
          borderRadius: radii.tileSm,
          paddingHorizontal: 13,
          paddingVertical: 12,
          fontSize: 14,
          fontFamily: 'WorkSans-Regular',
          color: readOnly ? colors.muted : colors.ink,
        }}
      />
    </View>
  );
}
