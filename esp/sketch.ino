#include <Arduino.h>
#include <HardwareSerial.h>
#include <SPI.h>
#include <SD.h>
#include <TinyGPSPlus.h>
#include <time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#if !defined(ARDUINO_ARCH_ESP32)
#error "This sketch requires an ESP32 board package and an ESP32-family board selection in Arduino IDE."
#endif

#if __has_include(<driver/i2s.h>)
#include <driver/i2s.h>
#else
#error "ESP32 I2S driver header not found. Install/update Espressif 'esp32' boards package and select an ESP32-family board."
#endif

namespace {

constexpr uint32_t kSampleRate = 16000;
constexpr uint8_t kBitsPerSample = 16;
constexpr size_t kSamplesPerChunk = 512;
constexpr uint32_t kStartupDelayMs = 0;
constexpr uint32_t kRecordingHeartbeatMs = 0;
constexpr uint32_t kRecordingProgressLogIntervalMs = 10000;
constexpr uint32_t kHeaderSyncIntervalMs = 5000;
constexpr uint32_t kMaxRecordingSeconds = 0;  // 0 = record until reset/power off
constexpr uint32_t kProblemIndicatorIntervalMs = 5000;
constexpr uint32_t kSdWriteLockTimeoutMs = 3000;
constexpr uint8_t kSdWriteRetryCount = 8;
constexpr uint32_t kSdWriteRetryDelayMs = 30;
constexpr bool kBuzzerEnabled = true;
constexpr bool kBuzzerActiveHigh = true;
constexpr bool kBuzzerReleasePinWhenIdle = false;
constexpr bool kAudioCleanupEnabled = true;
constexpr float kAudioHighPassAlpha = 0.992f;
constexpr float kAudioLowPassAlpha = 0.22f;
constexpr int16_t kAudioNoiseGateThreshold = 70;
constexpr int16_t kAudioNoiseFloorGainPercent = 80;
constexpr uint8_t kAudioPostScalePercent = 90;

constexpr gpio_num_t kI2sBclkPin = GPIO_NUM_26;
constexpr gpio_num_t kI2sWsPin = GPIO_NUM_25;
constexpr gpio_num_t kI2sDataInPin = GPIO_NUM_33;¯

constexpr int kSdCsPin = 5;
constexpr int kSdSckPin = 18;
constexpr int kSdMisoPin = 19;
constexpr int kSdMosiPin = 23;
constexpr uint32_t kSdSpiFrequency = 4000000;

constexpr int kBuzzerPin = 22;
constexpr int kGpsRxPin = 16;
constexpr int kGpsTxPin = 17;
constexpr uint32_t kGpsBaudRates[] = {9600, 38400, 115200, 57600};
constexpr size_t kGpsBaudRateCount = sizeof(kGpsBaudRates) / sizeof(kGpsBaudRates[0]);
constexpr uint32_t kGpsLogIntervalMs = 2000;
constexpr uint32_t kGpsPersistIntervalMs = 120000;
constexpr uint32_t kGpsNoDataLogIntervalMs = 2000;
constexpr uint32_t kGpsBaudScanIntervalMs = 2000;
constexpr uint8_t kGpsFixBeepCount = 5;
constexpr uint16_t kGpsFixBeepOnMs = 70;
constexpr uint16_t kGpsFixBeepOffMs = 90;

constexpr char kRecordingDir[] = "/";
constexpr char kIndexFile[] = "/index.csv";
constexpr char kGpsStatusFile[] = "/gps_status.txt";
constexpr char kRecordingMetaFile[] = "/recording_meta.txt";
constexpr char kGpsHistoryFile[] = "/gps_history.csv";

enum class RecorderState {
  WaitingToStart,
  Recording,
  Stopped,
  Error,
};

struct WavHeader {
  char riff[4];
  uint32_t chunkSize;
  char wave[4];
  char fmt[4];
  uint32_t subchunk1Size;
  uint16_t audioFormat;
  uint16_t numChannels;
  uint32_t sampleRate;
  uint32_t byteRate;
  uint16_t blockAlign;
  uint16_t bitsPerSample;
  char data[4];
  uint32_t subchunk2Size;
};

RecorderState gState = RecorderState::WaitingToStart;
SPIClass gSdSpi(VSPI);
HardwareSerial gGpsSerial(1);
TinyGPSPlus gTinyGps;
TinyGPSCustom gGpsFixQualityGngga(gTinyGps, "GNGGA", 6);
TinyGPSCustom gGpsFixQualityGpgga(gTinyGps, "GPGGA", 6);
TinyGPSCustom gGpsFixTypeGngsa(gTinyGps, "GNGSA", 2);
TinyGPSCustom gGpsFixTypeGpgsa(gTinyGps, "GPGSA", 2);
TinyGPSCustom gGpsFixTypeBdgsa(gTinyGps, "BDGSA", 2);
TinyGPSCustom gGpsSatViewGngsv(gTinyGps, "GNGSV", 3);
TinyGPSCustom gGpsSatViewGpgsv(gTinyGps, "GPGSV", 3);
TinyGPSCustom gGpsSatViewBdgsv(gTinyGps, "BDGSV", 3);
TinyGPSCustom gGpsRmcStatusGnrmc(gTinyGps, "GNRMC", 2);
TinyGPSCustom gGpsRmcStatusGprmc(gTinyGps, "GPRMC", 2);
File gRecordingFile;
String gRecordingPath;
TaskHandle_t gRecordingTaskHandle = nullptr;
SemaphoreHandle_t gSdMutex = nullptr;
uint32_t gRecordingDataBytes = 0;
uint32_t gRecordingStartMs = 0;
uint32_t gLastHeaderSyncMs = 0;
uint32_t gLastHeartbeatMs = 0;
uint32_t gLastGpsLogMs = 0;
uint32_t gLastGpsPersistMs = 0;
uint32_t gLastGpsByteMs = 0;
uint32_t gLastGpsNoDataLogMs = 0;
uint32_t gLastGpsBaudSwitchMs = 0;
uint32_t gLastRecordingProgressLogMs = 0;
uint32_t gGpsBytesSeen = 0;
uint32_t gSdRecoveredWriteEvents = 0;
uint32_t gSdRecoveredWriteAttempts = 0;
uint32_t gSdWriteFailureEvents = 0;
uint32_t gRecordingGpsPointIndex = 0;

bool gBuzzerActive = false;
uint32_t gBuzzerToggleAtMs = 0;
uint8_t gBuzzerPhaseRemaining = 0;
uint16_t gBuzzerOnMs = 0;
uint16_t gBuzzerOffMs = 0;
bool gBuzzerPinLevel = false;
bool gProblemIndicatorEnabled = false;
bool gMicReady = false;
bool gSdReady = false;
bool gGpsReady = false;
bool gGpsHasLocation = false;
bool gGpsHasUtc = false;
bool gGpsLockAnnounced = false;
bool gGpsFixBeepPlayed = false;
bool gRecordingStartUtcResolved = false;
bool gFirstFixMetadataWritten = false;

char gGpsSentenceBuffer[128];
size_t gGpsSentenceLength = 0;
double gGpsLatitude = 0.0;
double gGpsLongitude = 0.0;
double gGpsAltitudeMeters = 0.0;
double gGpsHdop = 0.0;
double gGpsSpeedKnots = 0.0;
double gGpsCourseDegrees = 0.0;
uint8_t gGpsSatellites = 0;
uint8_t gGpsFixQuality = 0;
uint8_t gGpsFixType = 0;
uint8_t gGpsSatellitesInView = 0;
char gGpsRmcStatus = '?';
size_t gGpsBaudIndex = 0;
uint32_t gGpsLastFixMs = 0;
uint32_t gLastProblemIndicatorMs = 0;
int64_t gGpsLastUtcMs = 0;
int64_t gGpsCurrentUtcMs = 0;
String gGpsLastUtcIso;
String gGpsCurrentUtcIso;
int64_t gRecordingStartUtcMs = 0;
String gRecordingStartUtcIso;
float gHighPassPrevInput = 0.0f;
float gHighPassPrevOutput = 0.0f;
float gLowPassPrevOutput = 0.0f;

void startBuzzerPattern(uint8_t beepCount, uint16_t onMs, uint16_t offMs);
void recordingTaskMain(void *parameter);
const char *gpsStateLabel();

const char *recorderStateLabel() {
  switch (gState) {
    case RecorderState::WaitingToStart:
      return "WAITING_TO_START";
    case RecorderState::Recording:
      return "RECORDING";
    case RecorderState::Stopped:
      return "STOPPED";
    case RecorderState::Error:
      return "ERROR";
  }
  return "UNKNOWN";
}

void logBuzzerPatternRequest(const char *reason, uint8_t beepCount, uint16_t onMs, uint16_t offMs) {
  Serial.printf("Buzzer: reason=%s beeps=%u on_ms=%u off_ms=%u state=%s gps=%s recording_file=%s bytes=%lu\n",
                reason ? reason : "unspecified",
                static_cast<unsigned int>(beepCount),
                static_cast<unsigned int>(onMs),
                static_cast<unsigned int>(offMs),
                recorderStateLabel(),
                gpsStateLabel(),
                gRecordingPath.isEmpty() ? "none" : gRecordingPath.c_str(),
                static_cast<unsigned long>(gRecordingDataBytes));
}

bool lockSd(TickType_t timeoutTicks = portMAX_DELAY) {
  if (!gSdMutex) {
    return true;
  }
  return xSemaphoreTake(gSdMutex, timeoutTicks) == pdTRUE;
}

void unlockSd() {
  if (gSdMutex) {
    xSemaphoreGive(gSdMutex);
  }
}

int16_t cleanupAudioSample(int16_t sample) {
  if (!kAudioCleanupEnabled) {
    return sample;
  }

  const float input = static_cast<float>(sample);
  const float highPass = kAudioHighPassAlpha * (gHighPassPrevOutput + input - gHighPassPrevInput);
  gHighPassPrevInput = input;
  gHighPassPrevOutput = highPass;

  // Light smoothing reduces harsh hiss without removing speech detail.
  const float lowPass = gLowPassPrevOutput + kAudioLowPassAlpha * (highPass - gLowPassPrevOutput);
  gLowPassPrevOutput = lowPass;

  int32_t cleaned = static_cast<int32_t>(lowPass);
  const int32_t magnitude = cleaned >= 0 ? cleaned : -cleaned;

  // Reduce only the quietest floor noise so speech is preserved.
  if (magnitude < kAudioNoiseGateThreshold) {
    cleaned = (cleaned * kAudioNoiseFloorGainPercent) / 100;
  }

  // Keep a little headroom without pushing normal speech too far down.
  cleaned = (cleaned * kAudioPostScalePercent) / 100;

  if (cleaned > 32767) {
    cleaned = 32767;
  } else if (cleaned < -32768) {
    cleaned = -32768;
  }

  return static_cast<int16_t>(cleaned);
}

bool isLeapYear(int year) {
  if ((year % 4) != 0) {
    return false;
  }
  if ((year % 100) != 0) {
    return true;
  }
  return (year % 400) == 0;
}

bool parseTwoDigits(const char *text, int &value) {
  if (!text || !isdigit(static_cast<unsigned char>(text[0])) ||
      !isdigit(static_cast<unsigned char>(text[1]))) {
    return false;
  }
  value = (text[0] - '0') * 10 + (text[1] - '0');
  return true;
}

bool parseNmeaUtc(const char *dateField, const char *timeField, int64_t &utcMsOut) {
  if (!dateField || !timeField || strlen(dateField) < 6 || strlen(timeField) < 6) {
    return false;
  }

  int day = 0;
  int month = 0;
  int yearShort = 0;
  if (!parseTwoDigits(dateField, day) || !parseTwoDigits(dateField + 2, month) ||
      !parseTwoDigits(dateField + 4, yearShort)) {
    return false;
  }

  int hour = 0;
  int minute = 0;
  int second = 0;
  if (!parseTwoDigits(timeField, hour) || !parseTwoDigits(timeField + 2, minute) ||
      !parseTwoDigits(timeField + 4, second)) {
    return false;
  }

  int millisPart = 0;
  const char *dot = strchr(timeField, '.');
  if (dot) {
    int multiplier = 100;
    ++dot;
    while (*dot && isdigit(static_cast<unsigned char>(*dot)) && multiplier > 0) {
      millisPart += (*dot - '0') * multiplier;
      multiplier /= 10;
      ++dot;
    }
  }

  const int year = yearShort >= 80 ? 1900 + yearShort : 2000 + yearShort;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return false;
  }

