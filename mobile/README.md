# NearNest — parent mobile app

A bare **React Native** (non-Expo) recreation of the NearNest parent app from
`design_handoff_nearnest_app/README.md`. Bare RN (not Expo) is a hard
requirement: the app talks to an **ESP wearable over BLE + Wi-Fi**, which needs
native modules Expo Go can't host.

This package is intentionally **outside** the monorepo's npm workspaces to avoid
Metro/workspace hoisting problems.

Secure hardware pairing separates BLE discovery from backend authorization.
`BleWifiTransport` must return the manufacturer-provisioned serial and
implement `signPairingChallenge`; the wearable signs the exact UTF-8 payload
returned by the backend without exposing its private key. The default
`SimulatedTransport` is UI-only and deliberately cannot produce a trusted
signature.

Bulk recordings never travel over BLE. The app creates a resumable multipart
analysis upload for every finalized recording (MP3, FLAC, or WAV) on the SD card. The ESP creates a
temporary one-client WPA2 hotspot with no internet route; its random password
and request token are delivered over encrypted BLE. Android caches resumable
10 MiB ranges, disconnects from that hotspot, and then uploads the cached parts
through the phone's normal internet connection. Multiple recordings from the
same day are queued separately. Persisted part status is stored server-side per
recording, so retrying continues from missing parts instead of restarting a
large recording. Once every queued recording has reached durable object storage, the
app releases it from SD. The ESP remains idle after boot and after sync until
the parent explicitly selects **Start recording** on the Device screen.

## Requirements

- **Node 22.19.0** (see repo `.nvmrc`; RN 0.86 needs ≥ 20.19). Use `nvm use`.
- Xcode + CocoaPods (Ruby). Ruby 3.4 + CocoaPods needs a UTF-8 locale — export
  `LANG`/`LC_ALL` (see below) or `pod install` fails with an
  `Encoding::CompatibilityError`.
- JDK 17 + Android SDK for Android.

## Setup

```bash
nvm use                      # -> Node 22.19.0
npm install
# fonts are committed + linked; re-run only if you change them:
npx react-native-asset
# iOS pods (note the locale):
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install && cd ..
```

## Run

```bash
npm start                    # Metro
npm run ios                  # build + launch on a booted simulator
npm run android
```

## Architecture

- **Navigation is a state machine**, not react-navigation — this mirrors the
  prototype (top pills, no bottom tab bar, contextual bottom action bar). All
  screen/sub-view/modal routing lives in `src/state/store.tsx`
  (`useReducer` + context). See the handoff's "State Management" table.
- **Modals** (sync flow, event sheet, notifications, dialogs) use RN core
  `Modal` + `Animated` via `src/components/Overlay.tsx`.
- **Design tokens** are in `src/theme/theme.ts` (colors, gradients, spacing,
  radii, shadows, fonts). Primitives: `GradientShell`, `Glass`, `Buttons`,
  `ProgressBar`, `Chip`, `Txt`, `Icon`, `BrandMark`, `ChildrenIllustration`.
- **Glass surfaces** use a flat translucent fill (no `backdrop-filter` blur) with
  the border kept — the documented fallback in the handoff.
- **Fonts**: Instrument Serif + Work Sans static TTFs in `src/assets/fonts`.
  Work Sans weights are applied via `fontWeight` on the base `Work Sans` family
  (the separate `Work Sans Medium`/`SemiBold` family names don't resolve
  reliably under the new architecture).

## Authentication

The mobile app signs in with the backend phone OTP flow. Lower environments use
the fixed OTP `1234`. Access and rotating refresh tokens are stored through
`react-native-keychain`, backed by iOS Keychain and Android Keystore. Sessions
are restored on launch, refreshed once after an unauthorized API response, and
revoked during logout.

The current Android development API URL is `http://192.168.31.188:3000/v1`,
using the laptop's LAN address so a phone connected to the same network can
reach the backend. Keep the phone and laptop on the same Wi-Fi network. A
USB-connected device can instead use ADB port forwarding for both the API and
Metro:

```bash
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
```

A production build must supply a reachable HTTPS API endpoint before release.

## ESP device integration

`src/services/transport.ts` defines a single `DeviceTransport` interface with:

- `BleWifiTransport` (**default**) — BLE discovery, authenticated bonding,
  challenge signing, recording control, and temporary-hotspot credentials over
  `react-native-ble-plx`.
- `SimulatedTransport` — retained only for explicit UI previews and tests.

Android 10+ uses a native Kotlin bridge with `WifiNetworkSpecifier`; Android 7+
uses a legacy WPA2 configuration fallback. iOS uses a
native Swift bridge with `NEHotspotConfigurationManager`. Both platforms stream
file I/O natively, so progress reflects actual bytes. BLE carries control JSON
only.

iOS hotspot joining must be tested on a physical iPhone; the simulator cannot
join Wi-Fi networks. The app target includes the Hotspot Configuration
entitlement, so the Apple App ID and development/distribution provisioning
profiles must also have the **Hotspot Configuration** capability enabled.

The ESP always serves at `http://192.168.4.1` inside its isolated WPA2 network.
The HTTP request is additionally protected by the one-time BLE-delivered token.
Object-storage URLs only need to be reachable by the phone after it returns to
mobile data or its normal Wi-Fi; they are never shared with the ESP.

Nothing above this layer (sync flow, pairing UI) knows which transport is used.

## Dev tip

`DEV_OVERRIDE` at the top of `src/state/store.tsx` merges over the initial state
to jump straight to any screen for visual work. It must be `{}` when shipping.

### Temporary imported-recording debugger

Open **Profile → Imported recordings (debug)** to browse the signed-in account's
server imports across all children. Refresh and Load more cover the complete
catalog, including pending/failed uploads. Each entry provides Play/Stop,
playback position, file size/type, import time, analysis/child IDs, and expandable
pipeline metadata and failure details. Internet access is required for playback.

**Delete audio** permanently deletes the uploaded source object after confirmation;
it retains reports and diagnostic metadata and does not delete wearable SD files.
Deletion is available after upload and processing have stopped.

Restart the updated backend and rebuild the native Android/iOS app for these
controls. Metro reload alone cannot install the new native playback methods.

## Risk review and moment playback

Daily insights show priority, review coverage, recorded time, detected speech,
conversation counts and health-related sound counts from analysis summaries.
Missing metrics display a dash; dates refer to uploads. Model findings are
review prompts, not confirmed events or diagnoses.

Open **Review flagged moments** on a recording for explanations and timed
risk incidents. **Listen to this moment** plays the original recording from
startMs to endMs and stops at the boundary. Invalid timestamps fall back to
full-recording guidance; deleted audio is unavailable. Full playback retains
seeking and speed controls. Native clip support requires rebuilding both
Android/iOS apps. Older builds with the existing seek method use a compatibility
path: start playback, wait for metadata, then seek to the moment. This path may
briefly play the beginning while loading and stops within the UI polling interval
(about 500 ms). Rebuilt apps seek before playback and use native end boundaries.

Android uses prepared/seek-complete callbacks and a 40 ms end check; iOS uses
an exact seek and forwardPlaybackEndTime. Player timing can vary slightly by
codec. Verify on device with MP3 and existing FLAC playback copies, slow
network loading, switching cards, app backgrounding, and deleted recordings.
