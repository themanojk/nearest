# NearNest ESP32 firmware

The firmware records mono WAV audio to SD, advertises a NearNest BLE control
service, signs pairing challenges with a provisioned Ed25519 identity, receives
a one-time transfer command over authenticated encrypted BLE, and creates an
isolated WPA2 hotspot from which the paired phone reads finalized recording
ranges.

Audio bytes never travel over BLE, and the ESP is never given router
credentials or internet access.

## Arduino requirements

- Espressif ESP32 board package `3.2.1`
- ArduinoJson `7.4.2`
- NimBLE-Arduino `2.3.2`
- TinyGPSPlus `1.0.3`
- Crypto `0.4.0` with `Ed25519.h`

For a standard 4 MB ESP32, select the **Minimal SPIFFS (1.9 MB APP with
OTA/190 KB SPIFFS)** partition. The firmware currently uses about 1.39 MB of
program storage and 58 KB of static RAM with these versions.

## Manufacture and provision an identity

Generate a unique identity and firmware header:

```bash
npm run device:identity --workspace backend -- NN-000001 rev-a 2.4.0
```

This creates:

- `NearNestFirmware/device_secrets.h`, containing the per-device private seed.
  It is ignored by Git and created with owner-only permissions.
- `NearNestFirmware/NN-000001.public.pem`, containing the public identity key.

Register only the public key:

```bash
MONGODB_URI=mongodb://localhost:57017/kid_audio \
  npm run device:provision --workspace backend -- \
  NN-000001 NearNestFirmware/NN-000001.public.pem rev-a 2.4.0
```

Production devices must enable ESP32 secure boot and flash encryption, or keep
the private identity in a supported secure element. Never ship the placeholder
keys from `device_secrets.example.h`.

## BLE contract

Service UUID: `8ec90001-f315-4f60-9fb8-838830daea50`

| Characteristic | UUID suffix | Access |
| --- | --- | --- |
| Identity | `0002` | Read |
| Command | `0003` | Encrypted/authenticated write |
| Status | `0004` | Encrypted/authenticated read + notify |

The identity value contains `serialNumber`, `hardwareRevision`,
`firmwareVersion`, a two-digit `pairingCodeHint`, and `identityReady`. BLE uses
Secure Connections, MITM protection, bonding, and a random six-digit passkey
printed on the device/packaging label. The full passkey is never advertised.

Commands use framed UTF-8 JSON. Write `BEGIN:<byte-length>` first, then send
raw JSON bytes in MTU-sized writes until the declared length is reached.

Supported operations:

- `pair.challenge` with the exact backend `payload`
- `wifi.configure` is retained only as a compatibility command; it clears any
  legacy stored router credentials
- `recording.stop`
- `recording.status`
- `device.telemetry` for battery percentage and SD used/total bytes
- `recording.start` to explicitly begin a fresh monotonic WAV
- `recordings.next` with `afterFileName` to page through every finalized WAV
- `recording.manifest` with an optional stable `recordingId`
- `transfer.ap.start`
- `transfer.ap.stop`
- `recording.release` after backend multipart completion

For repeatable upload-speed tests,
`NearNestBuildConfig.h` currently sets
`NEARNEST_RETAIN_RECORDINGS_AFTER_RELEASE` to `1`. In this mode,
`recording.release` is acknowledged but the WAV remains on the SD card, so a
later sync uploads it again as a new backend analysis. Set the flag to `0`
before building production firmware.

Battery telemetry is reported as unavailable until
`NEARNEST_BATTERY_ADC_PIN` in `NearNestBuildConfig.h` is set to the ADC pin
wired to the battery voltage divider. The divider ratio and empty/full
millivolt calibration values live beside it.

`transfer.ap.start` returns the random `ssid`, WPA2 `password`, local
`baseUrl`, and request `token` over the encrypted BLE status characteristic.
The phone reads at most 10 MiB at a time. Android starts with
`GET /v1/recording/udp?recordingId=...&offsetBytes=...&lengthBytes=...&port=...`.
Each UDP packet carries a session ID, sequence number, length, and CRC32.
After the end marker, the app repairs only missing or corrupt runs from
`GET /v1/recording?recordingId=...&offsetBytes=...&lengthBytes=...`, with the
token in `X-NearNest-Transfer-Token`. iOS currently uses the resumable TCP
range endpoint directly.

## Transfer performance

Short physical-device trials use fresh 10 MiB ranges rather than waiting for a
complete 388 MiB recording. On the current ESP32 and SPI-wired SD card:

| Measurement | Observed result |
| --- | --- |
| UDP RAM/network benchmark | Approximately 2.3–2.6 MiB/s |
| Original recording path | Approximately 0.74 MiB/s |
| Optimized recording path | Approximately 1.2–1.39 MiB/s |
| Packet integrity in measured runs | Zero missing/corrupt packets |

The recording path now uses:

- fingerprint-validated high-speed SD transfer mode with safe fallback;
- direct FAT reads into two sector-aligned buffers;
- a high-priority SD reader on CPU 1 and UDP/socket work on CPU 0;
- ESP ROM CRC32;
- sequence-based Android reassembly with TCP repair;
- explicit C++ allocation cleanup before FreeRTOS task deletion; and
- periodic blocking yields so the idle task can service the watchdog.

The SPI SD path remains below the required minimum of 1.5 MiB/s even though
the Wi-Fi link has sufficient capacity. Meeting that target requires rewiring
the SD card to the ESP32 SDMMC peripheral:

| SD signal | ESP32 GPIO | Required in 1-bit mode |
| --- | --- | --- |
| CLK | 14 | Yes |
| CMD | 15 | Yes |
| DAT0 | 2 | Yes |
| DAT1 | 4 | No |
| DAT2 | 12 | No |
| DAT3 | 13 | No |

Use four-bit mode when the socket exposes DAT1 and DAT2. CMD and the connected
DAT lines require suitable pull-ups. The current source and flashed test
firmware still use SPI; do not enable SDMMC until the wiring has changed.

## Transfer safety

- Upload is rejected until recording has stopped and the WAV header is
  finalized.
- The recorder boots idle and remains idle after sync. Recording begins only
  after the paired app sends `recording.start`.
- Every finalized WAV on SD is exposed as a separate queue item. Stable
  `sd-<filename>` IDs survive ESP resets, and the phone uploads all items
  sequentially while server analysis can proceed in parallel.
- Recording filenames use an NVS-backed monotonic sequence, so deleting an
  uploaded WAV never causes its identity to be reused for a later recording.
- The hotspot accepts one phone, uses new credentials for each session, has no
  upstream route, and is shut down before cloud upload begins.
- Every range request is token-authenticated and seeks to the exact SD byte
  range requested by the phone.
- SD access is mutex-protected for the complete range read.
- Each recording remains on SD until an explicit `recording.release` for that
  stable ID. Production firmware then removes it; transfer-test firmware
  acknowledges the release while retaining it for another benchmark.