  static const int kDaysBeforeMonth[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  int64_t days = 0;
  for (int y = 1970; y < year; ++y) {
    days += isLeapYear(y) ? 366 : 365;
  }
  days += kDaysBeforeMonth[month - 1];
  if (month > 2 && isLeapYear(year)) {
    days += 1;
  }
  days += day - 1;

  utcMsOut = (((days * 24LL + hour) * 60LL + minute) * 60LL + second) * 1000LL + millisPart;
  return true;
}

String formatUtcIso(int64_t utcMs) {
  if (utcMs <= 0) {
    return String();
  }

  time_t seconds = static_cast<time_t>(utcMs / 1000LL);
  const int millisPart = static_cast<int>(utcMs % 1000LL);
  struct tm utcTm {};
  if (!gmtime_r(&seconds, &utcTm)) {
    return String();
  }

  char buffer[32];
  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
           utcTm.tm_year + 1900, utcTm.tm_mon + 1, utcTm.tm_mday, utcTm.tm_hour,
           utcTm.tm_min, utcTm.tm_sec, millisPart < 0 ? 0 : millisPart);
  return String(buffer);
}

bool parseNmeaDegrees(const char *field, const char hemisphere, bool isLatitude, double &valueOut) {
  if (!field || !field[0]) {
    return false;
  }

  const int degreeDigits = isLatitude ? 2 : 3;
  if (strlen(field) < static_cast<size_t>(degreeDigits + 2)) {
    return false;
  }

  char degreesBuffer[4] = {};
  memcpy(degreesBuffer, field, degreeDigits);
  const double degrees = atof(degreesBuffer);
  const double minutes = atof(field + degreeDigits);
  double value = degrees + (minutes / 60.0);

  if (hemisphere == 'S' || hemisphere == 'W') {
    value = -value;
  }

  valueOut = value;
  return true;
}

bool parseNmeaDouble(const char *field, double &valueOut) {
  if (!field || !field[0]) {
    return false;
  }
  valueOut = atof(field);
  return true;
}

bool parseNmeaUint8(const char *field, uint8_t &valueOut) {
  if (!field || !field[0]) {
    return false;
  }
  valueOut = static_cast<uint8_t>(atoi(field));
  return true;
}

uint8_t readTinyGpsCustomUint8(TinyGPSCustom &custom, uint8_t fallback) {
  if (custom.isValid() && custom.value() && custom.value()[0]) {
    return static_cast<uint8_t>(atoi(custom.value()));
  }
  return fallback;
}

