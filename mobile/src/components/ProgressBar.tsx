import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
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
  const animatedProgress = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(animatedProgress, {
      duration: 220,
      toValue: pct,
      useNativeDriver: false,
    }).start();
  }, [animatedProgress, pct]);
  return (
    <View
      style={{
        height,
        borderRadius: radii.progress,
        backgroundColor: colors.track,
        overflow: 'hidden',
      }}>
      <Animated.View
        style={{
          height: '100%',
          width: animatedProgress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', '100%'],
          }),
        }}>
        <LinearGradient
          colors={gradients.progress.colors}
          start={gradients.progress.start}
          end={gradients.progress.end}
          style={{ flex: 1, borderRadius: radii.progress }}
        />
      </Animated.View>
    </View>
  );
}
