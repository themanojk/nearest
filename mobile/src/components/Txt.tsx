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

// The static Work Sans Medium/SemiBold files register under their own family
// names, which the new-architecture text layer does not resolve reliably.
// Route every Work Sans weight through the base "Work Sans" family (proven to
// load) plus an explicit numeric fontWeight instead.
const family: Record<Weight, string> = {
  regular: fonts.regular,
  medium: fonts.regular,
  semibold: fonts.regular,
  bold: fonts.regular,
  serif: fonts.serif,
};

const weightValue: Record<Weight, TextStyle['fontWeight'] | undefined> = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  serif: undefined,
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
    ...(weightValue[weight] ? { fontWeight: weightValue[weight] } : null),
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
