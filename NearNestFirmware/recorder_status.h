#pragma once

#include <stdint.h>

namespace recorder_status {

enum class State { WaitingToStart, Recording, Stopped, Error };
enum class Feedback { None, Saved, Started, Restart, Sleep, Pairing, Off };

inline uint32_t feedbackDuration(Feedback feedback) {
  switch (feedback) {
    case Feedback::Saved: return 500;
    case Feedback::Started: return 600;
    case Feedback::Restart:
    case Feedback::Sleep:
    case Feedback::Pairing: return 900;
    default: return 0;
  }
}

inline uint32_t feedbackColor(Feedback feedback, uint32_t elapsed) {
  switch (feedback) {
    case Feedback::Saved: return 0x002000;  // Solid green: final WAV saved.
    case Feedback::Started: return elapsed % 300 < 150 ? 0x002000 : 0;
    case Feedback::Restart: return elapsed % 300 < 150 ? 0x202020 : 0;
    case Feedback::Sleep: return elapsed % 300 < 150 ? 0x100020 : 0;
    case Feedback::Pairing: return elapsed % 300 < 150 ? 0x000020 : 0;
    default: return 0;
  }
}

// Illustrative 1-cell, 4.2 V Li-ion/LiPo curve. Tune against the actual cell;
// voltage under recording load/charging is not a fuel-gauge measurement.
inline int batteryPercent(float volts) {
  if (!(volts >= 2.5f && volts <= 4.35f)) return -1;
  const float voltage[] = {3.30f, 3.50f, 3.60f, 3.70f, 3.75f, 3.80f, 3.90f, 4.00f, 4.10f, 4.20f};
  const int percent[] = {0, 5, 10, 20, 35, 50, 70, 85, 95, 100};
  if (volts <= voltage[0]) return 0;
  for (unsigned i = 1; i < sizeof(voltage) / sizeof(voltage[0]); ++i) {
    if (volts <= voltage[i]) {
      return percent[i - 1] + static_cast<int>(
          (volts - voltage[i - 1]) / (voltage[i] - voltage[i - 1]) *
          (percent[i] - percent[i - 1]) + 0.5f);
    }
  }
  return 100;
}

inline bool lowBattery(int percent, bool wasLow) {
  return percent >= 0 && (wasLow ? percent < 20 : percent <= 15);
}

// Return RGB, with all colours intentionally dim for battery operation.
inline uint32_t indicatorColor(State state, uint32_t now, bool saving,
                               bool gpsNotice, bool batteryLow,
                               Feedback feedback = Feedback::None,
                               uint32_t feedbackElapsed = 0, bool sleepArmed = false) {
  if (state == State::Error) return now % 400 < 200 ? 0x200000 : 0x020000;
  if (saving) return 0x201000;
  if (feedback != Feedback::None) return feedbackColor(feedback, feedbackElapsed);
  if (sleepArmed) return 0x100020;
  if (batteryLow && now % 5000 < 600)
    return now % 200 < 100 ? 0x200020 : 0x020002;
  if (gpsNotice) return now % 300 < 150 ? 0x002020 : 0x000202;
  if (state == State::Stopped) return 0x002000;
  if (state == State::WaitingToStart) return 0x000020;
  // Healthy recording pulses green; red is reserved for the error state.
  return now % 1000 < 500 ? 0x002000 : 0x000400;
}

}  // namespace recorder_status
