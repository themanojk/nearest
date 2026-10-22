#include "../recorder_control.h"
#include <cassert>
#include <cstdio>
#include <string>

using recorder_control::Action;
using recorder_control::Button;

struct Rig {
  Button button;
  uint32_t base;
  explicit Rig(uint32_t origin = 0) : base(origin) {
    button.reset(base, false);
    assert(at(40, false) == Action::None);
  }
  Action at(uint32_t elapsed, bool pressed) { return button.update(base + elapsed, pressed); }
  void firstClick() {
    assert(at(100, true) == Action::None);
    assert(at(140, true) == Action::None);
    assert(at(200, false) == Action::None);
    assert(at(240, false) == Action::None);
  }
};

struct Recorder {
  std::string calls;
  bool saveOk = true, feedbackOk = true, startOk = true;
  bool save() { calls += "save "; return saveOk; }
  bool saved() { calls += "green "; return feedbackOk; }
  bool start() { calls += "start "; return startOk; }
  void started() { calls += "started "; }
  bool restart() { calls += "restart "; return true; }
  bool sleep() { calls += "sleep "; return true; }
  bool pairing() { calls += "pairing "; return true; }
};

int main() {
  for (uint32_t base : {0u, 0xfffffe00u}) {
    Button b;
    b.reset(base, false);
    b.update(base + 40, false);
    b.update(base + 100, true);
    b.update(base + 140, true);
    assert(b.update(base + 5139, true) == Action::None);
    assert(b.update(base + 5140, true) == Action::Sleep);
    assert(b.update(base + 9000, true) == Action::None);
    assert(b.update(base + 9100, false) == Action::None);
    assert(b.update(base + 9140, false) == Action::None);
    assert(b.update(base + 9500, false) == Action::None);
  }

  // Single presses are delayed so a double press cannot create an extra file.
  for (uint32_t base : {0u, 0xfffffe00u}) {
    Rig r(base);
    r.firstClick();
    assert(r.at(589, false) == Action::None);
    assert(r.at(590, false) == Action::NewRecording);
    assert(r.at(2000, false) == Action::None);
  }
  {
    Rig r;
    r.firstClick();
    assert(r.at(400, true) == Action::None);
    assert(r.at(440, true) == Action::None);
    assert(r.at(600, true) == Action::None);  // Still no single while held.
    assert(r.at(650, false) == Action::None);
    assert(r.at(690, false) == Action::Restart);
    assert(r.at(1200, false) == Action::None);
  }
  {
    Rig r;
    r.firstClick();
    assert(r.at(580, true) == Action::None);  // Edge just before deadline.
    assert(r.at(600, true) == Action::None);  // Debounce crosses deadline.
    assert(r.at(620, true) == Action::None);
    assert(r.at(680, false) == Action::None);
    assert(r.at(720, false) == Action::Restart);
  }
  {
    Rig r;
    for (uint32_t t = 100; t < 130; t += 5) assert(r.at(t, t % 10 == 0) == Action::None);
    assert(r.at(160, false) == Action::None);
    assert(r.at(800, false) == Action::None);
  }
  for (uint32_t base : {0u, 0xfffffe00u}) {
    Rig r(base);
    assert(r.at(100, true) == Action::None);
    assert(r.at(140, true) == Action::None);
    assert(r.at(3139, true) == Action::None);
    assert(!r.button.sleepArmed());
    assert(r.at(3140, true) == Action::None);
    assert(r.button.sleepArmed());
    assert(r.at(4000, true) == Action::None);  // Never pairing while held.
    assert(r.at(4100, false) == Action::None);
    assert(r.at(4140, false) == Action::Pairing);
    assert(!r.button.sleepArmed());
    assert(r.at(7000, false) == Action::None);
  }
  {
    Rig r;
    r.firstClick();
    r.at(400, true);
    r.at(440, true);
    assert(r.at(3440, true) == Action::None);
    assert(r.button.sleepArmed());
    r.at(3500, false);
    assert(r.at(3540, false) == Action::Pairing); // Hold overrides double click.
  }
  {
    Button b;
    b.reset(0, true); // Wake/reset while the button is still held.
    assert(b.update(5000, true) == Action::None);
    assert(!b.sleepArmed());
    b.update(5100, false);
    assert(b.update(5140, false) == Action::None);
    assert(b.update(6000, false) == Action::None);
    b.update(6100, true);
    b.update(6140, true);
    b.update(6200, false);
    b.update(6240, false);
    assert(b.update(6590, false) == Action::NewRecording);
  }
  // Save failure must never create a new recording, show success or power down.
  for (Action action : {Action::NewRecording, Action::Restart, Action::Pairing, Action::Sleep}) {
    Recorder r;
    r.saveOk = false;
    assert(!recorder_control::execute(action, r));
    assert(r.calls == "save ");
    r.calls.clear();
    r.saveOk = true;
    r.feedbackOk = false;
    assert(!recorder_control::execute(action, r));
    assert(r.calls == "save green ");
  }
  {
    Recorder r;
    assert(recorder_control::execute(Action::NewRecording, r));
    assert(r.calls == "save green start started ");
    r.calls.clear();
    assert(recorder_control::execute(Action::Restart, r));
    assert(r.calls == "save green restart ");
    r.calls.clear();
    assert(recorder_control::execute(Action::Pairing, r));
    assert(r.calls == "save green pairing ");
    r.calls.clear();
    r.startOk = false;
    assert(!recorder_control::execute(Action::NewRecording, r));
    assert(r.calls == "save green start ");
  }
  puts("Recorder button gestures and save-before-action tests passed");
}
