import React from 'react';
import Svg, { G, Path, Circle } from 'react-native-svg';
import { colors } from '../theme/theme';

/**
 * Three-children line drawing for onboarding step 0. Single-weight strokes,
 * classic line art. Paths lifted verbatim from NearNest Green.dc.html.
 */
export default function ChildrenIllustration({
  width = 250,
  height = 182,
}: {
  width?: number;
  height?: number;
}) {
  return (
    <Svg width={width} height={height} viewBox="0 0 260 190">
      <G
        fill="none"
        stroke={colors.primaryGreenDark}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round">
        {/* left child (cap) */}
        <Circle cx={72} cy={74} r={25} />
        <Path d="M47 72c0-18 11-27 25-27s25 9 25 27" />
        <Circle cx={64} cy={76} r={2.6} fill={colors.primaryGreenDark} stroke="none" />
        <Circle cx={80} cy={76} r={2.6} fill={colors.primaryGreenDark} stroke="none" />
        <Path d="M65 86c4 3.5 10 3.5 14 0" />
        <Path d="M44 152c1-20 12-31 28-31s27 11 28 31" />

        {/* right child */}
        <Circle cx={188} cy={66} r={21} />
        <Path d="M167 62h42" />
        <Path d="M170 62c0-14 8-21 18-21s18 7 18 21" />
        <Circle cx={181} cy={68} r={2.3} fill={colors.primaryGreenDark} stroke="none" />
        <Circle cx={195} cy={68} r={2.3} fill={colors.primaryGreenDark} stroke="none" />
        <Path d="M182 77c3.5 3 9 3 12 0" />
        <Path d="M164 144c1-17 11-26 24-26s23 9 24 26" />

        {/* center child (side bunches) */}
        <Circle cx={130} cy={118} r={23} />
        <Path d="M107 116c0-17 10-26 23-26s23 9 23 26" />
        <Path d="M107 116c-4 10-3 20 0 26M153 116c4 10 3 20 0 26" />
        <Circle cx={122} cy={120} r={2.5} fill={colors.primaryGreenDark} stroke="none" />
        <Circle cx={138} cy={120} r={2.5} fill={colors.primaryGreenDark} stroke="none" />
        <Path d="M123 130c4 3 10 3 14 0" />
        <Path d="M104 186c1-19 11-29 26-29s25 10 26 29" />
      </G>
    </Svg>
  );
}
