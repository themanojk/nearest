import React from 'react';
import { View } from 'react-native';
import { colors } from '../../theme/theme';

/** 7-dot onboarding progress indicator (handoff §1). */
export default function ProgressDots({ step }: { step: number }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 16 }}>
      {Array.from({ length: 7 }).map((_, i) => {
        const active = i === step;
        return (
          <View
            key={i}
            style={{
              height: 6,
              width: active ? 18 : 6,
              borderRadius: 6,
              backgroundColor: active ? colors.primaryGreenDark : 'rgba(61,122,84,0.2)',
            }}
          />
        );
      })}
    </View>
  );
}
