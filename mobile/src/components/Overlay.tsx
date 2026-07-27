import React, { useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  Animated,
  View,
  StyleSheet,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { colors } from '../theme/theme';

type Props = {
  visible: boolean;
  onRequestClose?: () => void;
  scrim?: string;
  /** where the content sits */
  align?: 'center' | 'bottom' | 'top';
  /** tapping the scrim triggers onRequestClose */
  dismissOnBackdrop?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

/**
 * Scrim + animated content wrapper used by dialogs, the sync flow, the event
 * sheet and the notifications panel. Centered dialogs fade+scale in; bottom /
 * top panels slide.
 */
export default function Overlay({
  visible,
  onRequestClose,
  scrim = colors.scrimDialog,
  align = 'center',
  dismissOnBackdrop = true,
  contentStyle,
  children,
}: Props) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  const justify =
    align === 'center' ? 'center' : align === 'bottom' ? 'flex-end' : 'flex-start';
  // Centered dialogs hug their fixed-width card; bottom/top panels span the width.
  const alignItems = align === 'center' ? 'center' : 'stretch';

  const translateY =
    align === 'bottom'
      ? anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] })
      : align === 'top'
      ? anim.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] })
      : anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  const scale =
    align === 'center'
      ? anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] })
      : 1;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onRequestClose}
      statusBarTranslucent>
      <Animated.View style={[styles.scrim, { backgroundColor: scrim, opacity: anim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissOnBackdrop ? onRequestClose : undefined}
        />
        <View style={[styles.wrap, { justifyContent: justify, alignItems }]} pointerEvents="box-none">
          <Animated.View
            style={[{ opacity: anim, transform: [{ translateY }, { scale }] }, contentStyle]}>
            {children}
          </Animated.View>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  wrap: { flex: 1 },
});
