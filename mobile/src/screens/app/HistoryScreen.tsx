import React from 'react';
import { ScrollView } from 'react-native';
import HomeInsights from '../../components/HomeInsights';
import { useStore } from '../../state/store';
import { spacing } from '../../theme/theme';

export default function HistoryScreen() {
  const { state } = useStore();
  return <ScrollView contentContainerStyle={{ padding: spacing.gutter, paddingTop: 8, gap: 14 }}>
    <HomeInsights refreshKey={0} paused={state.syncStage !== null} history />
  </ScrollView>;
}
