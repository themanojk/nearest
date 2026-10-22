#include "../mp3_encoder.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
int main(int argc, char **argv) {
  assert(argc == 4);
  FILE *in = fopen(argv[1], "rb"), *out = fopen(argv[2], "wb");
  assert(in && out);
  assert(shine_encoder_state_size() < 30000);
  shine_config_t unsupported = {};
  shine_set_config_mpeg_defaults(&unsupported.mpeg);
  unsupported.wave.channels = PCM_STEREO;
  unsupported.wave.samplerate = 16000;
  unsupported.mpeg.mode = STEREO;
  unsupported.mpeg.bitr = 64;
  assert(shine_initialise(&unsupported) == nullptr);
  unsupported.wave.channels = PCM_MONO;
  unsupported.mpeg.mode = MONO;
  unsupported.wave.samplerate = 44100;
  assert(shine_initialise(&unsupported) == nullptr);
  nest_mp3::Encoder encoder;
  assert(encoder.begin());
  int16_t samples[512];
  const size_t chunk = atoi(argv[3]);
  assert(chunk > 0 && chunk <= 512);
  auto drain = [&]() {
    // Deliberately consume tiny pieces to exercise partial-write retention.
    while (encoder.available()) {
      size_t n = encoder.available() < 17 ? encoder.available() : 17;
      assert(fwrite(encoder.data(), 1, n, out) == n);
      encoder.consume(n);
    }
  };
  size_t count;
  while ((count = fread(samples, sizeof(int16_t), chunk, in))) {
    assert(encoder.push(samples, count));
    drain();
  }
  assert(encoder.finish());
  drain();
  assert(encoder.finish()); // repeated stop must not append duplicate frames
  assert(encoder.available() == 0);
  fclose(in); fclose(out);
  assert(encoder.begin()); // next recording resets filter state and buffers
}
