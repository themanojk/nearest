import React, { useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, ScrollView, Share, View } from 'react-native';
import Txt from './Txt';
import { colors } from '../theme/theme';
import { getTransferLogs, subscribeTransferLogs } from '../services/transferLog';

export default function TransferLogs() {
  const lines = useSyncExternalStore(subscribeTransferLogs, getTransferLogs);
  const [expanded, setExpanded] = useState(false);
  if (!lines.length) return null;
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ paddingVertical: 8 }}>
        <Txt size={12} color={colors.primaryGreenDark}>{expanded ? 'Hide logs' : 'Show transfer logs'}</Txt>
      </Pressable>
      <Pressable accessibilityRole="button" style={{ paddingVertical: 8 }} onPress={() => {
        Share.share({ title: 'NearNest transfer diagnostics', message: `NearNest transfer logs (UTC timestamps)\n${lines.join('\n')}` })
          .catch(error => Alert.alert('Could not share logs', String(error)));
      }}><Txt size={12} color={colors.primaryGreenDark}>Share logs</Txt></Pressable>
    </View>
    {expanded ? <ScrollView nestedScrollEnabled style={{ maxHeight: 130 }}>
      <Txt size={10} selectable>{lines.join('\n')}</Txt>
    </ScrollView> : <Txt size={10} numberOfLines={2} color={colors.muted}>{lines[lines.length - 1]}</Txt>}
  </View>;
}
