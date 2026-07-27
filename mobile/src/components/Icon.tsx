import React from 'react';
import Svg, { Path, Circle, Line, Polyline } from 'react-native-svg';
import { colors } from '../theme/theme';

export type IconName =
  | 'bell'
  | 'watch'
  | 'mic'
  | 'file'
  | 'logout'
  | 'shield'
  | 'chevronLeft'
  | 'chevronRight'
  | 'check'
  | 'x'
  | 'alert'
  | 'refresh'
  | 'battery'
  | 'hardDrive';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

/**
 * Lucide outline icons (stroke-width 2–2.2). The bell / watch / mic / file /
 * logout / shield paths are lifted verbatim from the prototype; the rest are
 * standard Lucide paths for icons the handoff calls for.
 */
export default function Icon({
  name,
  size = 24,
  color = colors.primaryGreenDark,
  strokeWidth = 2,
}: Props) {
  const common = {
    stroke: color,
    strokeWidth,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'bell' && (
        <>
          <Path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" {...common} />
          <Path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" {...common} />
        </>
      )}
      {name === 'watch' && (
        <>
          <Circle cx={12} cy={12} r={6} {...common} />
          <Path d="M12 10v2l1.5 1.5" {...common} />
          <Path d="M16.51 17.35 17 22l-5-1-5 1 .49-4.65" {...common} />
          <Path d="M7.5 4.27 7 2l5 1 5-1-.5 2.27" {...common} />
        </>
      )}
      {name === 'mic' && (
        <>
          <Path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" {...common} />
          <Path d="M19 10v1a7 7 0 0 1-14 0v-1" {...common} />
          <Line x1={12} x2={12} y1={18} y2={22} {...common} />
        </>
      )}
      {name === 'file' && (
        <>
          <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...common} />
          <Path d="M14 2v6h6" {...common} />
        </>
      )}
      {name === 'logout' && (
        <>
          <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...common} />
          <Polyline points="16 17 21 12 16 7" {...common} />
          <Line x1={21} x2={9} y1={12} y2={12} {...common} />
        </>
      )}
      {name === 'shield' && (
        <Path
          d="M20 13c0 5-3.5 7.5-7.5 9-4-1.5-7.5-4-7.5-9V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C15.5 3.8 18 5 20 5a1 1 0 0 1 1 1Z"
          {...common}
        />
      )}
      {name === 'chevronLeft' && <Path d="m15 18-6-6 6-6" {...common} />}
      {name === 'chevronRight' && <Path d="m9 18 6-6-6-6" {...common} />}
      {name === 'check' && <Path d="M20 6 9 17l-5-5" {...common} />}
      {name === 'x' && (
        <>
          <Path d="M18 6 6 18" {...common} />
          <Path d="m6 6 12 12" {...common} />
        </>
      )}
      {name === 'alert' && (
        <>
          <Path
            d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
            {...common}
          />
          <Path d="M12 9v4" {...common} />
          <Path d="M12 17h.01" {...common} />
        </>
      )}
      {name === 'refresh' && (
        <>
          <Path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" {...common} />
          <Path d="M21 3v5h-5" {...common} />
          <Path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" {...common} />
          <Path d="M8 16H3v5" {...common} />
        </>
      )}
      {name === 'battery' && (
        <>
          <Path
            d="M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"
            {...common}
          />
          <Line x1={22} x2={22} y1={11} y2={13} {...common} />
          <Line x1={6} x2={6} y1={7} y2={17} {...common} />
        </>
      )}
      {name === 'hardDrive' && (
        <>
          <Line x1={22} x2={2} y1={12} y2={12} {...common} />
          <Path
            d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
            {...common}
          />
          <Line x1={6} x2={6.01} y1={16} y2={16} {...common} />
          <Line x1={10} x2={10.01} y1={16} y2={16} {...common} />
        </>
      )}
    </Svg>
  );
}
