import React from 'react';
import { View } from 'react-native';
import { colors, radii, shadows } from '../theme/theme';
import { DEVICE_DEFAULTS } from '../state/seed';
import { useStore } from '../state/store';
import Overlay from '../components/Overlay';
import Glass from '../components/Glass';
import Txt from '../components/Txt';
import Icon from '../components/Icon';
import { PrimaryButton, GhostButton } from '../components/Buttons';

const CARD_W = 320;

function DialogCard({ children }: { children: React.ReactNode }) {
  return (
    <Glass
      variant="modal"
      radius={radii.card}
      style={{ width: CARD_W, maxWidth: '90%', padding: 22, gap: 12, ...shadows.dialog }}>
      {children}
    </Glass>
  );
}

/** Confirm dialog: title + body, right-aligned Cancel (ghost) + primary confirm. */
function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay visible={visible} onRequestClose={onCancel}>
      <DialogCard>
        <Txt weight="serif" size={19} color={colors.ink}>
          {title}
        </Txt>
        <Txt size={13} color={colors.body} lh={19}>
          {body}
        </Txt>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <GhostButton label="Cancel" onPress={onCancel} />
          <PrimaryButton
            label={confirmLabel}
            onPress={onConfirm}
            paddingVertical={11}
            radius={radii.dialogButton}
            withShadow={false}
            style={{ paddingHorizontal: 4 }}
          />
        </View>
      </DialogCard>
    </Overlay>
  );
}

export default function Dialogs() {
  const { state, patch, logout } = useStore();

  return (
    <>
      <ConfirmDialog
        visible={state.showUnpairConfirm}
        title="Unpair device?"
        body="This removes the device from your account. Recordings already synced remain in your reports."
        confirmLabel="Unpair"
        onCancel={() => patch({ showUnpairConfirm: false })}
        onConfirm={() => patch({ showUnpairConfirm: false })}
      />

      <ConfirmDialog
        visible={state.showLogoutConfirm}
        title="Log out?"
        body="Reports stay in your account. You'll need to sign in again to sync or review them."
        confirmLabel="Log out"
        onCancel={() => patch({ showLogoutConfirm: false })}
        onConfirm={logout}
      />

      {/* Firmware status dialog */}
      <Overlay
        visible={state.showFirmwareDialog}
        dismissOnBackdrop={false}
        onRequestClose={() => patch({ showFirmwareDialog: false, firmwareState: null })}>
        <DialogCard>
          {state.firmwareState === 'uptodate' ? (
            <View style={{ gap: 12 }}>
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
                <Icon name="check" size={26} strokeWidth={2.4} />
              </View>
              <Txt weight="serif" size={19} color={colors.ink}>
                Firmware {DEVICE_DEFAULTS.firmware} is up to date
              </Txt>
              <Txt size={13} color={colors.body} lh={19}>
                Your device is running the latest release. We'll notify you when a new one is
                available.
              </Txt>
              <PrimaryButton
                label="Done"
                onPress={() => patch({ showFirmwareDialog: false, firmwareState: null })}
                paddingVertical={13}
                style={{ marginTop: 2 }}
              />
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              <Txt weight="serif" size={19} color={colors.ink}>
                Checking for updates…
              </Txt>
              <Txt size={13} color={colors.body} lh={19}>
                Contacting the device over Bluetooth.
              </Txt>
            </View>
          )}
        </DialogCard>
      </Overlay>
    </>
  );
}
