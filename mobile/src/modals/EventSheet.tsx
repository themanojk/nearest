import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, shadows } from '../theme/theme';
import { severityMap } from '../theme/severity';
import { useStore } from '../state/store';
import { SafetyEvent, Verdict } from '../state/types';
import Overlay from '../components/Overlay';
import Glass from '../components/Glass';
import Chip from '../components/Chip';
import Txt from '../components/Txt';
import Icon from '../components/Icon';

const VERDICTS: { key: Verdict; label: string }[] = [
  { key: 'useful', label: 'Useful' },
  { key: 'incorrect', label: 'Incorrect' },
  { key: 'notsure', label: 'Not sure' },
];

function Block({ kicker, body }: { kicker: string; body: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Txt weight="bold" size={10.5} color={colors.statusGreen} upper ls={0.4}>
        {kicker}
      </Txt>
      <Txt size={13} color={colors.body} lh={19}>
        {body}
      </Txt>
    </View>
  );
}

export default function EventSheet() {
  const { state, patch, reports, setFeedback } = useStore();
  const insets = useSafeAreaInsets();

  // find the selected event across all reports
  let event: SafetyEvent | undefined;
  for (const r of reports) {
    const found = r.events.find((e: SafetyEvent) => e.id === state.selectedEventId);
    if (found) {
      event = found;
      break;
    }
  }

  const close = () => patch({ selectedEventId: null });
  const sev = event ? severityMap[event.severity] : null;
  const chosen: Verdict | undefined = event ? state.feedback[event.id] : undefined;

  return (
    <Overlay
      visible={!!event}
      onRequestClose={close}
      scrim={colors.scrimSheet}
      align="bottom">
      {event && sev && (
        <Glass
          variant="modal"
          radius={radii.sheet}
          style={{
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            maxHeight: 640,
            paddingTop: 20,
            paddingHorizontal: 22,
            paddingBottom: 28 + insets.bottom,
            gap: 11,
            ...shadows.dialog,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Chip label={sev.label} bg={sev.bg} color={sev.color} weight="bold" radius={7} />
            <Pressable onPress={close} hitSlop={8}>
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 11 }}>
            <Txt weight="serif" size={19} color={colors.ink} lh={23}>
              {event.title}
            </Txt>
            <View style={{ gap: 2 }}>
              <Txt size={12.5} color={colors.muted}>
                {event.time} · {event.category}
              </Txt>
              <Txt size={12.5} color={colors.muted}>
                {event.confidence}
              </Txt>
            </View>

            <Glass variant="soft" radius={radii.cardSm} style={{ padding: 14, gap: 12 }}>
              <Block kicker="Evidence" body={event.evidence} />
              <Block kicker="Context" body={event.context} />
              <Block kicker="Limitations" body={event.limitations} />
            </Glass>

            {/* Feedback */}
            <Txt weight="semibold" size={13} color={colors.ink} style={{ marginTop: 2 }}>
              Was this useful?
            </Txt>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {VERDICTS.map((v) => {
                const selected = chosen === v.key;
                return (
                  <Pressable
                    key={v.key}
                    onPress={() => setFeedback(event!.id, v.key)}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      paddingVertical: 11,
                      borderRadius: radii.dialogButton,
                      borderWidth: 1,
                      backgroundColor: selected ? colors.tintChipStrong : 'rgba(255,255,255,0.5)',
                      borderColor: selected ? colors.primaryGreenDark : 'rgba(61,122,84,0.25)',
                    }}>
                    <Txt
                      weight="semibold"
                      size={13}
                      color={selected ? colors.primaryGreenDark : colors.ink}>
                      {v.label}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </Glass>
      )}
    </Overlay>
  );
}