bool buildUtcMsFromGpsDateTime(int64_t &utcMsOut) {
  if (!gTinyGps.date.isValid() || !gTinyGps.time.isValid()) {
    return false;
  }

  const int year = gTinyGps.date.year();
  const int month = gTinyGps.date.month();
  const int day = gTinyGps.date.day();
  const int hour = gTinyGps.time.hour();
  const int minute = gTinyGps.time.minute();
  const int second = gTinyGps.time.second();
  const int millisPart = static_cast<int>(gTinyGps.time.centisecond()) * 10;

  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  static const int kDaysBeforeMonth[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  int64_t days = 0;
  for (int y = 1970; y < year; ++y) {
    days += isLeapYear(y) ? 366 : 365;
  }
  days += kDaysBeforeMonth[month - 1];
  if (month > 2 && isLeapYear(year)) {
    days += 1;
  }
  days += day - 1;

  utcMsOut = (((days * 24LL + hour) * 60LL + minute) * 60LL + second) * 1000LL + millisPart;
  return true;
}

const char *gpsStateLabel() {
  const bool hasUtc = !gGpsCurrentUtcIso.isEmpty();
  const bool hasLocation = gTinyGps.location.isValid();
  const bool hasSatellitesUsed = gTinyGps.satellites.isValid() && gTinyGps.satellites.value() > 0;

  if (hasLocation && hasUtc) {
    return "FIX";
  }
  if (hasUtc && (gGpsRmcStatus == 'V' || gGpsFixQuality == 0 || gGpsFixType <= 1 || !hasSatellitesUsed)) {
    return "TIME_ONLY";
  }
  if (gGpsSatellitesInView > 0) {
    return "SATS_VISIBLE_NO_FIX";
  }
  if (hasUtc) {
    return "UTC_ONLY";
  }
  return "NO_FIX";
}

void syncGpsStateFromTinyGps() {
  if (gTinyGps.location.isValid()) {
    gGpsLatitude = gTinyGps.location.lat();
    gGpsLongitude = gTinyGps.location.lng();
    gGpsHasLocation = true;
  }

  if (gTinyGps.altitude.isValid()) {
    gGpsAltitudeMeters = gTinyGps.altitude.meters();
  }

  if (gTinyGps.hdop.isValid()) {
    gGpsHdop = gTinyGps.hdop.hdop();
  }

  if (gTinyGps.speed.isValid()) {
    gGpsSpeedKnots = gTinyGps.speed.knots();
  }

  if (gTinyGps.course.isValid()) {
    gGpsCourseDegrees = gTinyGps.course.deg();
  }

  if (gTinyGps.satellites.isValid()) {
    gGpsSatellites = static_cast<uint8_t>(gTinyGps.satellites.value());
  }

  gGpsFixQuality = readTinyGpsCustomUint8(gGpsFixQualityGngga,
                    readTinyGpsCustomUint8(gGpsFixQualityGpgga, gGpsFixQuality));
  gGpsFixType = readTinyGpsCustomUint8(gGpsFixTypeGngsa,
                 readTinyGpsCustomUint8(gGpsFixTypeGpgsa,
                 readTinyGpsCustomUint8(gGpsFixTypeBdgsa, gGpsFixType)));
  gGpsSatellitesInView = readTinyGpsCustomUint8(gGpsSatViewGngsv,
                         readTinyGpsCustomUint8(gGpsSatViewGpgsv,
                         readTinyGpsCustomUint8(gGpsSatViewBdgsv, gGpsSatellitesInView)));
  if (gGpsRmcStatusGnrmc.isValid() && gGpsRmcStatusGnrmc.value() && gGpsRmcStatusGnrmc.value()[0]) {
    gGpsRmcStatus = gGpsRmcStatusGnrmc.value()[0];
  } else if (gGpsRmcStatusGprmc.isValid() && gGpsRmcStatusGprmc.value() && gGpsRmcStatusGprmc.value()[0]) {
    gGpsRmcStatus = gGpsRmcStatusGprmc.value()[0];
  }

  int64_t utcMs = 0;
  if (buildUtcMsFromGpsDateTime(utcMs)) {
    gGpsCurrentUtcMs = utcMs;
    gGpsCurrentUtcIso = formatUtcIso(gGpsCurrentUtcMs);
    gGpsLastUtcMs = utcMs;
  }
}

void writeGpsStatusSnapshot(const char *stateLabel) {
  if (!gSdReady) {
    return;
  }

  if (!lockSd(pdMS_TO_TICKS(200))) {
    Serial.println("WARN: skipped GPS status snapshot because SD was busy");
    return;
  }

  SD.remove(kGpsStatusFile);
  File gpsFile = SD.open(kGpsStatusFile, FILE_WRITE);
  if (!gpsFile) {
    unlockSd();
    Serial.println("WARN: unable to write GPS status snapshot");
    return;
  }

  gpsFile.printf("state: %s\n", stateLabel ? stateLabel : "unknown");
  gpsFile.printf("recording_file: %s\n", gRecordingPath.c_str());
  gpsFile.printf("recording_start_millis: %lu\n", static_cast<unsigned long>(gRecordingStartMs));
  gpsFile.printf("recording_start_utc: %s\n",
                 gRecordingStartUtcResolved ? gRecordingStartUtcIso.c_str() : "pending_gps_fix");
  gpsFile.printf("gps_fix_utc: %s\n", gGpsHasUtc ? gGpsLastUtcIso.c_str() : "not_available");
  gpsFile.printf("gps_fix_millis: %lu\n", static_cast<unsigned long>(gGpsLastFixMs));
  gpsFile.printf("fix_latency_ms: %lu\n",
                 static_cast<unsigned long>(gGpsLastFixMs >= gRecordingStartMs ? (gGpsLastFixMs - gRecordingStartMs) : 0));
  gpsFile.printf("latitude: %.6f\n", gGpsLatitude);
  gpsFile.printf("longitude: %.6f\n", gGpsLongitude);
  gpsFile.printf("altitude_m: %.2f\n", gGpsAltitudeMeters);
  gpsFile.printf("hdop: %.2f\n", gGpsHdop);
  gpsFile.printf("satellites: %u\n", gGpsSatellites);
  gpsFile.printf("satellites_in_view: %u\n", gGpsSatellitesInView);
  gpsFile.printf("fix_quality: %u\n", gGpsFixQuality);
  gpsFile.printf("fix_type: %u\n", gGpsFixType);
  gpsFile.printf("gps_baud: %lu\n", static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]));
  gpsFile.printf("gps_chars_processed: %lu\n", static_cast<unsigned long>(gTinyGps.charsProcessed()));
  gpsFile.printf("gps_sentences_with_fix: %lu\n", static_cast<unsigned long>(gTinyGps.sentencesWithFix()));
  gpsFile.printf("gps_passed_checksum: %lu\n", static_cast<unsigned long>(gTinyGps.passedChecksum()));
  gpsFile.printf("gps_failed_checksum: %lu\n", static_cast<unsigned long>(gTinyGps.failedChecksum()));
  gpsFile.printf("speed_knots: %.2f\n", gGpsSpeedKnots);
  gpsFile.printf("course_deg: %.2f\n", gGpsCourseDegrees);
  gpsFile.close();
  unlockSd();
}

void writeIndexSnapshot() {
  if (!lockSd(pdMS_TO_TICKS(200))) {
    Serial.println("WARN: skipped index snapshot because SD was busy");
    return;
  }

  SD.remove(kIndexFile);
  File indexFile = SD.open(kIndexFile, FILE_WRITE);
  if (!indexFile) {
    unlockSd();
    Serial.println("WARN: unable to write index snapshot");
    return;
  }

  indexFile.println(
      "file,start_millis,start_utc,sample_rate,bits_per_sample,gps_fix_utc,gps_fix_millis,fix_latency_ms,lat,lon,altitude_m,hdop,satellites,speed_knots,course_deg");
  indexFile.printf(
      "%s,%lu,%s,%lu,%u,%s,%lu,%lu,%.6f,%.6f,%.2f,%.2f,%u,%.2f,%.2f\n",
      gRecordingPath.c_str(), static_cast<unsigned long>(gRecordingStartMs),
      gRecordingStartUtcIso.c_str(), static_cast<unsigned long>(kSampleRate),
      kBitsPerSample, gGpsLastUtcIso.c_str(), static_cast<unsigned long>(gGpsLastFixMs),
      static_cast<unsigned long>(gGpsLastFixMs >= gRecordingStartMs ? (gGpsLastFixMs - gRecordingStartMs) : 0),
      gGpsLatitude, gGpsLongitude, gGpsAltitudeMeters, gGpsHdop, gGpsSatellites,
      gGpsSpeedKnots, gGpsCourseDegrees);
  indexFile.close();
  unlockSd();
}

void writeRecordingMetadata() {
  if (!gSdReady) {
    return;
  }

  if (!lockSd(pdMS_TO_TICKS(200))) {
    Serial.println("WARN: skipped recording metadata update because SD was busy");
    return;
  }

  SD.remove(kRecordingMetaFile);
  File metaFile = SD.open(kRecordingMetaFile, FILE_WRITE);
  if (!metaFile) {
    unlockSd();
    Serial.println("WARN: unable to write recording metadata");
    return;
  }

  metaFile.printf("recording_file: %s\n", gRecordingPath.isEmpty() ? "not_started" : gRecordingPath.c_str());
  metaFile.printf("recording_start_millis: %lu\n", static_cast<unsigned long>(gRecordingStartMs));
  metaFile.printf("recording_start_utc: %s\n",
                  gRecordingStartUtcResolved ? gRecordingStartUtcIso.c_str() : "pending_first_gps_fix");
  metaFile.printf("gps_state: %s\n", gpsStateLabel());
  metaFile.printf("gps_baud: %lu\n", static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]));
  metaFile.printf("gps_first_fix_acquired: %s\n", gFirstFixMetadataWritten ? "yes" : "no");
  metaFile.printf("gps_fix_utc: %s\n", gGpsHasUtc ? gGpsLastUtcIso.c_str() : "not_available");
  metaFile.printf("gps_fix_millis: %lu\n", static_cast<unsigned long>(gGpsLastFixMs));
  metaFile.printf("fix_latency_ms: %lu\n",
                  static_cast<unsigned long>(gGpsLastFixMs >= gRecordingStartMs ? (gGpsLastFixMs - gRecordingStartMs) : 0));
  metaFile.printf("latitude: %s\n", gGpsHasLocation ? String(gGpsLatitude, 6).c_str() : "na");
  metaFile.printf("longitude: %s\n", gGpsHasLocation ? String(gGpsLongitude, 6).c_str() : "na");
  metaFile.printf("altitude_m: %.2f\n", gGpsAltitudeMeters);
  metaFile.printf("hdop: %.2f\n", gGpsHdop);
  metaFile.printf("satellites_used: %u\n", gGpsSatellites);
  metaFile.printf("satellites_in_view: %u\n", gGpsSatellitesInView);
  metaFile.printf("fix_quality: %u\n", gGpsFixQuality);
  metaFile.printf("fix_type: %u\n", gGpsFixType);
  metaFile.printf("rmc_status: %c\n", gGpsRmcStatus);
  metaFile.close();
  unlockSd();
}

