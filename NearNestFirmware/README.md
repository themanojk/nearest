# NearNest ESP32 firmware

The firmware records mono MP3 audio to SD, advertises a NearNest BLE control
service, signs pairing challenges with a provisioned Ed25519 identity, receives
a one-time transfer command over authenticated encrypted BLE, and creates an
isolated WPA2 hotspot from which the paired phone reads finalized recording
ranges.

Audio bytes never travel over BLE, and the ESP is never given router
credentials or internet access.

## MP3 recording trial

New recordings default to **16 kHz mono, signed 16-bit PCM input → 64 kbps
MP3**. MP3 describes its compression with bitrate, not a PCM bit depth.
Expect approximately 480 KB/minute or 28.8 MB/hour, plus a small amount of
encoder delay/padding. This is about one-quarter of our 16 kHz/16-bit mono
PCM WAV size; actual transfer time still includes hotspot and upload overhead.

`NearNestBuildConfig.h` selects the format:

- `NEARNEST_RECORD_MP3 1`: MP3 at the settings above.
- MP3 `0`, `NEARNEST_RECORD_FLAC 1`: lossless FLAC.
- Both `0`: PCM WAV.

The encoder uses mono, single-granule buffers and a flash-resident quantization
table, reducing the contiguous state allocation from approximately 96 KB to
29 KB, plus a separate 4 KB bitstream buffer. Before start,
`MP3 memory` prints the required state bytes, free heap and largest heap block.

The pinned Shine source is bundled under `src/shine` with its license and
provenance. No additional Arduino library installation is needed. The encoder
buffers 512-sample I2S chunks into 576-sample MP3 frames, pads/drains the final
frame on stop, and releases encoder memory before transfer. MP3 files have
frame headers, so checkpoints do not rewrite their first bytes. Existing WAV
and FLAC files remain discoverable. New `.mp3` files use `audio/mpeg` and play
directly; the backend's FLAC-to-WAV playback conversion is only for FLAC.

