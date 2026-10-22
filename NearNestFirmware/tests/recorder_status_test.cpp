#include "../recorder_status.h"
#include <cassert>
#include <limits>
#include <cstdio>
#include <initializer_list>

int main() {
  using namespace recorder_status;
  assert(batteryPercent(0) == -1);
  assert(batteryPercent(2.49f) == -1);
  assert(batteryPercent(4.36f) == -1);
  assert(batteryPercent(std::numeric_limits<float>::quiet_NaN()) == -1);
  assert(batteryPercent(3.3f) == 0);
  assert(batteryPercent(4.2f) == 100);
  assert(batteryPercent(3.8f) == 50);
  assert(batteryPercent(3.85f) == 60);
  int previous = 0;
  for (int mv = 2500; mv <= 4350; ++mv) {
    const int percent = batteryPercent(mv / 1000.0f);
    assert(percent >= previous && percent <= 100);
    previous = percent;
  }
  assert(lowBattery(15, false));
  assert(!lowBattery(16, false));
  assert(lowBattery(19, true));
  assert(!lowBattery(20, true));
  assert(!lowBattery(-1, true));
  assert(indicatorColor(State::WaitingToStart, 0, false, false, false) == 0x000020);
  assert(indicatorColor(State::Recording, 0, false, false, false) == 0x002000);
  assert(indicatorColor(State::Recording, 700, false, false, false) == 0x000400);
  assert(indicatorColor(State::Stopped, 700, false, false, false) == 0x002000);
  // A fatal error must win over saving, GPS, and battery notices.
  assert(indicatorColor(State::Error, 0, true, true, true) == 0x200000);
  assert(indicatorColor(State::Error, 250, true, true, true) == 0x020000);
  // Saving wins over lower-priority notifications and the stopped state.
  assert(indicatorColor(State::Stopped, 0, true, true, true) == 0x201000);
  assert(indicatorColor(State::Recording, 0, false, true, true) == 0x200020);
  assert(indicatorColor(State::Recording, 900, false, true, true) == 0x002020);
  assert(indicatorColor(State::Recording, 1700, false, false, true) == 0x000400);
  assert(indicatorColor(State::Recording, 0xffffffff, false, false, false) != 0);
  assert(feedbackColor(Feedback::Saved, 0) == 0x002000);
  assert(feedbackColor(Feedback::Started, 0) == 0x002000);
  assert(feedbackColor(Feedback::Started, 150) == 0);
  assert(feedbackColor(Feedback::Started, 300) == 0x002000);
  assert(feedbackDuration(Feedback::Started) == 600);
  assert(feedbackDuration(Feedback::Restart) == 900);
  for (uint32_t t : {0u, 300u, 600u}) {
    assert(feedbackColor(Feedback::Restart, t) == 0x202020);
    assert(feedbackColor(Feedback::Sleep, t) == 0x100020);
    assert(feedbackColor(Feedback::Restart, t + 150) == 0);
    assert(feedbackColor(Feedback::Sleep, t + 150) == 0);
  }
  // Faults/saving cannot be hidden by a button success or sleep indication.
  assert(indicatorColor(State::Error, 0, false, false, false, Feedback::Saved) == 0x200000);
  assert(indicatorColor(State::Stopped, 0, true, false, false, Feedback::Restart) == 0x201000);
  assert(indicatorColor(State::Stopped, 0, false, true, true, Feedback::Restart) == 0x202020);
  assert(indicatorColor(State::Stopped, 0, false, false, true, Feedback::Off) == 0);
  assert(indicatorColor(State::Recording, 0, false, true, true, Feedback::None, 0, true) == 0x100020);
  puts("Recorder status and battery tests passed");
}