String gpsTrailPathForCurrentRecording() {
  if (gRecordingPath.isEmpty()) {
    return String("/current_recording_gps.csv");
  }

  String trailPath = gRecordingPath;
  const int extensionIndex = trailPath.lastIndexOf('.');
  if (extensionIndex >= 0) {
    trailPath.remove(extensionIndex);
  }
  trailPath += "_gps.csv";
  return trailPath;
}

void appendGpsHistoryEntry(const char *eventLabel) {
  if (!gSdReady) {
    return;
  }

  if (!lockSd(pdMS_TO_TICKS(200))) {
    Serial.println("WARN: skipped GPS history entry because SD was busy");
    return;
  }

  const bool historyFileExists = SD.exists(kGpsHistoryFile);
  File historyFile = SD.open(kGpsHistoryFile, FILE_APPEND);
  if (!historyFile) {
    unlockSd();
    Serial.println("WARN: unable to append GPS history");
    return;
  }

  const String perRecordingTrailPath = gpsTrailPathForCurrentRecording();
  const bool perRecordingFileExists = SD.exists(perRecordingTrailPath.c_str());
  File perRecordingFile = SD.open(perRecordingTrailPath.c_str(), FILE_APPEND);
  if (!perRecordingFile) {
    historyFile.close();
    unlockSd();
    Serial.println("WARN: unable to append per-recording GPS history");
    return;
  }

  const char *header =
      "point_index,event,recording_file,recording_start_millis,recording_start_utc,elapsed_since_start_ms,gps_state,gps_fix_utc,gps_fix_millis,latitude,longitude,altitude_m,hdop,satellites_used,satellites_in_view,fix_quality,fix_type,rmc_status,speed_knots,course_deg";
  const unsigned long elapsedSinceStartMs =
      static_cast<unsigned long>(gGpsLastFixMs >= gRecordingStartMs ? (gGpsLastFixMs - gRecordingStartMs) : 0);
  const char *event = eventLabel ? eventLabel : "update";
  const char *recordingFile = gRecordingPath.isEmpty() ? "not_started" : gRecordingPath.c_str();
  const char *recordingStartUtc =
      gRecordingStartUtcResolved ? gRecordingStartUtcIso.c_str() : "pending_first_gps_fix";
  const char *gpsFixUtc = gGpsHasUtc ? gGpsLastUtcIso.c_str() : "not_available";
  const String latitudeText = gGpsHasLocation ? String(gGpsLatitude, 6) : String("na");
  const String longitudeText = gGpsHasLocation ? String(gGpsLongitude, 6) : String("na");
  const uint32_t pointIndex = ++gRecordingGpsPointIndex;

  Serial.printf(
      "GPS save: point=%lu event=%s file=%s start_utc=%s fix_utc=%s elapsed_ms=%lu lat=%s lon=%s alt=%.2f hdop=%.2f sats=%u/%u fix_quality=%u fix_type=%u speed=%.2f course=%.2f\n",
      static_cast<unsigned long>(pointIndex),
      event,
      recordingFile,
      recordingStartUtc,
      gpsFixUtc,
      elapsedSinceStartMs,
      latitudeText.c_str(),
      longitudeText.c_str(),
      gGpsAltitudeMeters,
      gGpsHdop,
      gGpsSatellites,
      gGpsSatellitesInView,
      gGpsFixQuality,
      gGpsFixType,
      gGpsSpeedKnots,
      gGpsCourseDegrees);

  if (!historyFileExists) {
    historyFile.println(header);
  }
  if (!perRecordingFileExists) {
    perRecordingFile.println(header);
  }

  historyFile.printf(
      "%lu,%s,%s,%lu,%s,%lu,%s,%s,%lu,%s,%s,%.2f,%.2f,%u,%u,%u,%u,%c,%.2f,%.2f\n",
      static_cast<unsigned long>(pointIndex),
      event,
      recordingFile,
      static_cast<unsigned long>(gRecordingStartMs),
      recordingStartUtc,
      elapsedSinceStartMs,
      gpsStateLabel(),
      gpsFixUtc,
      static_cast<unsigned long>(gGpsLastFixMs),
      latitudeText.c_str(),
      longitudeText.c_str(),
      gGpsAltitudeMeters,
      gGpsHdop,
      gGpsSatellites,
      gGpsSatellitesInView,
      gGpsFixQuality,
      gGpsFixType,
      gGpsRmcStatus,
      gGpsSpeedKnots,
      gGpsCourseDegrees);
  perRecordingFile.printf(
      "%lu,%s,%s,%lu,%s,%lu,%s,%s,%lu,%s,%s,%.2f,%.2f,%u,%u,%u,%u,%c,%.2f,%.2f\n",
      static_cast<unsigned long>(pointIndex),
      event,
      recordingFile,
      static_cast<unsigned long>(gRecordingStartMs),
      recordingStartUtc,
      elapsedSinceStartMs,
      gpsStateLabel(),
      gpsFixUtc,
      static_cast<unsigned long>(gGpsLastFixMs),
      latitudeText.c_str(),
      longitudeText.c_str(),
      gGpsAltitudeMeters,
      gGpsHdop,
      gGpsSatellites,
      gGpsSatellitesInView,
      gGpsFixQuality,
      gGpsFixType,
      gGpsRmcStatus,
      gGpsSpeedKnots,
      gGpsCourseDegrees);
  historyFile.flush();
  perRecordingFile.flush();
  historyFile.close();
  perRecordingFile.close();
  unlockSd();

  Serial.printf("GPS trail append: event=%s trail=%s fix_utc=%s elapsed_ms=%lu\n",
                event,
                perRecordingTrailPath.c_str(),
                gpsFixUtc,
                elapsedSinceStartMs);
}

void persistGpsFilesIfDue(uint32_t now, bool force) {
  if (gState != RecorderState::Recording || !gSdReady || gRecordingPath.isEmpty()) {
    return;
  }

  if (!force && gLastGpsPersistMs != 0 && (now - gLastGpsPersistMs) < kGpsPersistIntervalMs) {
    return;
  }

  appendGpsHistoryEntry(gGpsHasUtc ? "periodic_fix_update" : "periodic_waiting_for_fix");
  gLastGpsPersistMs = now;

  Serial.printf("GPS point appended: state=%s file=%s fix_utc=%s lat=%s lon=%s\n",
                gpsStateLabel(),
                gRecordingPath.c_str(),
                gGpsHasUtc ? gGpsLastUtcIso.c_str() : "not_available",
                gGpsHasLocation ? String(gGpsLatitude, 6).c_str() : "na",
                gGpsHasLocation ? String(gGpsLongitude, 6).c_str() : "na");
}

