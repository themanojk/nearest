import React from 'react';
import { Pressable } from 'react-native';
import { colors, radii } from '../theme/theme';
import { severityTimeColor } from '../theme/severity';
import { SafetyEvent } from '../state/types';
import Glass from './Glass';
import Txt from './Txt';

/**
 * Event card as it appears on Today and in a report detail. The meta line shows
 * "{time}" on Today and "{time} · {confidence}" inside a report.
 */
export default function EventRow({
  event,
  showConfidence,
  onPress,
}: {
  event: SafetyEvent;
  showConfidence?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <Glass
          variant="soft"
          radius={radii.cardSm}
          style={{
            paddingVertical: 12,
            paddingHorizontal: 14,
            gap: 4,
            opacity: pressed ? 0.85 : 1,
          }}>
          <Txt weight="medium" size={11} color={severityTimeColor[event.severity]}>
            {showConfidence ? `${event.time} · ${event.confidence}` : event.time}
          </Txt>
          <Txt weight="semibold" size={14} color={colors.ink} lh={19}>
            {event.title}
          </Txt>
        </Glass>
      )}
    </Pressable>
  );
}
