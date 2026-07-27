import React from 'react';
import { StyleSheet } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { gradients } from '../theme/theme';

/** Full-screen app background gradient (deep default / soft variant). */
export default function GradientShell({
  variant = 'deep',
  children,
}: {
  variant?: 'deep' | 'soft';
  children?: React.ReactNode;
}) {
  const g = variant === 'soft' ? gradients.shellSoft : gradients.shellDeep;
  return (
    <LinearGradient
      colors={g.colors}
      locations={g.locations as number[]}
      start={g.start}
      end={g.end}
      style={StyleSheet.absoluteFill}>
      {children}
    </LinearGradient>
  );
}