void maybeResolveRecordingStartUtc() {
  if (!gGpsHasUtc || gRecordingStartMs == 0) {
    return;
  }

  const int32_t deltaMs = static_cast<int32_t>(gGpsLastFixMs - gRecordingStartMs);
  gRecordingStartUtcMs = gGpsLastUtcMs - static_cast<int64_t>(deltaMs);
  gRecordingStartUtcIso = formatUtcIso(gRecordingStartUtcMs);
  const bool wasResolved = gRecordingStartUtcResolved;
  gRecordingStartUtcResolved = !gRecordingStartUtcIso.isEmpty();

  if (gRecordingStartUtcResolved && !wasResolved) {
    Serial.printf("GPS start UTC resolved: record_start_utc=%s gps_fix_utc=%s fix_latency_ms=%lu\n",
                  gRecordingStartUtcIso.c_str(), gGpsLastUtcIso.c_str(),
                  static_cast<unsigned long>(gGpsLastFixMs >= gRecordingStartMs ? (gGpsLastFixMs - gRecordingStartMs) : 0));
    if (!gRecordingPath.isEmpty() && gSdReady) {
      writeIndexSnapshot();
      writeGpsStatusSnapshot("fix_acquired");
      writeRecordingMetadata();
      appendGpsHistoryEntry("fix_acquired");
    }
  }
}

void logGpsFix() {
  Serial.printf(
      "GPS fix: state=%s baud=%lu utc=%s lat=%.6f lon=%.6f alt=%.2f m sats=%u/%u fix_quality=%u fix_type=%u rmc_status=%c hdop=%.2f speed=%.2f kn course=%.2f deg fix_sentences=%lu fix_millis=%lu",
      gpsStateLabel(),
      static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]),
      gGpsLastUtcIso.c_str(), gGpsLatitude, gGpsLongitude, gGpsAltitudeMeters,
      gGpsSatellites, gGpsSatellitesInView, gGpsFixQuality, gGpsFixType, gGpsRmcStatus, gGpsHdop,
      gGpsSpeedKnots, gGpsCourseDegrees,
      static_cast<unsigned long>(gTinyGps.sentencesWithFix()),
      static_cast<unsigned long>(gGpsLastFixMs));
  if (gRecordingStartUtcResolved) {
    Serial.printf(" record_start_utc=%s", gRecordingStartUtcIso.c_str());
  }
  Serial.println();
}

void logGpsStatusNoFix() {
  const String latitudeText = gTinyGps.location.isValid() ? String(gGpsLatitude, 6) : String("na");
  const String longitudeText = gTinyGps.location.isValid() ? String(gGpsLongitude, 6) : String("na");

  Serial.printf(
      "GPS waiting: state=%s baud=%lu utc=%s lat=%s lon=%s sats_used=%u sats_view=%u fix_quality=%u fix_type=%u rmc_status=%c hdop=%.2f chars=%lu ok=%lu bad=%lu fix_sentences=%lu last_fix_utc=%s\n",
      gpsStateLabel(),
      static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]),
      gGpsCurrentUtcIso.isEmpty() ? "not_available" : gGpsCurrentUtcIso.c_str(),
      latitudeText.c_str(),
      longitudeText.c_str(),
      gGpsSatellites,
      gGpsSatellitesInView, gGpsFixQuality, gGpsFixType, gGpsRmcStatus, gGpsHdop,
      static_cast<unsigned long>(gTinyGps.charsProcessed()),
      static_cast<unsigned long>(gTinyGps.passedChecksum()),
      static_cast<unsigned long>(gTinyGps.failedChecksum()),
      static_cast<unsigned long>(gTinyGps.sentencesWithFix()),
      gGpsHasUtc ? gGpsLastUtcIso.c_str() : "not_available");
}

void logGpsStatusTick() {
  const uint32_t now = millis();
  if (gLastGpsLogMs != 0 && (now - gLastGpsLogMs) < kGpsLogIntervalMs) {
    return;
  }

  const uint32_t lastByteAgeMs =
      gLastGpsByteMs == 0 ? 0 : static_cast<unsigned long>(now - gLastGpsByteMs);

  if (gGpsHasUtc && gTinyGps.location.isValid()) {
    logGpsFix();
  } else {
    Serial.printf(
        "GPS tick: state=%s baud=%lu bytes_seen=%lu chars=%lu ok=%lu bad=%lu last_byte_age_ms=%lu utc=%s lat=%s lon=%s sats_used=%u sats_view=%u fix_quality=%u fix_type=%u\n",
        gpsStateLabel(),
        static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]),
        static_cast<unsigned long>(gGpsBytesSeen),
        static_cast<unsigned long>(gTinyGps.charsProcessed()),
        static_cast<unsigned long>(gTinyGps.passedChecksum()),
        static_cast<unsigned long>(gTinyGps.failedChecksum()),
        static_cast<unsigned long>(lastByteAgeMs),
        gGpsCurrentUtcIso.isEmpty() ? "not_available" : gGpsCurrentUtcIso.c_str(),
        gTinyGps.location.isValid() ? String(gGpsLatitude, 6).c_str() : "na",
        gTinyGps.location.isValid() ? String(gGpsLongitude, 6).c_str() : "na",
        gGpsSatellites,
        gGpsSatellitesInView,
        gGpsFixQuality,
        gGpsFixType);
  }

  gLastGpsLogMs = now;
}

void handleGpsFixUpdate() {
  const bool hadUtcFixBefore = gGpsHasUtc;
  const bool hadSavedFirstFixBefore = gFirstFixMetadataWritten;
  gGpsLastFixMs = millis();
  gGpsLastUtcIso = formatUtcIso(gGpsLastUtcMs);
  gGpsHasUtc = !gGpsLastUtcIso.isEmpty();
  maybeResolveRecordingStartUtc();

  if (gTinyGps.location.isValid() && gGpsHasUtc && !hadSavedFirstFixBefore) {
    gFirstFixMetadataWritten = true;
    writeRecordingMetadata();
    appendGpsHistoryEntry("first_fix_saved");
    Serial.printf("GPS first fix saved: file=%s utc=%s lat=%.6f lon=%.6f\n",
                  gRecordingPath.c_str(),
                  gGpsLastUtcIso.c_str(),
                  gGpsLatitude,
                  gGpsLongitude);
  }

  if (gGpsHasUtc && !hadUtcFixBefore && !gGpsLockAnnounced) {
    gGpsLockAnnounced = true;
    Serial.println("GPS lock acquired");
  }

  if (gTinyGps.location.isValid() && gGpsHasUtc && !gGpsFixBeepPlayed) {
    gGpsFixBeepPlayed = true;
    logBuzzerPatternRequest("gps_location_fix_acquired",
                            kGpsFixBeepCount,
                            kGpsFixBeepOnMs,
                            kGpsFixBeepOffMs);
    startBuzzerPattern(kGpsFixBeepCount, kGpsFixBeepOnMs, kGpsFixBeepOffMs);
    Serial.printf("GPS location fix acquired: lat=%.6f lon=%.6f utc=%s\n",
                  gGpsLatitude,
                  gGpsLongitude,
                  gGpsLastUtcIso.c_str());
  }
}

void setGpsBaudIndex(size_t baudIndex) {
  if (baudIndex >= kGpsBaudRateCount) {
    return;
  }
  gGpsBaudIndex = baudIndex;
  gGpsSerial.end();
  gGpsSerial.begin(kGpsBaudRates[gGpsBaudIndex], SERIAL_8N1, kGpsRxPin, kGpsTxPin);
  gGpsSentenceLength = 0;
  gLastGpsByteMs = 0;
  gLastGpsNoDataLogMs = 0;
  gLastGpsBaudSwitchMs = millis();
  Serial.printf("GPS baud switched to %lu\n", static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]));
}

