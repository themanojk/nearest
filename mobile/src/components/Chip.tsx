import React from 'react';
import { View, ViewStyle } from 'react-native';
import { radii } from '../theme/theme';
import Txt from './Txt';

/** Small status pill / badge. */
export default function Chip({
  label,
  bg,
  color,
  size = 11,
  weight = 'semibold',
  radius = radii.chip,
  style,
}: {
  label: string;
  bg: string;
  color: string;
  size?: number;
  weight?: 'semibold' | 'bold' | 'medium';
  radius?: number;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: radius,
          paddingHorizontal: 10,
          paddingVertical: 4,
          alignSelf: 'flex-start',
        },
        style,
      ]}>
      <Txt weight={weight} size={size} color={color}>
        {label}
      </Txt>
    </View>
  );
}
