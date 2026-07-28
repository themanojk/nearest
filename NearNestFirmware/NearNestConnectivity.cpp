#include "NearNestConnectivity.h"

#include <ArduinoJson.h>
#include <Ed25519.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <SD.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <esp_system.h>
#include <mbedtls/base64.h>
#include <freertos/queue.h>
#include <memory>

#include "NearNestBuildConfig.h"
#include "device_secrets.h"

namespace {

constexpr char kServiceUuid[] = "8ec90001-f315-4f60-9fb8-838830daea50";
constexpr char kIdentityUuid[] = "8ec90002-f315-4f60-9fb8-838830daea50";
constexpr char kCommandUuid[] = "8ec90003-f315-4f60-9fb8-838830daea50";
constexpr char kStatusUuid[] = "8ec90004-f315-4f60-9fb8-838830daea50";
constexpr size_t kMaxCommandBytes = 4096;
constexpr uint32_t kMaximumTransferRangeBytes = 10 * 1024 * 1024;
constexpr uint32_t kNetworkBenchmarkBytes = 16 * 1024 * 1024;
constexpr size_t kNetworkBenchmarkBufferBytes = 16 * 1024;
constexpr uint32_t kTransferApIdleTimeoutMs = 10 * 60 * 1000;
// ESP32's default TCP send window is much smaller than 32 KB. Feeding it in
// window-sized blocks preserves throughput while leaving heap available for
// Wi-Fi pbufs and retransmissions.
constexpr size_t kTransferBufferBytes = 32 * 1024;
constexpr uint32_t kBleHandoffDelayMs = 750;
constexpr char kTransferTokenHeader[] = "X-NearNest-Transfer-Token";
constexpr char kTransferBaseUrl[] = "http://192.168.4.1";

NearNestConnectivity *gConnectivity = nullptr;
NimBLEServer *gBleServer = nullptr;
NimBLECharacteristic *gStatusCharacteristic = nullptr;
String gCommandBuffer;
size_t gExpectedCommandBytes = 0;
QueueHandle_t gCommandQueue = nullptr;
std::unique_ptr<WebServer> gTransferServer;
String gTransferToken;
String gTransferSsid;
String gTransferPassword;
bool gTransferApActive = false;
uint32_t gTransferLastActivityMs = 0;
uint8_t gTransferApChannel = 1;
uint16_t gBleConnectionHandle = BLE_HS_CONN_HANDLE_NONE;
uint32_t gBleDisconnectAtMs = 0;

int readBatteryPercent() {
#if NEARNEST_BATTERY_ADC_PIN >= 0
  const uint32_t pinMillivolts =
      analogReadMilliVolts(NEARNEST_BATTERY_ADC_PIN);
  const uint32_t batteryMillivolts = static_cast<uint32_t>(
      pinMillivolts * NEARNEST_BATTERY_DIVIDER_RATIO);
  if (batteryMillivolts <= NEARNEST_BATTERY_EMPTY_MV) return 0;
  if (batteryMillivolts >= NEARNEST_BATTERY_FULL_MV) return 100;
  return static_cast<int>(
      (batteryMillivolts - NEARNEST_BATTERY_EMPTY_MV) * 100UL /
      (NEARNEST_BATTERY_FULL_MV - NEARNEST_BATTERY_EMPTY_MV));
#else
  return -1;
#endif
}

uint8_t selectLeastBusyTransferChannel() {
  constexpr uint8_t channels[] = {1, 6, 11};
  uint32_t scores[] = {0, 0, 0};
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  const int networkCount = WiFi.scanNetworks(false, true);
  if (networkCount <= 0) {
    WiFi.scanDelete();
    return channels[0];
  }

  for (int network = 0; network < networkCount; ++network) {
    const int channel = WiFi.channel(network);
    const int rssi = WiFi.RSSI(network);
    const uint32_t weight =
        static_cast<uint32_t>(max(1, 101 + rssi));
    for (size_t index = 0; index < 3; ++index) {
      const int distance = abs(channel - channels[index]);
      if (distance <= 4) {
        scores[index] += weight * static_cast<uint32_t>(5 - distance);
      }
    }
  }
  WiFi.scanDelete();

  size_t selected = 0;
  for (size_t index = 1; index < 3; ++index) {
    if (scores[index] < scores[selected]) selected = index;
  }
  Serial.printf(
      "Transfer Wi-Fi channel scan: ch1=%lu ch6=%lu ch11=%lu selected=%u\n",
      static_cast<unsigned long>(scores[0]),
      static_cast<unsigned long>(scores[1]),
      static_cast<unsigned long>(scores[2]),
      static_cast<unsigned int>(channels[selected]));
  return channels[selected];
}

String jsonString(const String &value) {
  String output;
  output.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    const char ch = value[i];
    switch (ch) {
      case '\\':
        output += "\\\\";
        break;
      case '"':
        output += "\\\"";
        break;
      case '\n':
        output += "\\n";
        break;
      case '\r':
        output += "\\r";
        break;
      default:
        output += ch;
        break;
    }
  }
  return output;
}