void serviceGps() {
  if (!gGpsReady) {
    return;
  }

  uint32_t bytesReadThisPass = 0;
  while (gGpsSerial.available() > 0) {
    const char ch = static_cast<char>(gGpsSerial.read());
    bytesReadThisPass++;
    gGpsBytesSeen++;
    gLastGpsByteMs = millis();
    if (gTinyGps.encode(ch)) {
      syncGpsStateFromTinyGps();
      if (gTinyGps.location.isValid() && gTinyGps.date.isValid() && gTinyGps.time.isValid()) {
        handleGpsFixUpdate();
      }
    }
  }

  const uint32_t now = millis();
  const bool hasSeenAnyGpsByte = gGpsBytesSeen > 0;

  if (!hasSeenAnyGpsByte) {
    if ((now - gLastGpsBaudSwitchMs) >= kGpsBaudScanIntervalMs) {
      setGpsBaudIndex((gGpsBaudIndex + 1) % kGpsBaudRateCount);
    }
    if (gLastGpsNoDataLogMs == 0 || (now - gLastGpsNoDataLogMs) >= kGpsNoDataLogIntervalMs) {
      Serial.printf("GPS retry: no bytes received yet at baud=%lu, switching every %lu ms, chars=%lu\n",
                    static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]),
                    static_cast<unsigned long>(kGpsBaudScanIntervalMs),
                    static_cast<unsigned long>(gTinyGps.charsProcessed()));
      gLastGpsNoDataLogMs = now;
    }
    return;
  }

  if (bytesReadThisPass == 0 && gLastGpsByteMs > 0 &&
      (now - gLastGpsByteMs) >= kGpsNoDataLogIntervalMs &&
      (gLastGpsNoDataLogMs == 0 || (now - gLastGpsNoDataLogMs) >= kGpsNoDataLogIntervalMs)) {
    Serial.printf("GPS stalled: last_byte_ms_ago=%lu baud=%lu chars=%lu ok=%lu bad=%lu state=%s\n",
                  static_cast<unsigned long>(now - gLastGpsByteMs),
                  static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]),
                  static_cast<unsigned long>(gTinyGps.charsProcessed()),
                  static_cast<unsigned long>(gTinyGps.passedChecksum()),
                  static_cast<unsigned long>(gTinyGps.failedChecksum()),
                  gpsStateLabel());
    gLastGpsNoDataLogMs = now;
    return;
  }

  if (!gGpsHasUtc &&
      (gLastGpsNoDataLogMs == 0 || (now - gLastGpsNoDataLogMs) >= kGpsNoDataLogIntervalMs)) {
    logGpsStatusNoFix();
    gLastGpsNoDataLogMs = now;
  }
}

void setBuzzerLevel(bool high) {
  gBuzzerPinLevel = kBuzzerEnabled && high;
  pinMode(kBuzzerPin, OUTPUT);
  if (!gBuzzerPinLevel && kBuzzerReleasePinWhenIdle) {
    pinMode(kBuzzerPin, INPUT_PULLUP);
    return;
  }

  const uint8_t outputLevel =
      gBuzzerPinLevel ? (kBuzzerActiveHigh ? HIGH : LOW) : (kBuzzerActiveHigh ? LOW : HIGH);
  digitalWrite(kBuzzerPin, outputLevel);
}

void startBuzzerPattern(uint8_t beepCount, uint16_t onMs, uint16_t offMs) {
  if (!kBuzzerEnabled) {
    gBuzzerActive = false;
    gBuzzerPhaseRemaining = 0;
    gBuzzerOnMs = 0;
    gBuzzerOffMs = 0;
    setBuzzerLevel(false);
    return;
  }

  gBuzzerActive = beepCount > 0;
  gBuzzerPhaseRemaining = beepCount;
  gBuzzerOnMs = onMs;
  gBuzzerOffMs = offMs;

  if (!gBuzzerActive) {
    setBuzzerLevel(false);
    return;
  }

  setBuzzerLevel(true);
  gBuzzerToggleAtMs = millis() + gBuzzerOnMs;
}

void serviceBuzzer() {
  if (!gBuzzerActive) {
    return;
  }

  const uint32_t now = millis();
  if (static_cast<int32_t>(now - gBuzzerToggleAtMs) < 0) {
    return;
  }

  if (gBuzzerPinLevel) {
    setBuzzerLevel(false);
    if (gBuzzerPhaseRemaining > 0) {
      gBuzzerPhaseRemaining--;
    }
    if (gBuzzerPhaseRemaining == 0) {
      gBuzzerActive = false;
      Serial.println("Buzzer: pattern complete");
      return;
    }
    gBuzzerToggleAtMs = now + gBuzzerOffMs;
    return;
  }

  setBuzzerLevel(true);
  gBuzzerToggleAtMs = now + gBuzzerOnMs;
}

WavHeader buildWavHeader(uint32_t dataBytes) {
  WavHeader header{};
  memcpy(header.riff, "RIFF", 4);
  memcpy(header.wave, "WAVE", 4);
  memcpy(header.fmt, "fmt ", 4);
  memcpy(header.data, "data", 4);
  header.chunkSize = 36 + dataBytes;
  header.subchunk1Size = 16;
  header.audioFormat = 1;
  header.numChannels = 1;
  header.sampleRate = kSampleRate;
  header.bitsPerSample = kBitsPerSample;
  header.byteRate = kSampleRate * header.numChannels * (header.bitsPerSample / 8);
  header.blockAlign = header.numChannels * (header.bitsPerSample / 8);
  header.subchunk2Size = dataBytes;
  return header;
}

bool writeWavHeader(File &file, uint32_t dataBytes) {
  const WavHeader header = buildWavHeader(dataBytes);
  if (!file.seek(0)) {
    return false;
  }
  const size_t written = file.write(reinterpret_cast<const uint8_t *>(&header), sizeof(header));
  file.flush();
  return written == sizeof(header);
}

bool checkpointRecordingFile() {
  if (!gRecordingFile) {
    return false;
  }

  gRecordingFile.flush();
  gRecordingFile.close();

  File headerFile = SD.open(gRecordingPath.c_str(), "r+");
  if (!headerFile) {
    Serial.printf("WARN: checkpoint reopen-for-header failed for %s\n", gRecordingPath.c_str());
    return false;
  }

  if (!writeWavHeader(headerFile, gRecordingDataBytes)) {
    headerFile.close();
    Serial.printf("WARN: checkpoint header update failed for %s bytes=%lu\n",
                  gRecordingPath.c_str(),
                  static_cast<unsigned long>(gRecordingDataBytes));
    return false;
  }
  headerFile.close();

  gRecordingFile = SD.open(gRecordingPath.c_str(), FILE_APPEND);
  if (!gRecordingFile) {
    Serial.printf("WARN: checkpoint reopen-for-append failed for %s\n", gRecordingPath.c_str());
    return false;
  }

  const uint32_t resumeOffset = sizeof(WavHeader) + gRecordingDataBytes;
  if (!gRecordingFile.seek(resumeOffset)) {
    Serial.printf("WARN: checkpoint seek-to-append failed for %s offset=%lu\n",
                  gRecordingPath.c_str(),
                  static_cast<unsigned long>(resumeOffset));
    gRecordingFile.close();
    return false;
  }

  return true;
}

bool ensureRecordingDirectory() {
  if (strcmp(kRecordingDir, "/") == 0) {
    return true;
  }
  if (SD.exists(kRecordingDir)) {
    return true;
  }
  return SD.mkdir(kRecordingDir);
}

String allocateRecordingPath() {
  for (uint16_t i = 1; i < 10000; ++i) {
    char path[40];
    if (strcmp(kRecordingDir, "/") == 0) {
      snprintf(path, sizeof(path), "/rec_%04u.wav", i);
    } else {
      snprintf(path, sizeof(path), "%s/rec_%04u.wav", kRecordingDir, i);
    }
    if (!SD.exists(path)) {
      return String(path);
    }
  }
  return String();
}

bool runSdWriteProbe() {
  const char *probePath = "/sd_probe.txt";
  File probeFile = SD.open(probePath, FILE_WRITE);
  if (!probeFile) {
    Serial.println("ERROR: SD opened but test file creation failed");
    return false;
  }

  probeFile.println("sd write ok");
  probeFile.close();
  SD.remove(probePath);
  return true;
}

void clearPreviousRecordingFiles() {
  if (!lockSd()) {
    Serial.println("WARN: could not lock SD to clear old recordings");
    return;
  }

  File root = SD.open("/");
  if (!root) {
    unlockSd();
    Serial.println("WARN: could not open SD root to clear old recordings");
    return;
  }

  File entry = root.openNextFile();
  while (entry) {
    String name = entry.name();
    const bool isDirectory = entry.isDirectory();
    entry.close();

    if (!isDirectory) {
      if (name.startsWith("._") || name.startsWith("/._")) {
        entry = root.openNextFile();
        continue;
      }
      if (name.endsWith(".wav") || name.endsWith(".WAV") || name == "/index.csv" || name == "index.csv") {
        SD.remove(name.c_str());
      }
    }

    entry = root.openNextFile();
  }

  root.close();
  unlockSd();
}

