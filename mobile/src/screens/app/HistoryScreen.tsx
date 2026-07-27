import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { colors, radii, spacing } from '../../theme/theme';
import { useStore } from '../../state/store';
import { Report } from '../../state/types';
import Glass from '../../components/Glass';
import Txt from '../../components/Txt';
import Chip from '../../components/Chip';
import Icon from '../../components/Icon';
import EventRow from '../../components/EventRow';

function ReviewBadge({ report }: { report: Report }) {
  if (report.reviewCount > 0) {
    return (
      <Chip
        label={`${report.reviewCount} to review`}
        bg={colors.reviewBadgeBg}
        color={colors.warnDeep}
        weight="bold"
        radius={7}
      />
    );
  }
  return (
    <Chip label="All clear" bg={colors.allClearBg} color={colors.statusGreen} weight="bold" radius={7} />
  );
}

function SummaryCard({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  return (
    <Glass variant="soft" radius={radii.cardSm} style={{ padding: 13, gap: 6 }}>
      <Txt weight="bold" size={10.5} color={colors.statusGreen} upper ls={0.4}>
        {kicker}
      </Txt>
      {children}
    </Glass>
  );
}

export default function HistoryScreen() {
  const { state, patch, reports, restoreSample } = useStore();

  // ---- Detail view --------------------------------------------------------
  if (state.historyView === 'detail') {
    const report = reports.find((r) => r.id === state.selectedReportId);
    if (!report) {
      // safety: fall back to the list
      patch({ historyView: 'list' });
      return null;
    }
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 14 }}
        showsVerticalScrollIndicator={false}>
        <Pressable
          onPress={() => patch({ historyView: 'list', selectedReportId: null })}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <Icon name="chevronLeft" size={20} color={colors.ink} />
          <Txt weight="serif" size={19} color={colors.ink}>
            {report.dateLabel}
          </Txt>
        </Pressable>
        <Txt size={12.5} color={colors.muted} style={{ marginTop: -8 }}>
          {report.durationMeta} · {report.quality}
        </Txt>

        <SummaryCard kicker="Environment">
          <Txt size={13} color={colors.body} lh={19}>
            {report.environment}
          </Txt>
        </SummaryCard>
        <SummaryCard kicker="Conversation">
          <Txt size={13} color={colors.body} lh={19}>
            {report.conversation}
          </Txt>
        </SummaryCard>
        <SummaryCard kicker="Health & profanity">
          <Txt size={13} color={colors.body} lh={19}>
            {report.healthNote}
          </Txt>
          <Txt size={13} color={colors.body} lh={19}>
            {report.profanityLine}
          </Txt>
        </SummaryCard>

        <Txt weight="serif" size={16} color={colors.ink} style={{ marginTop: 4 }}>
          Events
        </Txt>
        {report.events.length > 0 ? (
          <View style={{ gap: 10 }}>
            {report.events.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                showConfidence
                onPress={() => patch({ selectedEventId: e.id })}
              />
            ))}
          </View>
        ) : (
          <Glass variant="soft" radius={radii.cardSm} style={{ padding: 14 }}>
            <Txt size={13} color={colors.body} lh={19}>
              No high-review event was identified in the processed audio. The system may still miss
              events.
            </Txt>
          </Glass>
        )}
      </ScrollView>
    );
  }

  // ---- Empty state --------------------------------------------------------
  if (reports.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 12 }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            backgroundColor: colors.glassStrong,
            borderWidth: 1,
            borderColor: colors.glassBorderStrong,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Icon name="file" size={24} color={colors.muted} />
        </View>
        <Txt weight="serif" size={18} color={colors.ink}>
          No reports yet
        </Txt>
        <Txt size={13} color={colors.body} center lh={19} style={{ maxWidth: 260 }}>
          Sync your device from the Today tab to create your first report.
        </Txt>
        <Pressable onPress={restoreSample}>
          <Txt weight="semibold" size={13} color={colors.statusGreen}>
            Restore sample data
          </Txt>
        </Pressable>
      </View>
    );
  }

  // ---- List view ----------------------------------------------------------
  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 10 }}
      showsVerticalScrollIndicator={false}>
      {reports.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => patch({ historyView: 'detail', selectedReportId: r.id })}>
          {({ pressed }) => (
            <Glass
              variant="soft"
              radius={radii.tile}
              style={{ padding: 16, gap: 8, opacity: pressed ? 0.85 : 1 }}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Txt weight="semibold" size={14.5} color={colors.ink}>
                  {r.dateLabel}
                </Txt>
                <ReviewBadge report={r} />
              </View>
              <Txt size={12} color={colors.muted}>
                {r.durationMeta}
              </Txt>
            </Glass>
          )}
        </Pressable>
      ))}
    </ScrollView>
  );
}