String recordingFileName(const String &path) {
  const int slash = path.lastIndexOf('/');
  return slash >= 0 ? path.substring(slash + 1) : path;
}

bool isWaveFileName(const String &fileName) {
  String lower = fileName;
  lower.toLowerCase();
  return !fileName.isEmpty() && !fileName.startsWith("._") &&
         lower.endsWith(".wav");
}

String recordingIdForFileName(const String &fileName) {
  return String("sd-") + fileName;
}

String randomHex(size_t byteCount) {
  std::unique_ptr<uint8_t[]> bytes(new uint8_t[byteCount]);
  if (!bytes) return String();
  esp_fill_random(bytes.get(), byteCount);
  constexpr char kHex[] = "0123456789abcdef";
  String result;
  result.reserve(byteCount * 2);
  for (size_t index = 0; index < byteCount; ++index) {
    result += kHex[bytes[index] >> 4];
    result += kHex[bytes[index] & 0x0f];
  }
  return result;
}

bool parseUnsignedArgument(const String &value, uint64_t &parsed) {
  if (value.isEmpty()) return false;
  uint64_t result = 0;
  for (size_t index = 0; index < value.length(); ++index) {
    const char character = value[index];
    if (character < '0' || character > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(character - '0');
    if (result > (UINT64_MAX - digit) / 10) return false;
    result = result * 10 + digit;
  }
  parsed = result;
  return true;
}

String base64Url(const uint8_t *data, size_t length) {
  size_t encodedLength = 0;
  mbedtls_base64_encode(nullptr, 0, &encodedLength, data, length);
  std::unique_ptr<uint8_t[]> encoded(new uint8_t[encodedLength + 1]);
  if (!encoded) {
    return String();
  }
  if (mbedtls_base64_encode(
          encoded.get(), encodedLength + 1, &encodedLength, data, length) != 0) {
    return String();
  }
  encoded[encodedLength] = '\0';
  String result(reinterpret_cast<char *>(encoded.get()));
  result.replace("+", "-");
  result.replace("/", "_");
  while (result.endsWith("=")) {
    result.remove(result.length() - 1);
  }
  return result;
}

uint32_t pairingPasskey() {
  return NEARNEST_BLE_PASSKEY;
}

bool credentialsLookProvisioned() {
  uint8_t privateAccumulator = 0;
  uint8_t publicAccumulator = 0;
  for (size_t i = 0; i < 32; ++i) {
    privateAccumulator |= NEARNEST_ED25519_PRIVATE_KEY[i];
    publicAccumulator |= NEARNEST_ED25519_PUBLIC_KEY[i];
  }
  return privateAccumulator != 0 && publicAccumulator != 0;
}

class NearNestServerCallbacks : public NimBLEServerCallbacks {
 public:
  void onConnect(NimBLEServer *,
                 NimBLEConnInfo &connectionInfo) override {
    gBleConnectionHandle = connectionInfo.getConnHandle();
  }

  void onDisconnect(NimBLEServer *,
                    NimBLEConnInfo &connectionInfo,
                    int) override {
    if (gBleConnectionHandle == connectionInfo.getConnHandle()) {
      gBleConnectionHandle = BLE_HS_CONN_HANDLE_NONE;
    }
    gBleDisconnectAtMs = 0;
    NimBLEDevice::getAdvertising()->start();
  }
};

class NearNestCommandCallbacks : public NimBLECharacteristicCallbacks {
 public:
  void onWrite(NimBLECharacteristic *characteristic,
               NimBLEConnInfo &) override {
    const auto value = characteristic->getValue();
    if (value.length() == 0 || !gConnectivity) return;
    String packet;
    packet.reserve(value.length());
    for (size_t i = 0; i < value.length(); ++i) {
      packet += static_cast<char>(value[i]);
    }

    if (packet.startsWith("BEGIN:")) {
      const size_t length = static_cast<size_t>(
          strtoul(packet.substring(6).c_str(), nullptr, 10));
      if (length == 0 || length > kMaxCommandBytes) {
        gExpectedCommandBytes = 0;
        gCommandBuffer = String();
        gConnectivity->publishError(
            "command.too_large", "Invalid BLE command length");
        return;
      }
      gExpectedCommandBytes = length;
      gCommandBuffer = String();
      gCommandBuffer.reserve(length);
      return;
    }

    if (gExpectedCommandBytes == 0) {
      gConnectivity->publishError(
          "command.no_frame", "Send BEGIN:<byte-length> before command data");
      return;
    }
    if (gCommandBuffer.length() + value.length() > gExpectedCommandBytes) {
      gExpectedCommandBytes = 0;
      gCommandBuffer = String();
      gConnectivity->publishError(
          "command.overflow", "BLE command exceeded declared length");
      return;
    }
    for (size_t i = 0; i < value.length(); ++i) {
      gCommandBuffer += static_cast<char>(value[i]);
    }
    if (gCommandBuffer.length() == gExpectedCommandBytes) {
      const String command = gCommandBuffer;
      gExpectedCommandBytes = 0;
      gCommandBuffer = String();
      if (!gConnectivity->queueCommand(command)) {
        gConnectivity->publishError(
            "command.queue_full", "Device is still processing another command");
      }
    }
  }
};

}  // namespace

