import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';
import { colors } from '../theme/theme';

type Props = {
  size?: number;
  /** show the fainter outer proximity arc (welcome screen only) */
  withOuterArc?: boolean;
  color?: string;
  strokeWidth?: number;
};

/**
 * NearNest brand mark — a nest cradling a child, with proximity arcs above.
 * Paths from design_handoff_nearnest_app/README.md (48×48 box).
 */
export default function BrandMark({
  size = 24,
  withOuterArc = false,
  color = colors.primaryGreenDark,
  strokeWidth = 3,
}: Props) {
  const p = {
    stroke: color,
    strokeWidth,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path d="M8 27c0 8.5 7.2 13 16 13s16-4.5 16-13" {...p} />
      <Path d="M13 25.5c0 6 5 9.5 11 9.5s11-3.5 11-9.5" {...p} />
      <Circle cx={24} cy={21} r={4.2} fill={color} stroke="none" />
      <Path d="M15.5 13.5A12 12 0 0 1 24 10a12 12 0 0 1 8.5 3.5" {...p} />
      {withOuterArc && (
        <Path
          d="M10.5 8.5A18.5 18.5 0 0 1 24 3a18.5 18.5 0 0 1 13.5 5.5"
          {...p}
          opacity={0.45}
        />
      )}
    </Svg>
  );
}
