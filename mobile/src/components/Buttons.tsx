import React from 'react';
import {
  Pressable,
  View,
  ViewStyle,
  StyleProp,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { colors, gradients, radii, shadows } from '../theme/theme';
import Txt from './Txt';

type Common = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  fontSize?: number;
};

/** Primary gradient CTA. Darkens toward #2F6E48 on press. */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  style,
  fontSize = 15,
  loading,
  radius = radii.button,
  paddingVertical = 15,
  withShadow = true,
}: Common & {
  loading?: boolean;
  radius?: number;
  paddingVertical?: number;
  withShadow?: boolean;
}) {
  if (disabled) {
    return (
      <View
        style={[
          {
            borderRadius: radius,
            paddingVertical,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.primaryDisabledBg,
          },
          style,
        ]}>
        <Txt weight="semibold" size={fontSize} color={colors.muted}>
          {label}
        </Txt>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        withShadow && shadows.button,
        style,
        { borderRadius: radius, overflow: 'hidden' },
      ]}>
      {({ pressed }) => (
        <>
          {/* Gradient as a background layer — hosting Text directly inside
              LinearGradient drops the children on the new architecture. */}
          <LinearGradient
            colors={pressed ? ['#2F6E48', '#255B3A'] : gradients.primaryButton.colors}
            start={gradients.primaryButton.start}
            end={gradients.primaryButton.end}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={{
              paddingVertical,
              paddingHorizontal: 18,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
            }}>
            {loading && (
              <ActivityIndicator color={colors.white} size="small" style={{ marginRight: 8 }} />
            )}
            <Txt weight="semibold" size={fontSize} color={colors.white}>
              {label}
            </Txt>
          </View>
        </>
      )}
    </Pressable>
  );
}

/** Ghost / text button (no border) — faint tint on press. */
export function GhostButton({
  label,
  onPress,
  style,
  color = colors.body,
  fontSize = 14,
}: Common & { color?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: radii.dialogButton,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? colors.outlineTint : 'transparent',
        },
        style,
      ]}>
      <Txt weight="semibold" size={fontSize} color={color}>
        {label}
      </Txt>
    </Pressable>
  );
}

/** Outline button — configurable border color, faint tint on press. */
export function OutlineButton({
  label,
  onPress,
  style,
  color = colors.body,
  borderColor = colors.destructiveBorder,
  fontSize = 14,
}: Common & { color?: string; borderColor?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 13,
          paddingHorizontal: 16,
          borderRadius: radii.button,
          borderWidth: 1,
          borderColor,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? colors.outlineTint : 'transparent',
        },
        style,
      ]}>
      <Txt weight="semibold" size={fontSize} color={color}>
        {label}
      </Txt>
    </Pressable>
  );
}
