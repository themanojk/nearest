#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
extern "C" {
#include "src/shine/layer3.h"
}

namespace nest_mp3 {
// 576 PCM samples per MPEG-2 frame; 288 encoded bytes at 16 kHz / 64 kbps.
// Buffer arbitrary I2S chunks and retain output until the SD writer consumes it.
class Encoder {
 public:
  ~Encoder() { close(); }
  bool begin() {
    close();
    used_ = length_ = offset_ = 0;
    finished_ = false;
    hadSamples_ = false;
    shine_config_t config = {};
    shine_set_config_mpeg_defaults(&config.mpeg);
    config.wave.channels = PCM_MONO;
    config.wave.samplerate = 16000;
    config.mpeg.mode = MONO;
    config.mpeg.bitr = 64;
    encoder_ = shine_initialise(&config);
    if (!encoder_) return false;
    if (shine_samples_per_pass(encoder_) != 576) { close(); return false; }
    return true;
  }
  bool push(const int16_t *samples, size_t count) {
    if (!encoder_ || finished_ || available() || count > 512) return false;
    length_ = offset_ = 0;
    hadSamples_ = hadSamples_ || count > 0;
    while (count) {
      const size_t take = count < 576 - used_ ? count : 576 - used_;
      memcpy(pcm_ + used_, samples, take * sizeof(int16_t));
      used_ += take; samples += take; count -= take;
      if (used_ == 576 && !frame()) return false;
    }
    return true;
  }
  bool finish() {
    if (finished_) return true;
    if (!encoder_ || available()) return false;
    length_ = offset_ = 0;
    if (hadSamples_) {
      if (used_) {
        memset(pcm_ + used_, 0, (576 - used_) * sizeof(int16_t));
        if (!frame()) return false;
      }
      // Drain the filterbank/MDCT delay, including when input ends on a frame
      // boundary. MP3 has a small leading delay and trailing silence, not a
      // sample-exact WAV duration; no audio samples are dropped at stop.
      memset(pcm_, 0, sizeof(pcm_));
      if (!frame() || !frame()) return false;
    }
    int bytes = 0;
    const uint8_t *tail = shine_flush(encoder_, &bytes);
    if (!append(tail, bytes)) return false;
    close(); // Release encoder heap before Wi-Fi transfer starts.
    finished_ = true;
    return true;
  }
  const uint8_t *data() const { return output_ + offset_; }
  size_t available() const { return length_ - offset_; }
  void consume(size_t bytes) { offset_ += bytes <= available() ? bytes : available(); }
  void close() { if (encoder_) shine_close(encoder_); encoder_ = nullptr; }
 private:
  bool append(const uint8_t *data, int bytes) {
    if (bytes < 0 || static_cast<size_t>(bytes) > sizeof(output_) - length_ || (bytes && !data)) return false;
    if (bytes) memcpy(output_ + length_, data, bytes);
    length_ += bytes;
    return true;
  }
  bool frame() {
    int bytes = 0;
    const uint8_t *data = shine_encode_buffer_interleaved(encoder_, pcm_, &bytes);
    used_ = 0;
    return append(data, bytes);
  }
  shine_t encoder_ = nullptr;
  int16_t pcm_[576] = {};
  uint8_t output_[1152] = {};
  size_t used_ = 0, length_ = 0, offset_ = 0;
  bool finished_ = true, hadSamples_ = false;
};
}
