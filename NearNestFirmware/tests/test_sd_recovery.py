"""Host fault-injection checks against the firmware's actual recovery function."""
from pathlib import Path
import os
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'NearNestFirmware.ino').read_text()
start = source.index('bool recoverRecorderStorage() {')
recovery = source[start:source.index('\nvoid failRecorder(', start)]
harness = r'''
#include <cassert>
#include <string>
#include <cstdio>
using uint32_t = unsigned int;
struct RecorderLock {};
struct Path { bool isEmpty() { return false; } } gRecordingPath;
struct File { operator bool() { return true; } void close() {} } gRecordingFile;
struct Card { void end() {} } SD;
struct Logger { void println(const char*) {} } Serial;
bool gSdRecoveryPending, gTransferStorageActive, gSdReady;
uint32_t gLastSdRecoveryMs;
bool lockOk, mountOk, finalizeOk, startOk;
int locks, unlocks, mounts, finalizes, starts;
uint32_t millis() { return 10000; }
int pdMS_TO_TICKS(int n) { return n; }
void delay(int) {}
bool lockSd(int) { ++locks; return lockOk; }
void unlockSd() { ++unlocks; }
bool setupSdCard() { ++mounts; return mountOk; }
bool finalizeRecordingFile() { ++finalizes; return finalizeOk; }
bool startRecording() {
  ++starts;
  if (startOk) gSdRecoveryPending = false;
  return startOk;
}
void reset() {
  gSdRecoveryPending = gTransferStorageActive = gSdReady = false;
  lockOk = mountOk = finalizeOk = startOk = true;
  locks = unlocks = mounts = finalizes = starts = 0;
}
'''
harness += recovery
harness += r'''
int main() {
  reset(); gTransferStorageActive = true;
  assert(!recoverRecorderStorage());
  assert(gSdRecoveryPending && locks == 0 && mounts == 0);
  reset(); lockOk = false;
  assert(!recoverRecorderStorage());
  assert(gSdRecoveryPending && mounts == 0 && unlocks == 0);
  reset(); mountOk = false;
  assert(!recoverRecorderStorage());
  assert(gSdRecoveryPending && !gSdReady && starts == 0 && finalizes == 0 && unlocks == 1);
  reset(); startOk = false;
  assert(!recoverRecorderStorage());
  assert(gSdRecoveryPending && starts == 1 && unlocks == 1);
  reset(); finalizeOk = false;
  assert(recoverRecorderStorage());
  assert(!gSdRecoveryPending && finalizes == 1 && starts == 1 && unlocks == 1);
  reset();
  assert(recoverRecorderStorage());
  assert(!gSdRecoveryPending && gSdReady && gLastSdRecoveryMs == 10000);
  assert(mounts == 1 && finalizes == 1 && starts == 1 && unlocks == 1);
  puts("SD recovery fault-injection checks passed");
}
'''
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(harness)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++11', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