void NearNestConnectivity::begin(fs::FS &storage,
                                 SemaphoreHandle_t storageMutex,
                                 EnterTransferStorageMode enterTransferStorageMode,
                                 LeaveTransferStorageMode leaveTransferStorageMode) {
  storage_ = &storage;
  storageMutex_ = storageMutex;
  enterTransferStorageMode_ = enterTransferStorageMode;
  leaveTransferStorageMode_ = leaveTransferStorageMode;
  gConnectivity = this;
  if (!gCommandQueue) {
    gCommandQueue = xQueueCreate(4, sizeof(char *));
  }
  // New firmware never joins an upstream network. Remove credentials left by
  // older builds before BLE starts accepting commands.
  Preferences legacyWifi;
  if (legacyWifi.begin("nearnest-wifi", false)) {
    legacyWifi.clear();
    legacyWifi.end();
  }
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  NimBLEDevice::init(
      std::string("NearNest ") + NEARNEST_DEVICE_SERIAL);
  NimBLEDevice::setMTU(517);
  NimBLEServer *server = NimBLEDevice::createServer();
  gBleServer = server;
  server->setCallbacks(new NearNestServerCallbacks());
  NimBLEService *service = server->createService(kServiceUuid);

  NimBLECharacteristic *identity = service->createCharacteristic(
      kIdentityUuid, NIMBLE_PROPERTY::READ);
  DynamicJsonDocument identityJson(512);
  identityJson["serialNumber"] = NEARNEST_DEVICE_SERIAL;
  identityJson["hardwareRevision"] = NEARNEST_HARDWARE_REVISION;
  identityJson["firmwareVersion"] = NEARNEST_FIRMWARE_VERSION;
  identityJson["pairingCodeHint"] = pairingPasskey() % 100;
  identityJson["identityReady"] = credentialsLookProvisioned();
  String identityValue;
  serializeJson(identityJson, identityValue);
  identity->setValue(identityValue.c_str());

  NimBLECharacteristic *command = service->createCharacteristic(
      kCommandUuid,
      NIMBLE_PROPERTY::WRITE |
          NIMBLE_PROPERTY::WRITE_NR |
          NIMBLE_PROPERTY::WRITE_ENC |
          NIMBLE_PROPERTY::WRITE_AUTHEN);
  command->setCallbacks(new NearNestCommandCallbacks());

  gStatusCharacteristic = service->createCharacteristic(
      kStatusUuid,
      NIMBLE_PROPERTY::READ |
          NIMBLE_PROPERTY::NOTIFY |
          NIMBLE_PROPERTY::READ_ENC |
          NIMBLE_PROPERTY::READ_AUTHEN);
  gStatusCharacteristic->setValue("{\"event\":\"booting\"}");

  service->start();
  NimBLEDevice::setSecurityAuth(true, true, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
  NimBLEDevice::setSecurityPasskey(pairingPasskey());

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setName(
      std::string("NearNest ") + NEARNEST_DEVICE_SERIAL);
  advertising->start();

  publishStatus(
      String("{\"event\":\"ready\",\"serialNumber\":\"") +
      jsonString(NEARNEST_DEVICE_SERIAL) + "\"}");
}

void NearNestConnectivity::service() {
  if (gBleDisconnectAtMs != 0 &&
      static_cast<int32_t>(millis() - gBleDisconnectAtMs) >= 0) {
    gBleDisconnectAtMs = 0;
    if (gBleServer &&
        gBleConnectionHandle != BLE_HS_CONN_HANDLE_NONE) {
      Serial.println(
          "Transfer handoff: releasing active BLE connection for Wi-Fi");
      gBleServer->disconnect(gBleConnectionHandle);
    }
  }
  if (gTransferServer) {
    gTransferServer->handleClient();
  }
  if (gTransferApActive &&
      millis() - gTransferLastActivityMs > kTransferApIdleTimeoutMs) {
    stopTransferAccessPoint();
  }
  if (!gCommandQueue) return;

  char *queuedJson = nullptr;
  if (xQueueReceive(gCommandQueue, &queuedJson, 0) != pdTRUE ||
      !queuedJson) {
    return;
  }

  const String command(queuedJson);
  free(queuedJson);
  handleCommand(command);
}

bool NearNestConnectivity::queueCommand(const String &json) {
  if (!gCommandQueue || json.isEmpty() || json.length() > kMaxCommandBytes) {
    return false;
  }

  char *queuedJson = static_cast<char *>(malloc(json.length() + 1));
  if (!queuedJson) {
    return false;
  }
  memcpy(queuedJson, json.c_str(), json.length() + 1);

  if (xQueueSend(gCommandQueue, &queuedJson, 0) != pdTRUE) {
    free(queuedJson);
    return false;
  }
  return true;
}

bool NearNestConnectivity::consumeStopRecordingRequest() {
  if (!stopRecordingRequested_) return false;
  stopRecordingRequested_ = false;
  return true;
}

bool NearNestConnectivity::consumeStartRecordingRequest() {
  if (!startRecordingRequested_) return false;
  startRecordingRequested_ = false;
  return true;
}

void NearNestConnectivity::setRecordingAvailable(const String &path,
                                                 const String &recordingId,
                                                 uint64_t sizeBytes) {
  recordingPath_ = path;
  recordingId_ = recordingId;
  recordingSizeBytes_ = sizeBytes;
  recordingAvailable_ = true;
  recordingFinalized_ = true;
  publishStatus("{\"event\":\"recording.ready\"}");
}

void NearNestConnectivity::setRecordingActive(bool active) {
  recordingActive_ = active;
}

void NearNestConnectivity::setRecordingUnavailable() {
  recordingAvailable_ = false;
  recordingFinalized_ = false;
}

void NearNestConnectivity::handleCommand(const String &json) {
  DynamicJsonDocument command(4096);
  const DeserializationError error = deserializeJson(command, json);
  if (error) {
    publishError("command.invalid_json", error.c_str());
    return;
  }
  const String operation = command["op"] | "";
  if (operation == "pair.challenge") {
    signChallenge(command["payload"] | "");
  } else if (operation == "wifi.configure") {
    configureWifi(command["ssid"] | "", command["password"] | "");
  } else if (operation == "recording.stop") {
    if (recordingFinalized_) {
      publishStatus("{\"event\":\"recording.ready\"}");
    } else if (!recordingActive_) {
      publishStatus("{\"event\":\"recording.idle\"}");
    } else {
      stopRecordingRequested_ = true;
      publishStatus("{\"event\":\"recording.stop_requested\"}");
    }
  } else if (operation == "recording.start") {
    if (recordingActive_) {
      publishStatus("{\"event\":\"recording.started\"}");
    } else {
      stopTransferAccessPoint(false);
      startRecordingRequested_ = true;
      publishStatus("{\"event\":\"recording.start_requested\"}");
    }
  } else if (operation == "recording.status") {
    publishStatus(
        recordingActive_
            ? "{\"event\":\"recording.status\",\"state\":\"recording\"}"
            : "{\"event\":\"recording.status\",\"state\":\"idle\"}");
  } else if (operation == "device.telemetry") {
    const int batteryPercent = readBatteryPercent();
    uint64_t storageTotalBytes = 0;
    uint64_t storageUsedBytes = 0;
    if (storageMutex_ &&
        xSemaphoreTake(storageMutex_, pdMS_TO_TICKS(5000)) != pdTRUE) {
      publishError("device.telemetry_busy", "Storage is busy");
      return;
    }
    storageTotalBytes = SD.totalBytes();
    storageUsedBytes = SD.usedBytes();
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    publishStatus(
        String("{\"event\":\"device.telemetry\",\"batteryPercent\":") +
        (batteryPercent >= 0 ? String(batteryPercent) : String("null")) +
        ",\"storageUsedBytes\":" +
        String(static_cast<unsigned long long>(storageUsedBytes)) +
        ",\"storageTotalBytes\":" +
        String(static_cast<unsigned long long>(storageTotalBytes)) + "}");
  } else if (operation == "recording.manifest") {
    publishManifest(command["recordingId"] | "");
  } else if (operation == "recordings.next") {
    publishNextRecording(command["afterFileName"] | "");
  } else if (operation == "transfer.ap.start") {
    startTransferAccessPoint();
  } else if (operation == "transfer.ap.stop") {
    stopTransferAccessPoint();
  } else if (operation == "upload.part") {
    publishError(
        "upload.disabled",
        "Direct cloud upload is disabled; transfer through the paired phone");
  } else if (operation == "upload.cancel") {
    publishError(
        "upload.disabled",
        "Direct cloud upload is disabled; transfer through the paired phone");
  } else if (operation == "recording.release") {
    releaseRecording(command["recordingId"] | "");
  } else {
    publishError("command.unknown", "Unknown command operation");
  }
}

void NearNestConnectivity::publishStatus(const String &json) {
  if (json.indexOf("\"event\":\"transfer.ap_ready\"") >= 0) {
    Serial.println(
        "Connectivity: transfer.ap_ready (credentials sent over encrypted BLE)");
  } else {
    Serial.printf("Connectivity: %s\n", json.c_str());
  }
  if (!gStatusCharacteristic) return;
  gStatusCharacteristic->setValue(json.c_str());
  gStatusCharacteristic->notify();
}

void NearNestConnectivity::publishError(const char *code,
                                        const String &message) {
  publishStatus(
      String("{\"event\":\"error\",\"code\":\"") + jsonString(code) +
      "\",\"message\":\"" + jsonString(message) + "\"}");
}

void NearNestConnectivity::publishManifest(const String &requestedRecordingId) {
  String path;
  String recordingId = requestedRecordingId;
  uint64_t sizeBytes = 0;
  if (recordingId.isEmpty()) {
    if (!recordingAvailable_) {
      publishError(
          "recording.not_ready",
          "Stop and finalize the recording before requesting its manifest");
      return;
    }
    path = recordingPath_;
    recordingId = recordingId_;
    sizeBytes = recordingSizeBytes_;
  } else if (!resolveRecording(recordingId, path, sizeBytes)) {
    publishError("recording.not_found", "Recording is unavailable");
    return;
  }
  publishStatus(
      String("{\"event\":\"recording.manifest\",\"recordingId\":\"") +
      jsonString(recordingId) + "\",\"fileName\":\"" +
      jsonString(recordingFileName(path)) +
      "\",\"contentType\":\"audio/wav\",\"sizeBytes\":" +
      String(static_cast<unsigned long long>(sizeBytes)) + "}");
}

void NearNestConnectivity::publishNextRecording(const String &afterFileName) {
  if (!storage_) {
    publishError("recording.storage", "Storage is unavailable");
    return;
  }
  if (afterFileName.indexOf('/') >= 0 || afterFileName.indexOf('\\') >= 0 ||
      afterFileName.indexOf("..") >= 0) {
    publishError("recording.invalid_cursor", "Invalid recording cursor");
    return;
  }
  if (storageMutex_ &&
      xSemaphoreTake(storageMutex_, pdMS_TO_TICKS(5000)) != pdTRUE) {
    publishError("recording.storage_busy", "Storage is busy");
    return;
  }

  File root = storage_->open("/");
  String selectedFileName;
  uint64_t selectedSizeBytes = 0;
  if (root) {
    File entry = root.openNextFile();
    while (entry) {
      if (!entry.isDirectory()) {
        const String fileName = recordingFileName(String(entry.name()));
        if (isWaveFileName(fileName) && entry.size() > 44 &&
            fileName.compareTo(afterFileName) > 0 &&
            (selectedFileName.isEmpty() ||
             fileName.compareTo(selectedFileName) < 0)) {
          selectedFileName = fileName;
          selectedSizeBytes = static_cast<uint64_t>(entry.size());
        }
      }
      entry.close();
      entry = root.openNextFile();
    }
    root.close();
  }
  if (storageMutex_) xSemaphoreGive(storageMutex_);

  if (selectedFileName.isEmpty()) {
    publishStatus(
        String("{\"event\":\"recording.list_complete\",\"afterFileName\":\"") +
        jsonString(afterFileName) + "\"}");
    return;
  }
  publishStatus(
      String("{\"event\":\"recording.item\",\"recordingId\":\"") +
      jsonString(recordingIdForFileName(selectedFileName)) +
      "\",\"fileName\":\"" + jsonString(selectedFileName) +
      "\",\"contentType\":\"audio/wav\",\"sizeBytes\":" +
      String(static_cast<unsigned long long>(selectedSizeBytes)) + "}");
}

bool NearNestConnectivity::resolveRecording(const String &recordingId,
                                            String &path,
                                            uint64_t &sizeBytes) {
  constexpr char kRecordingIdPrefix[] = "sd-";
  if (!storage_ || !recordingId.startsWith(kRecordingIdPrefix)) return false;
  const String fileName = recordingId.substring(strlen(kRecordingIdPrefix));
  if (!isWaveFileName(fileName) || fileName.indexOf('/') >= 0 ||
      fileName.indexOf('\\') >= 0 || fileName.indexOf("..") >= 0) {
    return false;
  }
  path = String("/") + fileName;
  if (storageMutex_ &&
      xSemaphoreTake(storageMutex_, pdMS_TO_TICKS(5000)) != pdTRUE) {
    return false;
  }
  File file = storage_->open(path.c_str(), FILE_READ);
  if (!file) {
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    return false;
  }
  sizeBytes = static_cast<uint64_t>(file.size());
  file.close();
  if (storageMutex_) xSemaphoreGive(storageMutex_);
  return sizeBytes > 0;
}

void NearNestConnectivity::signChallenge(const String &payload) {
  if (!credentialsLookProvisioned()) {
    publishError(
        "identity.not_provisioned", "Device identity keys are placeholders");
    return;
  }
  if (payload.isEmpty() || payload.length() > 1024) {
    publishError("identity.invalid_challenge", "Invalid challenge payload");
    return;
  }
  uint8_t signature[64];
  Ed25519::sign(
      signature,
      NEARNEST_ED25519_PRIVATE_KEY,
      NEARNEST_ED25519_PUBLIC_KEY,
      reinterpret_cast<const uint8_t *>(payload.c_str()),
      payload.length());
  const String encoded = base64Url(signature, sizeof(signature));
  if (encoded.isEmpty()) {
    publishError("identity.sign_failed", "Could not encode signature");
    return;
  }
  publishStatus(
      String("{\"event\":\"pair.signature\",\"signature\":\"") +
      encoded + "\"}");
}

void NearNestConnectivity::configureWifi(const String &ssid,
                                         const String &password) {
  (void)ssid;
  (void)password;
  // Router credentials are deliberately not retained. Bulk data is served by
  // the isolated WPA2 access point and the phone performs the cloud upload.
  Preferences preferences;
  if (!preferences.begin("nearnest-wifi", false)) {
    publishError("wifi.storage", "Unable to clear legacy Wi-Fi configuration");
    return;
  }
  preferences.clear();
  preferences.end();
  WiFi.disconnect(true);
  publishStatus("{\"event\":\"wifi.configured\"}");
}

void NearNestConnectivity::startTransferAccessPoint() {
  if (!storage_) {
    publishError("transfer.storage", "Storage is unavailable");
    return;
  }
  if (gTransferApActive && gTransferServer) {
    publishStatus(
        String("{\"event\":\"transfer.ap_ready\",\"ssid\":\"") +
        jsonString(gTransferSsid) + "\",\"password\":\"" +
        jsonString(gTransferPassword) + "\",\"baseUrl\":\"" +
        kTransferBaseUrl + "\",\"token\":\"" + gTransferToken + "\"}");
    return;
  }

  stopTransferAccessPoint(false);
  if (enterTransferStorageMode_ &&
      !enterTransferStorageMode_(recordingPath_)) {
    publishError(
        "transfer.storage_mode",
        "Could not prepare the SD card for reliable high-speed transfer");
    return;
  }
  gTransferPassword = String("NN-") + randomHex(6);
  gTransferToken = randomHex(16);
  gTransferSsid = String("NearNest-") + NEARNEST_DEVICE_SERIAL;
  if (gTransferSsid.length() > 32) gTransferSsid.remove(32);
  if (gTransferPassword.length() < 8 || gTransferToken.length() != 32) {
    if (leaveTransferStorageMode_) leaveTransferStorageMode_();
    publishError("transfer.random", "Could not create transfer credentials");
    return;
  }

  Preferences preferences;
  if (preferences.begin("nearnest-wifi", false)) {
    preferences.clear();
    preferences.end();
  }
  gTransferApChannel = selectLeastBusyTransferChannel();
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  const IPAddress address(192, 168, 4, 1);
  const IPAddress subnet(255, 255, 255, 0);
  if (!WiFi.softAPConfig(address, address, subnet) ||
      !WiFi.softAP(
          gTransferSsid.c_str(), gTransferPassword.c_str(),
          gTransferApChannel, 0, 1)) {
    WiFi.mode(WIFI_OFF);
    gTransferPassword = String();
    gTransferToken = String();
    if (leaveTransferStorageMode_) leaveTransferStorageMode_();
    publishError("transfer.ap_failed", "Could not start the transfer network");
    return;
  }

  gTransferServer.reset(new WebServer(80));
  if (!gTransferServer) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    if (leaveTransferStorageMode_) leaveTransferStorageMode_();
    publishError("transfer.memory", "Could not allocate the transfer server");
    return;
  }
  const char *headers[] = {kTransferTokenHeader};
  gTransferServer->collectHeaders(headers, 1);
  gTransferServer->on(
      "/v1/health", HTTP_GET, [this]() {
        if (gTransferServer->header(kTransferTokenHeader) != gTransferToken) {
          gTransferServer->send(401, "application/json",
                                "{\"error\":\"unauthorized\"}");
          return;
        }
        gTransferServer->send(200, "application/json", "{\"status\":\"ok\"}");
      });
  gTransferServer->on(
      "/v1/benchmark", HTTP_GET, [this]() { serveNetworkBenchmark(); });
  gTransferServer->on(
      "/v1/recording", HTTP_GET, [this]() { serveRecordingRange(); });
  gTransferServer->onNotFound([]() {
    gTransferServer->send(
        404, "application/json", "{\"error\":\"not_found\"}");
  });
  gTransferServer->begin();
  gTransferApActive = true;
  gTransferLastActivityMs = millis();
  Serial.printf(
      "Transfer AP memory: free_heap=%lu min_free_heap=%lu "
      "largest_block=%lu\n",
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      static_cast<unsigned long>(ESP.getMaxAllocHeap()));

  publishStatus(
      String("{\"event\":\"transfer.ap_ready\",\"ssid\":\"") +
      jsonString(gTransferSsid) + "\",\"password\":\"" +
      jsonString(gTransferPassword) + "\",\"baseUrl\":\"" +
      kTransferBaseUrl + "\",\"token\":\"" + gTransferToken + "\"}");
  if (gBleConnectionHandle != BLE_HS_CONN_HANDLE_NONE) {
    // Give the encrypted notification time to reach the phone, then remove
    // the active BLE connection from the shared 2.4 GHz radio. Advertising
    // resumes after disconnect so the app can reconnect to stop the AP.
    gBleDisconnectAtMs = millis() + kBleHandoffDelayMs;
  }
}