bool setupSdCard() {
  gSdSpi.begin(kSdSckPin, kSdMisoPin, kSdMosiPin, kSdCsPin);
  if (!SD.begin(kSdCsPin, gSdSpi, kSdSpiFrequency)) {
    Serial.println("ERROR: SD.begin failed");
    return false;
  }

  if (!ensureRecordingDirectory()) {
    Serial.printf("ERROR: could not prepare recording directory '%s'\n", kRecordingDir);
    return false;
  }

  if (!runSdWriteProbe()) {
    Serial.println("ERROR: SD card is mounted but not writable");
    return false;
  }

  sdcard_type_t cardType = SD.cardType();
  const char *cardTypeLabel = "UNKNOWN";
  switch (cardType) {
    case CARD_MMC:
      cardTypeLabel = "MMC";
      break;
    case CARD_SD:
      cardTypeLabel = "SDSC";
      break;
    case CARD_SDHC:
      cardTypeLabel = "SDHC/SDXC";
      break;
    case CARD_NONE:
      cardTypeLabel = "NONE";
      break;
  }

  uint64_t cardSizeMb = SD.cardSize() / (1024ULL * 1024ULL);
  uint64_t totalMb = SD.totalBytes() / (1024ULL * 1024ULL);
  uint64_t usedMb = SD.usedBytes() / (1024ULL * 1024ULL);
  Serial.printf("SD ready: type=%s card=%llu MB total=%llu MB used=%llu MB freq=%lu Hz\n",
                cardTypeLabel, cardSizeMb, totalMb, usedMb,
                static_cast<unsigned long>(kSdSpiFrequency));
  return true;
}

bool setupI2SMicrophone() {
  const i2s_config_t config = {
      .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
      .sample_rate = static_cast<int>(kSampleRate),
      .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
      .communication_format = I2S_COMM_FORMAT_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 8,
      .dma_buf_len = 256,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = 0,
  };

  const i2s_pin_config_t pinConfig = {
      .bck_io_num = static_cast<int>(kI2sBclkPin),
      .ws_io_num = static_cast<int>(kI2sWsPin),
      .data_out_num = I2S_PIN_NO_CHANGE,
      .data_in_num = static_cast<int>(kI2sDataInPin),
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &config, 0, nullptr);
  if (err != ESP_OK) {
    Serial.printf("ERROR: i2s_driver_install failed (%d)\n", err);
    return false;
  }

  err = i2s_set_pin(I2S_NUM_0, &pinConfig);
  if (err != ESP_OK) {
    Serial.printf("ERROR: i2s_set_pin failed (%d)\n", err);
    return false;
  }

  err = i2s_zero_dma_buffer(I2S_NUM_0);
  if (err != ESP_OK) {
    Serial.printf("ERROR: i2s_zero_dma_buffer failed (%d)\n", err);
    return false;
  }

  return true;
}

bool setupGpsModule() {
  gGpsBaudIndex = 0;
  gGpsSerial.begin(kGpsBaudRates[gGpsBaudIndex], SERIAL_8N1, kGpsRxPin, kGpsTxPin);
  gLastGpsBaudSwitchMs = millis();
  Serial.printf("GPS UART ready: RX=%d TX=%d baud=%lu\n", kGpsRxPin, kGpsTxPin,
                static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]));
  Serial.println("GPS module will stay active and keep searching until first fix");
  return true;
}

void stopRecording(const char *reason) {
  if (gRecordingFile && lockSd(pdMS_TO_TICKS(1000))) {
    writeWavHeader(gRecordingFile, gRecordingDataBytes);
    gRecordingFile.close();
    unlockSd();
  }

  gState = RecorderState::Stopped;
  gProblemIndicatorEnabled = true;
  gLastProblemIndicatorMs = millis();
  logBuzzerPatternRequest("recording_stopped", 1, 40, 0);
  startBuzzerPattern(1, 40, 0);
  Serial.printf("Recording stopped: %s. Bytes=%lu path=%s\n", reason,
                static_cast<unsigned long>(gRecordingDataBytes), gRecordingPath.c_str());
  writeGpsStatusSnapshot(gGpsHasUtc ? "recording_stopped_with_fix" : "recording_stopped_without_fix");
  appendGpsHistoryEntry(gGpsHasUtc ? "recording_stopped_with_fix" : "recording_stopped_without_fix");
}

bool startRecording() {
  if (!gSdReady) {
    Serial.println("ERROR: recording skipped because SD card is not ready");
    return false;
  }

  if (!gMicReady) {
    Serial.println("ERROR: recording skipped because microphone is not ready");
    return false;
  }

  clearPreviousRecordingFiles();

  gRecordingPath = allocateRecordingPath();
  if (gRecordingPath.isEmpty()) {
    Serial.println("ERROR: no free recording filename available");
    return false;
  }

  if (!lockSd()) {
    Serial.println("ERROR: failed to lock SD before opening recording file");
    return false;
  }

  gRecordingFile = SD.open(gRecordingPath.c_str(), FILE_WRITE);
  if (!gRecordingFile) {
    Serial.printf("WARN: failed to open %s with FILE_WRITE\n", gRecordingPath.c_str());

    // Fallback to a short fixed filename in case the filesystem or library is
    // unhappy with the generated path or create mode.
    gRecordingPath = "/REC00001.WAV";
    SD.remove(gRecordingPath.c_str());
    gRecordingFile = SD.open(gRecordingPath.c_str(), FILE_WRITE);
  }

  if (!gRecordingFile) {
    unlockSd();
    Serial.printf("ERROR: failed to open WAV file for writing: %s\n", gRecordingPath.c_str());
    return false;
  }

  gRecordingDataBytes = 0;
  gRecordingStartMs = millis();
  gLastHeaderSyncMs = gRecordingStartMs;
  gLastHeartbeatMs = gRecordingStartMs;
  gLastRecordingProgressLogMs = gRecordingStartMs;
  gLastGpsPersistMs = gRecordingStartMs;
  gRecordingStartUtcResolved = false;
  gRecordingStartUtcMs = 0;
  gRecordingStartUtcIso = String();
  gGpsLockAnnounced = false;
  gGpsFixBeepPlayed = false;
  gFirstFixMetadataWritten = false;
  gRecordingGpsPointIndex = 0;
  gHighPassPrevInput = 0.0f;
  gHighPassPrevOutput = 0.0f;
  gLowPassPrevOutput = 0.0f;

  if (!writeWavHeader(gRecordingFile, 0)) {
    unlockSd();
    Serial.println("ERROR: failed to write initial WAV header");
    gRecordingFile.close();
    return false;
  }
  unlockSd();

  maybeResolveRecordingStartUtc();
  writeIndexSnapshot();
  writeGpsStatusSnapshot("recording_waiting_for_fix");
  writeRecordingMetadata();
  appendGpsHistoryEntry("recording_started");
  gState = RecorderState::Recording;
  gProblemIndicatorEnabled = false;
  logBuzzerPatternRequest("recording_started", 2, 120, 120);
  startBuzzerPattern(2, 120, 120);

  Serial.printf("Recording started: %s start_millis=%lu\n", gRecordingPath.c_str(),
                static_cast<unsigned long>(gRecordingStartMs));
  return true;
}

void failRecorder(const char *message) {
  if (gRecordingFile && lockSd(pdMS_TO_TICKS(1000))) {
    writeWavHeader(gRecordingFile, gRecordingDataBytes);
    gRecordingFile.close();
    unlockSd();
  }
  Serial.printf("FATAL: %s\n", message);
  gState = RecorderState::Error;
  gProblemIndicatorEnabled = true;
  gLastProblemIndicatorMs = millis();
  logBuzzerPatternRequest(message, 1, 40, 0);
  startBuzzerPattern(1, 40, 0);
}

void reportIssue(const char *message) {
  Serial.printf("ERROR: %s\n", message);
  gProblemIndicatorEnabled = true;
  gLastProblemIndicatorMs = millis();
  logBuzzerPatternRequest(message, 1, 40, 0);
  startBuzzerPattern(1, 40, 0);
}

void setupHardware() {
  pinMode(kBuzzerPin, OUTPUT);
  setBuzzerLevel(false);

  if (!gSdMutex) {
    gSdMutex = xSemaphoreCreateMutex();
    if (!gSdMutex) {
      Serial.println("ERROR: failed to create SD mutex");
    }
  }

  gSdReady = setupSdCard();
  if (!gSdReady) {
    reportIssue("SD card init failed");
  }

  gMicReady = setupI2SMicrophone();
  if (!gMicReady) {
    reportIssue("I2S microphone init failed or microphone not connected");
  }

  gGpsReady = setupGpsModule();
  if (!gGpsReady) {
    Serial.println("WARN: recorder will continue without GPS fixes");
  }
}

