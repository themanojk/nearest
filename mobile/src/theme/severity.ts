import { colors, Severity } from './theme';

/** Event-severity badge mapping (handoff §12). */
export const severityMap: Record<Severity, { label: string; bg: string; color: string }> = {
  high: { label: 'High review', bg: colors.highReviewBg, color: colors.highReviewText },
  review: { label: 'Review', bg: colors.reviewBadgeBg, color: colors.warnDeep },
  info: { label: 'Informational', bg: colors.infoBadgeBg, color: colors.body },
};

/** Colour for the event time line, by severity. */
export const severityTimeColor: Record<Severity, string> = {
  high: colors.highReviewText,
  review: colors.warnText,
  info: colors.statusGreen,
};
