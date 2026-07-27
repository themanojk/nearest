/**
 * NearNest — parent mobile app.
 * A React Native (bare) recreation of design_handoff_nearnest_app.
 */
import React from 'react';
import { StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import GradientShell from './src/components/GradientShell';
import { StoreProvider, useStore } from './src/state/store';
import OnboardingFlow from './src/screens/onboarding/OnboardingFlow';
import AppShell from './src/screens/app/AppShell';

function Root() {
  const { state } = useStore();
  return (
    <View style={{ flex: 1 }}>
      <GradientShell variant="deep" />
      {state.phase === 'onboarding' ? <OnboardingFlow /> : <AppShell />}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />
      <StoreProvider>
        <Root />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
