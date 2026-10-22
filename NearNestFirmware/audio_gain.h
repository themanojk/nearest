#pragma once
#include <stdint.h>

namespace nest_audio {
// Linear gain for quiet speech, smoothly reduced gain above the knee.
// Bounded integer arithmetic avoids overflow/wraparound at full-scale input.
inline int16_t amplify(int16_t sample, unsigned gainPercent) {
  const int32_t signedValue = sample;
  const uint32_t magnitude = signedValue < 0 ? -signedValue : signedValue;
  const uint32_t gain = gainPercent > 800 ? 800 : gainPercent;
  uint32_t output = magnitude * gain / 100;
  constexpr uint32_t knee = 24576;
  constexpr uint32_t headroom = 32767 - knee;
  if (output > knee) {
    const uint32_t excess = output - knee;
    output = knee + static_cast<uint32_t>(
        static_cast<uint64_t>(excess) * headroom / (excess + headroom));
  }
  return static_cast<int16_t>(signedValue < 0 ? -static_cast<int32_t>(output) : output);
}
}
