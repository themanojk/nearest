#pragma once

// Development-only transfer testing.
//
// 1: acknowledge recording.release but keep the recording on the SD card so the
//    file remains on SD (the app still hides completed uploads).
// 0: production behavior; delete the recording after backend multipart completion.
#define NEARNEST_RETAIN_RECORDINGS_AFTER_RELEASE 0

// Battery divider: 100k ohm from battery to GPIO32, 100k ohm to ground.
// Set to -1 to disable battery telemetry when the divider is not fitted.
#define NEARNEST_BATTERY_ADC_PIN 32
#define NEARNEST_BATTERY_DIVIDER_RATIO 2.0f
#define NEARNEST_BATTERY_EMPTY_MV 3300
#define NEARNEST_BATTERY_FULL_MV 4200

// Fixed channel avoids a full Wi-Fi scan during handoff. 0 enables auto-scan.
// Channel 6 was consistently least congested in this device's transfer logs.
#define NEARNEST_TRANSFER_WIFI_CHANNEL 6

// New recordings: 16 kHz / 16-bit mono input, 64 kbps MP3 output.
// Disable MP3 to select FLAC (1) or PCM WAV (0) below.
#define NEARNEST_RECORD_MP3 1
#define NEARNEST_RECORD_FLAC 0

// Gain after microphone cleanup, before MP3/FLAC/WAV encoding.
// 400 = 4x (+12 dB) for quiet speech; supported range 100..800.
#define NEARNEST_AUDIO_GAIN_PERCENT 400
