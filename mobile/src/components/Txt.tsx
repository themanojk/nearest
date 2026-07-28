import React from 'react';
import { Text, TextProps, TextStyle } from 'react-native';
import { colors, fonts } from '../theme/theme';

type Weight = 'regular' | 'medium' | 'semibold' | 'bold' | 'serif';

type Props = TextProps & {
  size?: number;
  color?: string;
  weight?: Weight;
  lh?: number; // line height
  ls?: number; // letter spacing
  center?: boolean;
  upper?: boolean;
  style?: TextStyle | TextStyle[];
};

// Each weight maps to its own real font file (referenced by basename so it
// resolves on both iOS and Android). Because the file already is the right
// weight, do NOT also set fontWeight — on Android that makes it hunt for a
// non-existent "<family>_bold" asset and fall back to the system font.
const family: Record<Weight, string> = {
  regular: fonts.regular,
  medium: fonts.medium,
  semibold: fonts.semibold,
  bold: fonts.bold,
  serif: fonts.serif,
};

/** App text primitive — applies the correct static font family per weight. */
export default function Txt({
  size = 14,
  color = colors.body,
  weight = 'regular',
  lh,
  ls,
  center,
  upper,
  style,
  children,
  ...rest
}: Props) {
  const base: TextStyle = {
    fontFamily: family[weight],
    fontSize: size,
    color,
    ...(lh != null ? { lineHeight: lh } : null),
    ...(ls != null ? { letterSpacing: ls } : null),
    ...(center ? { textAlign: 'center' } : null),
    ...(upper ? { textTransform: 'uppercase' } : null),
  };
  return (
    <Text style={[base, style]} {...rest}>
      {children}
    </Text>
  );
}
