"""Exercise the actual firmware header gate with an in-memory SD file."""
from pathlib import Path
import os
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'NearNestConnectivity.cpp').read_text()
start = source.index('bool hasRecordingHeader(File &file) {')
function = source[start:source.index('\nString recordingIdForFileName', start)]
harness = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <vector>
#include <cstdio>
struct File {
  std::vector<uint8_t> bytes;
  size_t pos = 0;
  bool directory = false, readable = true;
  explicit File(size_t n) : bytes(n) {}
  operator bool() const { return true; }
  bool isDirectory() const { return directory; }
  size_t size() const { return bytes.size(); }
  size_t position() const { return pos; }
  bool seek(size_t n) { pos = n; return n <= size(); }
  size_t read(uint8_t* out, size_t n) {
    if (!readable || pos + n > size()) return 0;
    memcpy(out, bytes.data() + pos, n); pos += n; return n;
  }
};
'''
harness += function
harness += r'''
int main() {
  File wav(100); memcpy(wav.bytes.data(), "RIFFxxxxWAVE", 12);
  wav.seek(23); assert(hasRecordingHeader(wav)); assert(wav.position() == 23);
  File flac(100); memcpy(flac.bytes.data(), "fLaC", 4);
  flac.bytes[4] = 0x80; flac.bytes[7] = 34;
  flac.seek(19); assert(hasRecordingHeader(flac)); assert(flac.position() == 19);
  flac.bytes[4] = 0; assert(hasRecordingHeader(flac)); // More metadata allowed.
  flac.bytes[7] = 33; assert(!hasRecordingHeader(flac));
  flac.bytes[7] = 34; flac.bytes[4] = 1; assert(!hasRecordingHeader(flac));
  flac.bytes[4] = 0x80; flac.bytes.resize(42); assert(!hasRecordingHeader(flac));
  wav.bytes.resize(44); assert(!hasRecordingHeader(wav));
  File mp3(288); mp3.bytes[0] = 0xff; mp3.bytes[1] = 0xf3;
  mp3.bytes[2] = 0x88; mp3.bytes[3] = 0xc0; // MPEG-2, 64 kbps, 16 kHz mono
  mp3.seek(19); assert(hasRecordingHeader(mp3)); assert(mp3.position() == 19);
  mp3.bytes.resize(287); assert(!hasRecordingHeader(mp3));
  mp3.bytes.resize(288); mp3.bytes[2] = 0xf8; assert(!hasRecordingHeader(mp3));
  mp3.bytes[2] = 0x8c; assert(!hasRecordingHeader(mp3));
  mp3.bytes[2] = 0x88; mp3.bytes[1] = 0xeb; assert(!hasRecordingHeader(mp3));
  File invalid(100); assert(!hasRecordingHeader(invalid));
  wav.bytes.resize(100); wav.directory = true; assert(!hasRecordingHeader(wav));
  wav.directory = false; wav.readable = false; assert(!hasRecordingHeader(wav));
  puts("Recording header checks passed: WAV, FLAC, MP3, invalid, empty, unreadable");
}
'''
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(harness)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++11', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
