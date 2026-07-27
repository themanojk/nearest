import React from 'react';
import { View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { colors, gradients, radii } from '../theme/theme';

/** Thin progress / allowance bar. `value` is 0–1. */
export default function ProgressBar({
  value,
  height = 6,
}: {
  value: number;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View
      style={{
        height,
        borderRadius: radii.progress,
        backgroundColor: colors.track,
        overflow: 'hidden',
      }}>
      <LinearGradient
        colors={gradients.progress.colors}
        start={gradients.progress.start}
        end={gradients.progress.end}
        style={{ width: `${pct * 100}%`, height: '100%', borderRadius: radii.progress }}
      />
    </View>
  );
}