Build with the same ESP32 board and Minimal SPIFFS partition used previously:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=min_spiffs NearNestFirmware
```

Host checks (from the repository root; C/C++ compiler, FFmpeg, ffprobe required):

```bash
python3 NearNestFirmware/tests/test_mp3.py
python3 NearNestFirmware/tests/test_recording_header.py
```

Before relying on this trial, flash the firmware and record speech plus normal
background sounds for several minutes. Stop normally, confirm `.mp3` appears
in Sync, transfer it, play the beginning and end, and check analysis results.
Watch `Recording compression` for stored bytes and encoder time, and `Recorder
alive` for task stack headroom and SD failures. Encoding time must stay below
the captured audio duration with headroom for SD writes. Host tests and a
successful build do not establish real-time performance or battery usage on
the device. Existing SD recordings are not converted by this change.

## Quiet speech gain

`NEARNEST_AUDIO_GAIN_PERCENT` defaults to `400`: a 4x (approximately +12 dB)
boost after microphone cleanup and before encoding. A soft limiter reduces
additional gain above 75% of full scale to prevent hard clipping and integer
wraparound. Use `200` for a smaller boost if close speech sounds compressed.
Gain also raises microphone/background noise; it cannot recover missing detail.
This applies to new recordings in all three formats, without changing MP3
bitrate or file size. Existing SD/cloud files are unchanged.

## SD write recovery

After recording write retries are exhausted, the recorder enters the error
state and retries SD recovery every 10 seconds. It remounts at recording speed,
checks that a probe write succeeds, and attempts to finalize the previous file
before starting a new recording. Existing recordings are not deleted or
formatted. The failed file may have an incomplete tail; audio during the outage
is lost. A full, damaged, or disconnected card still needs attention.

In the error state, a single button press retries recovery immediately, a double
press restarts, and a five-second hold sleeps. The pairing gesture and a phone
stop request cancel automatic recovery. Recovery waits while transfer storage
mode is active. Watch for `SD recovery: recording resumed in a new file`.

To validate on hardware, interrupt SD writes on a test card, restore access,
and verify a new file starts and can be decoded. Also test each button action
while the card remains unavailable; restart and sleep must still work.

## Arduino requirements

- Espressif ESP32 board package `3.2.1`
- ArduinoJson `7.4.2`
- NimBLE-Arduino `2.3.2`
- TinyGPSPlus `1.0.3`
- Adafruit NeoPixel `1.12.x` (for the single-pin RGB status LED on GPIO 21)
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
- `recording.start` to explicitly begin a fresh monotonic recording
- `recordings.next` with `afterFileName` to page through every finalized recording
- `recording.manifest` with an optional stable `recordingId`
- `transfer.ap.start`
- `transfer.ap.stop`
- `recording.release` after backend multipart completion

The production build sets
`NEARNEST_RETAIN_RECORDINGS_AFTER_RELEASE` to `0`, so the recording is deleted after
the app confirms backend multipart completion. Keep it at `1` only for deliberate
transfer benchmarks; the app also remembers completed stable recording IDs and
will not queue retained test files again.

Battery telemetry uses GPIO32 (ADC1 channel 4) through a 100kΩ/100kΩ
voltage divider, matching the old audio recorder. It uses the legacy ADC driver
to remain compatible with legacy I2S. Set `NEARNEST_BATTERY_ADC_PIN` in
`NearNestBuildConfig.h` to `-1` to report battery as unavailable when the divider
is not fitted. The divider ratio and empty/full millivolt calibration values
live beside it.

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

Each recording transfer also prints `UDP send diagnostics`: firmware compile
date/time, configured channel, socket-call time (`send_ms`, `max_send_us`),
actual retry sleep time (`retry_wait_ms`), errno category counts, first/last errno,
and maximum consecutive failures. `failed_datagrams` counts retried send attempts,
not confirmed receiver packet loss. Compare these with the app's repair metrics.
The pipeline now uses two sector-aligned 5632-byte buffers, freeing 11264 bytes
compared with the previous pipeline. On socket allocation pressure, the sender
backs off one scheduler tick and enables adaptive pacing every eight packets
(up to four ticks), relaxing it after 128 clean sends. `UDP memory pacing` reports
these waits and the largest allocatable heap block. Measure complete-file speed
and receiver repair counts before treating this as a demonstrated speed gain. The inner send loop now
honors the 120-second range deadline and stops after five seconds without send
progress; an incomplete range retains `result=interrupted` and remaining bytes.


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

- Upload is rejected until recording has stopped and the recording is
  finalized.
- The recorder boots idle and remains idle after sync. Recording begins only
  after the paired app sends `recording.start`.

## Physical button and status LED

The firmware also supports local control without BLE:

- Push button: GPIO 27, wired between the pin and GND (`INPUT_PULLUP`).
- Addressable RGB/WS2812 LED: data input on GPIO 21.
- Single press: save the current recording and start a new file (or start when idle).
- Double press within 350 ms: save and restart the ESP32.
- Hold for 3 to less than 5 seconds and release: save and enter BLE pairing mode. Violet indicates
  that the hold has been recognized; this action does not enter deep sleep.
- Hold for 5 seconds: automatically save, flash violet three times, turn the LED
  off, and enter deep sleep without waiting for release. Saving and the indication
  finish before sleep. Release briefly wakes only to re-arm the wake input; the
  next GPIO 27 press boots the device idle. A save failure cancels sleep.
- Button debounce is 35 ms. Boot and busy presses must be released before another action.
- No buzzer is used; GPIO 22 is no longer driven by the sketch.

The WS2812 matches the reference recorder's patterns: pulsing green while recording,
solid green when stopped, amber during recording saves/checkpoints, fast red on errors,
and cyan flashes for 1.5 seconds on the first GPS location fix. A successful save
shows green for 500 ms; a new recording flashes green twice; restart flashes white
three times; pairing flashes blue three times. Save failure cancels the button action.
The LED and button each run in their own task so SD operations do not freeze feedback
or button sampling. Battery warning flashes are not enabled without a configured
battery measurement source. Boot remains idle, and a single button press or the app
can start recording.

- Every finalized recording on SD is exposed as a separate queue item. Stable
  `sd-<filename>` IDs survive ESP resets, and the phone uploads all items
  sequentially while server analysis can proceed in parallel.
- Recording filenames use an NVS-backed monotonic sequence, so deleting an
  uploaded recording never causes its identity to be reused for a later recording.
- Each filename also contains a random token, and the stable recording ID is
  derived from the complete filename. This prevents an old app sync record from
  matching a new recording even if the SD card is cleared or the sequence is
  reset.
- The hotspot accepts one phone, uses new credentials for each session, has no
  upstream route, and is shut down before cloud upload begins.
- Every range request is token-authenticated and seeks to the exact SD byte
  range requested by the phone.
- SD access is mutex-protected for the complete range read.
- Each recording remains on SD until an explicit `recording.release` for that
  stable ID. Production firmware then removes it; transfer-test firmware
  acknowledges the release while retaining it for another benchmark.

Transfer startup uses fixed Wi-Fi channel 6 to skip the channel scan. Set
`NEARNEST_TRANSFER_WIFI_CHANNEL` to `0` in `NearNestBuildConfig.h` to restore
automatic selection, or choose 1/6/11 for the local environment.
