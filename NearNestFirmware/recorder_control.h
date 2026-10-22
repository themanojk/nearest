#pragma once
#include <stdint.h>

namespace recorder_control {
enum class Action { None, NewRecording, Restart, Pairing, Sleep };

// Active-low button input is converted to `pressed` by the hardware task.
// Clicks/pairing wait for release; sleep fires at five seconds while held.
class Button {
 public:
  static constexpr uint32_t DebounceMs = 35;
  static constexpr uint32_t DoublePressMs = 350;
  static constexpr uint32_t HoldMs = 3000;
  static constexpr uint32_t SleepMs = 5000;

  void reset(uint32_t now, bool pressed) {
    raw_ = stable_ = pressed;
    changed_ = pressedAt_ = now;
    ready_ = false;  // Boot/wake/busy presses must first be released.
    pending_ = second_ = armed_ = false;
  }

  bool sleepArmed() const { return armed_; }

  Action update(uint32_t now, bool pressed) {
    if (pressed != raw_) { raw_ = pressed; changed_ = now; }
    if (!ready_) {
      if (!raw_ && now - changed_ >= DebounceMs) {
        ready_ = true;
        stable_ = false;
      }
      return Action::None;
    }
    if (raw_ != stable_ && now - changed_ >= DebounceMs) {
      stable_ = raw_;
      if (stable_) {
        pressedAt_ = now;
        armed_ = false;
        second_ = pending_ && changed_ - releasedAt_ <= DoublePressMs;
        // If this press came too late, honour the previous single first.
        if (pending_ && !second_) {
          pending_ = false;
          return Action::NewRecording;
        }
      } else {
        if (changed_ - pressedAt_ >= SleepMs) {
          reset(now, false);
          return Action::Sleep;
        }
        if (armed_ || changed_ - pressedAt_ >= HoldMs) {
          pending_ = second_ = armed_ = false;
          return Action::Pairing;
        }
        if (second_) {
          pending_ = second_ = false;
          return Action::Restart;
        }
        releasedAt_ = now;
        pending_ = true;
      }
    }
    if (stable_ && raw_ && now - pressedAt_ >= SleepMs) {
      reset(now, true); // Emit once while held; release must precede another action.
      return Action::Sleep;
    }
    if (stable_ && raw_ && now - pressedAt_ >= HoldMs) {
      armed_ = true;
      pending_ = false;
    }
    // Wait through a second press (including its debounce period).
    if (pending_ && !stable_ && !raw_ && now - releasedAt_ >= DoublePressMs) {
      pending_ = false;
      return Action::NewRecording;
    }
    return Action::None;
  }

 private:
  bool raw_ = false, stable_ = false, ready_ = false;
  bool pending_ = false, second_ = false, armed_ = false;
  uint32_t changed_ = 0, pressedAt_ = 0, releasedAt_ = 0;
};

// Tested ordering: no success indication, new file, restart or pairing on save failure.
template <typename Recorder>
bool execute(Action action, Recorder &recorder) {
  if (action == Action::None) return true;
  if (!recorder.save()) return false;
  if (!recorder.saved()) return false;
  if (action == Action::NewRecording) {
    if (!recorder.start()) return false;
    recorder.started();
    return true;
  }
    if (action == Action::Restart) return recorder.restart();
    if (action == Action::Sleep) return recorder.sleep();
    return recorder.pairing();
}
}  // namespace recorder_control
