import React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { colors, radii, shadows } from '../theme/theme';

type Props = {
  variant?: 'strong' | 'soft' | 'field' | 'modal';
  radius?: number;
  shadow?: 'card' | 'smallTile' | 'none';
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/**
 * Glass surface. `backdrop-filter` blur isn't reliably available in RN, so per
 * the handoff we use a flat translucent fill with the same border — the border
 * carries the edge definition and must not be dropped.
 */
export default function Glass({
  variant = 'strong',
  radius = radii.card,
  shadow = 'none',
  style,
  children,
}: Props) {
  const bg =
    variant === 'strong'
      ? colors.glassStrong
      : variant === 'modal'
      ? colors.modalSurface
      : variant === 'field'
      ? colors.glassFieldBg
      : colors.glassSoft;
  const border =
    variant === 'field' || variant === 'modal'
      ? colors.glassBorderStrong
      : colors.glassBorder;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderColor: border,
          borderWidth: 1,
          borderRadius: radius,
        },
        shadow !== 'none' && shadows[shadow],
        style,
      ]}>
      {children}
    </View>
  );
}
