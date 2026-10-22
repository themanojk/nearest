#include "../audio_gain.h"
#include <cassert>
#include <initializer_list>
#include <cstdio>
int main() {
  assert(nest_audio::amplify(0, 400) == 0);
  assert(nest_audio::amplify(1000, 400) == 4000);
  assert(nest_audio::amplify(-1000, 400) == -4000);
  assert(nest_audio::amplify(6144, 400) == 24576);
  for (unsigned gain : {100u, 200u, 400u, 800u}) {
    int previous = -32768;
    for (int input = -32768; input <= 32767; ++input) {
      const int output = nest_audio::amplify(static_cast<int16_t>(input), gain);
      assert(output >= previous && output > -32768 && output <= 32767);
      assert(input == 0 || (input < 0 ? output <= 0 : output >= 0));
      if (input >= 0) assert(output == -nest_audio::amplify(-input, gain));
      previous = output;
    }
  }
  puts("Audio gain: quiet speech boosted; full-range limiter is bounded, monotonic and symmetric");
}
