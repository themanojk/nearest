import React, { useEffect, useRef, useState } from 'react';
import { View, ScrollView, TextInput, Pressable, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, shadows } from '../../theme/theme';
import { useStore } from '../../state/store';
import Txt from '../../components/Txt';
import Icon from '../../components/Icon';
import BrandMark from '../../components/BrandMark';
import { PrimaryButton } from '../../components/Buttons';
import {
  ApiError,
  sendPhoneOtp,
  verifyPhoneOtp,
} from '../../services/auth';

const COUNTRY = '+91';
const OTP_LEN = 4;
const RESEND_SECONDS = 30;

/** "9876543210" -> "98765 43210" */
function formatPhone(d: string) {
  return d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
}

export default function LoginScreen() {
  const { onAuthenticated, patch } = useStore();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const otpRef = useRef<TextInput>(null);

  const phoneDigits = phone.replace(/\D/g, '');
  const canSend = phoneDigits.length === 10;
  const canVerify = code.length === OTP_LEN;
  const fullPhone = `${COUNTRY} ${formatPhone(phoneDigits)}`;

  // resend countdown
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const sendCode = async () => {
    if (!canSend || loading) return;
    Keyboard.dismiss();
    setError(null);
    setLoading(true);
    try {
      const result = await sendPhoneOtp(COUNTRY, phoneDigits);
      setVerificationId(result.verificationId);
      setDevelopmentCode(result.developmentCode ?? null);
      setStep('otp');
      setCode('');
      setSeconds(RESEND_SECONDS);
      setTimeout(() => otpRef.current?.focus(), 350);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Unable to send the verification code. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!canVerify || !verificationId || loading) return;
    Keyboard.dismiss();
    setError(null);
    setLoading(true);
    try {
      const session = await verifyPhoneOtp(verificationId, code);
      onAuthenticated(session);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'The verification code could not be confirmed.',
      );
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (seconds > 0 || loading) return;
    await sendCode();
  };

  const back = () => {
    Keyboard.dismiss();
    if (step === 'otp') {
      setStep('phone');
      return;
    }
    patch({ phase: 'onboarding', onboardStep: 0 });
  };

  const subtitle =
    step === 'phone'
      ? "Enter your phone number and we'll text you a verification code."
      : `Enter the ${OTP_LEN}-digit code sent to ${fullPhone}.`;

  return (
    <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Pressable
        onPress={back}
        hitSlop={8}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          paddingVertical: 8,
          paddingHorizontal: spacing.lg,
          alignSelf: 'flex-start',
        }}>
        <Icon name="chevronLeft" size={20} color={colors.body} />
        <Txt weight="semibold" size={14} color={colors.body}>
          Back
        </Txt>
      </Pressable>

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: spacing.onboardGutter }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {/* Brand */}
        <View style={{ alignItems: 'center', marginTop: 24, gap: 16 }}>
          <View
            style={{
              width: 104,
              height: 104,
              borderRadius: 28,
              backgroundColor: colors.glassStrong,
              borderWidth: 1,
              borderColor: colors.glassBorderStrong,
              alignItems: 'center',
              justifyContent: 'center',
              ...shadows.smallTile,
            }}>
            <BrandMark size={50} strokeWidth={2.4} withOuterArc />
          </View>
          <Txt weight="serif" size={34} color={colors.ink} lh={38}>
            NearNest
          </Txt>
          <Txt size={15} color={colors.body} center lh={22} style={{ maxWidth: 300 }}>
            {subtitle}
          </Txt>
        </View>

        {/* Form */}
        <View style={{ marginTop: 36, gap: 16 }}>
          {step === 'phone' ? (
            <View style={{ gap: 6 }}>
              <Txt weight="semibold" size={12} color={colors.body}>
                Phone number
              </Txt>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View
                  style={{
                    justifyContent: 'center',
                    paddingHorizontal: 16,
                    backgroundColor: colors.glassFieldBg,
                    borderWidth: 1,
                    borderColor: colors.glassBorderStrong,
                    borderRadius: radii.tileSm,
                  }}>
                  <Txt weight="semibold" size={15} color={colors.ink}>
                    {COUNTRY}
                  </Txt>
                </View>
                <TextInput
                  value={formatPhone(phoneDigits)}
                  onChangeText={(t) => setPhone(t.replace(/\D/g, '').slice(0, 10))}
                  placeholder="98765 43210"
                  placeholderTextColor={colors.faint}
                  keyboardType="phone-pad"
                  autoFocus
                  style={{
                    flex: 1,
                    backgroundColor: colors.glassFieldBg,
                    borderWidth: 1,
                    borderColor: colors.glassBorderStrong,
                    borderRadius: radii.tileSm,
                    paddingHorizontal: 13,
                    paddingVertical: 13,
                    fontSize: 15,
                    fontFamily: 'WorkSans-Regular',
                    color: colors.ink,
                    letterSpacing: 1,
                  }}
                />
              </View>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              {/* OTP boxes with a hidden capture field over them */}
              <Pressable onPress={() => otpRef.current?.focus()}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {Array.from({ length: OTP_LEN }).map((_, i) => {
                    const filled = i < code.length;
                    const active = i === code.length;
                    return (
                      <View
                        key={i}
                        style={{
                          flex: 1,
                          height: 56,
                          borderRadius: radii.cardSm,
                          backgroundColor: colors.glassFieldBg,
                          borderWidth: active || filled ? 1.5 : 1,
                          borderColor:
                            active || filled ? colors.primaryGreenDark : colors.glassBorderStrong,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}>
                        <Txt weight="semibold" size={22} color={colors.ink}>
                          {code[i] ?? ''}
                        </Txt>
                      </View>
                    );
                  })}
                </View>
                <TextInput
                  ref={otpRef}
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, OTP_LEN))}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="sms-otp"
                  maxLength={OTP_LEN}
                  caretHidden
                  style={{ position: 'absolute', width: '100%', height: 56, opacity: 0 }}
                />
              </Pressable>

              <Pressable onPress={resend} disabled={seconds > 0} hitSlop={8} style={{ alignSelf: 'center' }}>
                <Txt
                  weight="semibold"
                  size={13}
                  color={seconds > 0 ? colors.muted : colors.statusGreen}>
                  {seconds > 0
                    ? `Resend code in 0:${String(seconds).padStart(2, '0')}`
                    : 'Resend code'}
                </Txt>
              </Pressable>
              {developmentCode && (
                <Txt size={12} color={colors.muted} center>
                  Lower environment code: {developmentCode}
                </Txt>
              )}
            </View>
          )}
          {error && (
            <Txt size={12.5} color={colors.destructive} center lh={18}>
              {error}
            </Txt>
          )}
        </View>

        <View style={{ flex: 1 }} />

        {/* Action */}
        <View style={{ gap: 12, marginTop: 24, marginBottom: 8 }}>
          {step === 'phone' ? (
            <PrimaryButton
              label="Send code"
              disabled={!canSend}
              loading={loading}
              onPress={() => void sendCode()}
            />
          ) : (
            <PrimaryButton
              label="Verify & continue"
              disabled={!canVerify}
              loading={loading}
              onPress={() => void verify()}
            />
          )}
          {step === 'phone' && (
            <Txt size={11.5} color={colors.muted} center lh={16}>
              By continuing you agree to receive a one-time verification SMS.
            </Txt>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
