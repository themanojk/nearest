#pragma once

#include <Arduino.h>
#include <FS.h>
#include <freertos/semphr.h>

class NearNestConnectivity {
 public:
  using EnterTransferStorageMode = bool (*)(const String &probePath);
  using LeaveTransferStorageMode = void (*)();

  void begin(fs::FS &storage,
             SemaphoreHandle_t storageMutex,
             EnterTransferStorageMode enterTransferStorageMode = nullptr,
             LeaveTransferStorageMode leaveTransferStorageMode = nullptr);
  void service();

  bool consumeStopRecordingRequest();
  bool consumeStartRecordingRequest();
  void setRecordingActive(bool active);
  void setRecordingAvailable(const String &path,
                             const String &recordingId,
                             uint64_t sizeBytes);
  void setRecordingUnavailable();

  // Internal protocol entry points used by BLE callbacks and the upload task.
  bool queueCommand(const String &json);
  void handleCommand(const String &json);
  void publishStatus(const String &json);
  void publishError(const char *code, const String &message);

 private:
  fs::FS *storage_ = nullptr;
  SemaphoreHandle_t storageMutex_ = nullptr;
  EnterTransferStorageMode enterTransferStorageMode_ = nullptr;
  LeaveTransferStorageMode leaveTransferStorageMode_ = nullptr;
  volatile bool stopRecordingRequested_ = false;
  volatile bool startRecordingRequested_ = false;
  bool recordingAvailable_ = false;
  bool recordingFinalized_ = false;
  bool recordingActive_ = false;
  String recordingPath_;
  String recordingId_;
  uint64_t recordingSizeBytes_ = 0;

  void publishManifest(const String &recordingId = String());
  void publishNextRecording(const String &afterFileName);
  bool resolveRecording(const String &recordingId,
                        String &path,
                        uint64_t &sizeBytes);
  void startTransferAccessPoint();
  void stopTransferAccessPoint(bool notify = true);
  void serveNetworkBenchmark();
  void startUdpNetworkBenchmark();
  void startUdpRecordingTransfer();
  void serveRecordingRange();
  void signChallenge(const String &payload);
  void configureWifi(const String &ssid, const String &password);
  void releaseRecording(const String &recordingId);
};