void NearNestConnectivity::stopTransferAccessPoint(bool notify) {
  if (gTransferServer) {
    gTransferServer->stop();
    gTransferServer.reset();
  }
  if (gTransferApActive) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
  }
  gTransferApActive = false;
  gTransferLastActivityMs = 0;
  gTransferToken = String();
  gTransferPassword = String();
  gTransferSsid = String();
  gBleDisconnectAtMs = 0;
  if (leaveTransferStorageMode_) leaveTransferStorageMode_();
  if (notify) {
    publishStatus("{\"event\":\"transfer.ap_stopped\"}");
  }
}

void NearNestConnectivity::serveNetworkBenchmark() {
  gTransferLastActivityMs = millis();
  if (!gTransferServer ||
      gTransferServer->header(kTransferTokenHeader) != gTransferToken) {
    if (gTransferServer) {
      gTransferServer->send(
          401, "application/json", "{\"error\":\"unauthorized\"}");
    }
    return;
  }

  std::unique_ptr<uint8_t[]> buffer(
      new uint8_t[kNetworkBenchmarkBufferBytes]);
  if (!buffer) {
    gTransferServer->send(
        503, "application/json", "{\"error\":\"insufficient_memory\"}");
    return;
  }
  for (size_t index = 0; index < kNetworkBenchmarkBufferBytes; ++index) {
    buffer[index] = static_cast<uint8_t>(
        (index * 31U + 17U) & 0xffU);
  }

  // Advertising alone can preempt the shared 2.4 GHz radio. Pause it only
  // for this diagnostic so the result measures Wi-Fi rather than coexistence.
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  const bool resumeAdvertising =
      advertising && advertising->isAdvertising();
  if (resumeAdvertising) advertising->stop();
  delay(20);

  WiFiClient client = gTransferServer->client();
  client.setNoDelay(true);
  client.printf(
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Length: %lu\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n\r\n",
      static_cast<unsigned long>(kNetworkBenchmarkBytes));

  uint32_t remaining = kNetworkBenchmarkBytes;
  uint32_t lastWriteAtMs = millis();
  const uint32_t startedAtMs = millis();
  while (remaining > 0 && client.connected()) {
    const size_t wanted =
        remaining < kNetworkBenchmarkBufferBytes
            ? remaining
            : kNetworkBenchmarkBufferBytes;
    const size_t written = client.write(buffer.get(), wanted);
    if (written == 0) {
      if (millis() - lastWriteAtMs > 15000) break;
      delay(1);
      continue;
    }
    remaining -= static_cast<uint32_t>(written);
    lastWriteAtMs = millis();
    delay(1);
  }

  const uint32_t elapsedMs =
      max(static_cast<uint32_t>(1), millis() - startedAtMs);
  const uint32_t completedBytes = kNetworkBenchmarkBytes - remaining;
  const uint32_t kibPerSecond =
      static_cast<uint32_t>(
          static_cast<uint64_t>(completedBytes) * 1000ULL /
          elapsedMs / 1024ULL);
  client.stop();
  if (resumeAdvertising) advertising->start();

  Serial.printf(
      "RAM benchmark: bytes=%lu elapsed_ms=%lu speed_kib_s=%lu "
      "channel=%u free_heap=%lu min_free_heap=%lu result=%s\n",
      static_cast<unsigned long>(completedBytes),
      static_cast<unsigned long>(elapsedMs),
      static_cast<unsigned long>(kibPerSecond),
      static_cast<unsigned int>(gTransferApChannel),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      remaining == 0 ? "complete" : "interrupted");
}

