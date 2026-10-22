# Vendored Shine MP3 encoder

Source: https://github.com/toots/shine
Revision: ab5e3526b64af1a2eaa43aa6f441a7312e013519
License: GNU Library General Public License v2; see COPYING.

Arduino compiles this src directory; ESP-IDF lists these sources in main/CMakeLists.txt.
Local changes:
- Check bitstream allocation failure in shine_initialise.
- Compile mono, single-granule buffers only; reject stereo and sample rates
  other than 16 kHz before allocation.
- Store the original 10,000-entry quantization lookup as const uint16_t flash
  data instead of generating a 40,000-byte per-encoder RAM table. Values are
  unchanged; tests/test_shine_memory.py verifies the generation formula.
- Expose shine_encoder_state_size() for heap diagnostics.

The state allocation drops from about 96 KB to 29 KB on the host; target
size is printed before recording. The separate 4096-byte bitstream remains.
NearNest uses only 16000 Hz mono, 64 kbps MPEG-2 Layer III.
