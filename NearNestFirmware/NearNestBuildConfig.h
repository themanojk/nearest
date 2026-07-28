#pragma once

// Development-only transfer testing.
//
// 1: acknowledge recording.release but keep the WAV on the SD card so the
//    same recording can be uploaded again during the next sync.
// 0: production behavior; delete the WAV after backend multipart completion.
#define NEARNEST_RETAIN_RECORDINGS_AFTER_RELEASE 1

// Battery telemetry requires the battery divider output to be wired to an ADC
// pin. Leave this at -1 until the hardware pin is known; the app then displays
// battery as unavailable instead of showing a fabricated percentage.
#define NEARNEST_BATTERY_ADC_PIN -1
#define NEARNEST_BATTERY_DIVIDER_RATIO 2.0f
#define NEARNEST_BATTERY_EMPTY_MV 3300
#define NEARNEST_BATTERY_FULL_MV 4200