void NearNestConnectivity::serveRecordingRange() {
  gTransferLastActivityMs = millis();
  if (!gTransferServer ||
      gTransferServer->header(kTransferTokenHeader) != gTransferToken) {
    if (gTransferServer) {
      gTransferServer->send(
          401, "application/json", "{\"error\":\"unauthorized\"}");
    }
    return;
  }

  const String recordingId = gTransferServer->arg("recordingId");
  uint64_t offsetBytes = 0;
  uint64_t requestedLength = 0;
  String path;
  uint64_t recordingSize = 0;
  if (!parseUnsignedArgument(
          gTransferServer->arg("offsetBytes"), offsetBytes) ||
      !parseUnsignedArgument(
          gTransferServer->arg("lengthBytes"), requestedLength) ||
      requestedLength == 0 ||
      requestedLength > kMaximumTransferRangeBytes ||
      !resolveRecording(recordingId, path, recordingSize) ||
      offsetBytes > recordingSize ||
      requestedLength > recordingSize - offsetBytes) {
    gTransferServer->send(
        416, "application/json", "{\"error\":\"invalid_range\"}");
    return;
  }
  const uint32_t lengthBytes = static_cast<uint32_t>(requestedLength);
  Serial.printf(
      "Transfer range starting: bytes=%lu free_heap=%lu "
      "largest_block=%lu\n",
      static_cast<unsigned long>(lengthBytes),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMaxAllocHeap()));

  if (storageMutex_ &&
      xSemaphoreTake(storageMutex_, pdMS_TO_TICKS(5000)) != pdTRUE) {
    gTransferServer->send(
        503, "application/json", "{\"error\":\"storage_busy\"}");
    return;
  }
  File file = storage_->open(path.c_str(), FILE_READ);
  if (!file || !file.seek(offsetBytes)) {
    if (file) file.close();
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    gTransferServer->send(
        500, "application/json", "{\"error\":\"storage_read_failed\"}");
    return;
  }

  WiFiClient client = gTransferServer->client();
  client.setNoDelay(true);
  client.printf(
      "HTTP/1.1 206 Partial Content\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Length: %lu\r\n"
      "Content-Range: bytes %llu-%llu/%llu\r\n"
      "Accept-Ranges: bytes\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n\r\n",
      static_cast<unsigned long>(lengthBytes),
      static_cast<unsigned long long>(offsetBytes),
      static_cast<unsigned long long>(offsetBytes + lengthBytes - 1),
      static_cast<unsigned long long>(recordingSize));

  std::unique_ptr<uint8_t[]> buffer(new uint8_t[kTransferBufferBytes]);
  if (!buffer) {
    file.close();
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    client.stop();
    return;
  }
  uint32_t remaining = lengthBytes;
  bool succeeded = true;
  uint32_t sdReadElapsedMs = 0;
  uint32_t wifiWriteElapsedMs = 0;
  const uint32_t transferStartedAtMs = millis();
  while (remaining > 0 && client.connected()) {
    const size_t wanted =
        remaining < kTransferBufferBytes ? remaining : kTransferBufferBytes;
    const uint32_t readStartedAtMs = millis();
    const size_t read = file.read(buffer.get(), wanted);
    sdReadElapsedMs += millis() - readStartedAtMs;
    if (read == 0) {
      succeeded = false;
      break;
    }
    size_t written = 0;
    uint32_t lastWriteAt = millis();
    const uint32_t writeStartedAtMs = millis();
    while (written < read && client.connected()) {
      const size_t count =
          client.write(buffer.get() + written, read - written);
      if (count == 0) {
        if (millis() - lastWriteAt > 15000) break;
        delay(1);
        continue;
      }
      written += count;
      lastWriteAt = millis();
    }
    wifiWriteElapsedMs += millis() - writeStartedAtMs;
    if (written != read) {
      succeeded = false;
      break;
    }
    remaining -= static_cast<uint32_t>(read);
    delay(1);
  }
  file.close();
  if (storageMutex_) xSemaphoreGive(storageMutex_);
  client.stop();
  const uint32_t measuredElapsedMs = millis() - transferStartedAtMs;
  const uint32_t elapsedMs =
      measuredElapsedMs == 0 ? 1 : measuredElapsedMs;
  const uint32_t completedBytes = lengthBytes - remaining;
  const uint32_t kibPerSecond =
      static_cast<uint32_t>(
          (static_cast<uint64_t>(completedBytes) * 1000ULL) /
          elapsedMs / 1024ULL);
  Serial.printf(
      "Transfer range: recording=%s offset=%llu bytes=%lu elapsed_ms=%lu "
      "sd_read_ms=%lu wifi_write_ms=%lu speed_kib_s=%lu channel=%u "
      "free_heap=%lu min_free_heap=%lu result=%s\n",
      recordingId.c_str(),
      static_cast<unsigned long long>(offsetBytes),
      static_cast<unsigned long>(lengthBytes),
      static_cast<unsigned long>(elapsedMs),
      static_cast<unsigned long>(sdReadElapsedMs),
      static_cast<unsigned long>(wifiWriteElapsedMs),
      static_cast<unsigned long>(kibPerSecond),
      static_cast<unsigned int>(gTransferApChannel),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      succeeded && remaining == 0 ? "complete" : "interrupted");
}

