# NearNest — parent mobile app

A bare **React Native** (non-Expo) recreation of the NearNest parent app from
`design_handoff_nearnest_app/README.md`. Bare RN (not Expo) is a hard
requirement: the app talks to an **ESP wearable over BLE + Wi-Fi**, which needs
native modules Expo Go can't host.

This package is intentionally **outside** the monorepo's npm workspaces to avoid
Metro/workspace hoisting problems.

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

## ESP device integration

`src/services/transport.ts` defines a single `DeviceTransport` interface with:

- `SimulatedTransport` (**default**) — prototype timings, so the whole app is
  clickable with no hardware.
- `BleWifiTransport` — real integration points (marked `TODO(device)`) for BLE
  pairing/firmware over `react-native-ble-plx` and the transfer→upload pipeline
  (BLE for control, Wi-Fi/HTTP for bulk transfer to the backend presigned URL).

To go live, flip the exported `transport` to `new BleWifiTransport()` and
implement the TODOs. iOS usage strings (`NSBluetoothAlwaysUsageDescription`,
`NSLocalNetworkUsageDescription`) are already in `ios/.../Info.plist`.

Nothing above this layer (sync flow, pairing UI) knows which transport is used.

## Dev tip

`DEV_OVERRIDE` at the top of `src/state/store.tsx` merges over the initial state
to jump straight to any screen for visual work. It must be `{}` when shipping.