void processRecording() {
  int32_t rawSamples[kSamplesPerChunk];
  int16_t pcmSamples[kSamplesPerChunk];
  size_t bytesRead = 0;

  // Never let a disconnected or silent I2S device block GPS and buzzer service.
  esp_err_t err = i2s_read(I2S_NUM_0, rawSamples, sizeof(rawSamples), &bytesRead, 0);
  if (err == ESP_ERR_TIMEOUT || bytesRead == 0) {
    delay(1);
    return;
  }
  if (err != ESP_OK) {
    failRecorder("i2s_read failed");
    return;
  }

  const uint32_t now = millis();
  if (now - gLastRecordingProgressLogMs >= kRecordingProgressLogIntervalMs) {
    Serial.printf("Recorder alive: bytes=%lu last_gps_state=%s gps_chars=%lu start_utc=%s sd_retry_events=%lu sd_retry_attempts=%lu sd_failures=%lu\n",
                  static_cast<unsigned long>(gRecordingDataBytes),
                  gpsStateLabel(),
                  static_cast<unsigned long>(gTinyGps.charsProcessed()),
                  gRecordingStartUtcResolved ? gRecordingStartUtcIso.c_str() : "pending_gps_fix",
                  static_cast<unsigned long>(gSdRecoveredWriteEvents),
                  static_cast<unsigned long>(gSdRecoveredWriteAttempts),
                  static_cast<unsigned long>(gSdWriteFailureEvents));
    gLastRecordingProgressLogMs = now;
    gSdRecoveredWriteEvents = 0;
    gSdRecoveredWriteAttempts = 0;
    gSdWriteFailureEvents = 0;
  }

  const size_t sampleCount = bytesRead / sizeof(int32_t);
  if (sampleCount == 0) {
    return;
  }

  for (size_t i = 0; i < sampleCount; ++i) {
    // INMP441 delivers a signed 24-bit sample inside a 32-bit I2S word.
    // First arithmetic-shift down to a signed 24-bit value, then downscale to
    // 16-bit PCM. Casting directly after a single >> 8 truncates the wrong bits
    // and produces harsh/distorted voice.
    const int32_t sample24 = rawSamples[i] >> 8;
    const int16_t sample16 = static_cast<int16_t>(sample24 >> 8);
    pcmSamples[i] = cleanupAudioSample(sample16);
  }

  const size_t pcmBytes = sampleCount * sizeof(int16_t);
  if (!lockSd(pdMS_TO_TICKS(kSdWriteLockTimeoutMs))) {
    failRecorder("Timed out waiting for SD access");
    return;
  }

  const uint8_t *writePtr = reinterpret_cast<const uint8_t *>(pcmSamples);
  size_t totalWritten = 0;
  uint8_t writeAttempts = 0;
  bool neededRetry = false;
  const uint32_t writeStartMs = millis();

  while (totalWritten < pcmBytes && writeAttempts <= kSdWriteRetryCount) {
    const size_t written = gRecordingFile.write(writePtr + totalWritten, pcmBytes - totalWritten);
    totalWritten += written;
    if (totalWritten >= pcmBytes) {
      break;
    }

    writeAttempts++;
    neededRetry = true;
    delay(kSdWriteRetryDelayMs);
  }

  const uint32_t writeElapsedMs = millis() - writeStartMs;
  if (writeElapsedMs >= 250) {
    Serial.printf("WARN: SD write took %lu ms for %u bytes\n",
                  static_cast<unsigned long>(writeElapsedMs),
                  static_cast<unsigned int>(pcmBytes));
  }
  if (totalWritten != pcmBytes) {
    gSdWriteFailureEvents++;
    Serial.printf("WARN: SD write could not complete after retries wrote=%u expected=%u attempts=%u\n",
                  static_cast<unsigned int>(totalWritten),
                  static_cast<unsigned int>(pcmBytes),
                  static_cast<unsigned int>(writeAttempts));
    unlockSd();
    failRecorder("SD write failed while recording");
    return;
  }

  if (neededRetry) {
    gSdRecoveredWriteEvents++;
    gSdRecoveredWriteAttempts += writeAttempts;
  }

  gRecordingDataBytes += totalWritten;

  if (kHeaderSyncIntervalMs > 0 && (now - gLastHeaderSyncMs) >= kHeaderSyncIntervalMs) {
    if (!checkpointRecordingFile()) {
      Serial.printf("WARN: failed to checkpoint WAV header at data_bytes=%lu, continuing recording\n",
                    static_cast<unsigned long>(gRecordingDataBytes));
    } else {
      gLastHeaderSyncMs = now;
      Serial.printf("WAV checkpoint saved: data_bytes=%lu\n",
                    static_cast<unsigned long>(gRecordingDataBytes));
    }
  }

  unlockSd();

  if (kRecordingHeartbeatMs > 0 && (now - gLastHeartbeatMs >= kRecordingHeartbeatMs)) {
    logBuzzerPatternRequest("recording_heartbeat", 1, 40, 0);
    startBuzzerPattern(1, 40, 0);
    gLastHeartbeatMs = now;
    Serial.printf("Recording... %lu bytes written start_utc=%s\n",
                  static_cast<unsigned long>(gRecordingDataBytes),
                  gRecordingStartUtcResolved ? gRecordingStartUtcIso.c_str() : "pending_gps_fix");
  }

  persistGpsFilesIfDue(now, false);

  if (kMaxRecordingSeconds > 0 && (now - gRecordingStartMs) >= kMaxRecordingSeconds * 1000UL) {
    stopRecording("max duration reached");
  }
}

void recordingTaskMain(void *parameter) {
  (void)parameter;
  Serial.println("Recording task ready");
  for (;;) {
    if (gState == RecorderState::Recording) {
      processRecording();
      taskYIELD();
      continue;
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println();
  Serial.println("ESP32 INMP441 recorder booting...");
  Serial.printf("Firmware build: GPS-TICK-NONBLOCK %s %s\n", __DATE__, __TIME__);
  Serial.printf("Startup delay: %lu ms\n", static_cast<unsigned long>(kStartupDelayMs));
  Serial.printf("Mic pins: BCLK=%d WS=%d SD=%d\n", kI2sBclkPin, kI2sWsPin, kI2sDataInPin);
  Serial.printf("SD pins: CS=%d SCK=%d MISO=%d MOSI=%d\n", kSdCsPin, kSdSckPin, kSdMisoPin, kSdMosiPin);
  Serial.printf("Buzzer pin: %d\n", kBuzzerPin);
  Serial.printf("GPS pins: RX=%d TX=%d baud=%lu\n", kGpsRxPin, kGpsTxPin,
                static_cast<unsigned long>(kGpsBaudRates[gGpsBaudIndex]));

  setupHardware();
  xTaskCreatePinnedToCore(recordingTaskMain, "recordingTask", 6144, nullptr, 1, &gRecordingTaskHandle, 1);
  if (!gRecordingTaskHandle) {
    Serial.println("ERROR: failed to create recording task");
    gState = RecorderState::Error;
  }
  logBuzzerPatternRequest("boot_complete", 1, 100, 0);
  startBuzzerPattern(1, 100, 0);
}

void loop() {
  serviceBuzzer();
  serviceGps();

  if (gState == RecorderState::Error || gState == RecorderState::Stopped) {
    if (gProblemIndicatorEnabled && !gBuzzerActive) {
      const uint32_t now = millis();
      if (gLastProblemIndicatorMs == 0 ||
          (now - gLastProblemIndicatorMs) >= kProblemIndicatorIntervalMs) {
        logBuzzerPatternRequest("problem_indicator", 1, 40, 0);
        startBuzzerPattern(1, 40, 0);
        gLastProblemIndicatorMs = now;
      }
    }
    delay(10);
    return;
  }

  if (gState == RecorderState::WaitingToStart) {
    const uint32_t elapsed = millis();
    if (elapsed >= kStartupDelayMs) {
      if (!startRecording()) {
        gState = RecorderState::Stopped;
        gProblemIndicatorEnabled = true;
        gLastProblemIndicatorMs = millis();
        Serial.println("Recorder idle. Fix the reported hardware/storage issue and reset ESP32 to try again.");
        logBuzzerPatternRequest("recorder_idle_after_start_failure", 1, 40, 0);
        startBuzzerPattern(1, 40, 0);
      }
      return;
    }

    delay(5);
    return;
  }

  delay(1);
}