void NearNestConnectivity::releaseRecording(const String &recordingId) {
  String recordingPath;
  uint64_t recordingSizeBytes = 0;
  if (!resolveRecording(recordingId, recordingPath, recordingSizeBytes)) {
    publishError("recording.release_mismatch", "Recording is unavailable");
    return;
  }
  // The app sends this only after the backend confirms multipart completion.
  // Removal is recoverable until this explicit acknowledgement.
  if (!storage_) {
    publishError("recording.release_failed", "Storage is unavailable");
    return;
  }
#if NEARNEST_RETAIN_RECORDINGS_AFTER_RELEASE
  Serial.printf(
      "Recording retained for transfer test: recording=%s path=%s "
      "bytes=%llu\n",
      recordingId.c_str(),
      recordingPath.c_str(),
      static_cast<unsigned long long>(recordingSizeBytes));
  publishStatus(
      String("{\"event\":\"recording.released\",\"recordingId\":\"") +
      jsonString(recordingId) + "\",\"retained\":true}");
  return;
#else
  if (storageMutex_ &&
      xSemaphoreTake(storageMutex_, pdMS_TO_TICKS(5000)) != pdTRUE) {
    publishError("recording.release_busy", "Storage is busy");
    return;
  }
  const bool removed = storage_->remove(recordingPath);
  if (storageMutex_) xSemaphoreGive(storageMutex_);
  if (!removed) {
    publishError("recording.release_failed", "Could not remove recording");
    return;
  }
  if (recordingId == recordingId_) {
    recordingAvailable_ = false;
  }
  publishStatus(
      String("{\"event\":\"recording.released\",\"recordingId\":\"") +
      jsonString(recordingId) + "\"}");
#endif
}
