#include "NearNestConnectivity.h"

#include <ArduinoJson.h>
#include <Ed25519.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <SD.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <errno.h>
#include <fcntl.h>
#include <esp_rom_crc.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <lwip/sockets.h>
#include <mbedtls/base64.h>
#include <freertos/queue.h>
#include <memory>
#include <unistd.h>

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
constexpr size_t kUdpBenchmarkDatagramBytes = 1400;
constexpr size_t kUdpBenchmarkHeaderBytes = 16;
constexpr size_t kUdpBenchmarkPayloadBytes =
    kUdpBenchmarkDatagramBytes - kUdpBenchmarkHeaderBytes;
constexpr uint32_t kUdpBenchmarkMagic = 0x4e4e5542;  // "NNUB"
constexpr uint16_t kUdpBenchmarkEndFlag = 1;
// A 1,408-byte payload plus the 20-byte application header remains below the
// 1,500-byte Wi-Fi MTU. Eight payloads are exactly 22 SD sectors, keeping the
// double-buffer pipeline aligned without consuming Wi-Fi's working heap.
constexpr size_t kUdpRecordingDatagramBytes = 1428;
constexpr size_t kUdpRecordingHeaderBytes = 20;
constexpr size_t kUdpRecordingPayloadBytes =
    kUdpRecordingDatagramBytes - kUdpRecordingHeaderBytes;
constexpr size_t kUdpRecordingPipelineBlockCount = 2;
constexpr size_t kUdpRecordingReadBufferBytes =
    kUdpRecordingPayloadBytes * 8;
constexpr size_t kUdpRecordingPipelineBufferBytes =
    kUdpRecordingPipelineBlockCount * kUdpRecordingReadBufferBytes;
constexpr uint32_t kUdpRecordingMagic = 0x4e4e5552;  // "NNUR"
constexpr uint32_t kTransferApIdleTimeoutMs = 10 * 60 * 1000;
// Two 12 KB blocks are the best measured balance on this hardware: 16 KB
// blocks starved Wi-Fi pbufs, while 8 KB blocks increased SD and scheduling
// overhead. Keep the 24 KB pipeline on CPU 1.
constexpr size_t kTransferPipelineBlockBytes = 12 * 1024;
constexpr size_t kTransferPipelineBlockCount = 2;
constexpr size_t kTransferBufferBytes =
    kTransferPipelineBlockCount * kTransferPipelineBlockBytes;
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
volatile bool gUdpBenchmarkRunning = false;
volatile bool gUdpRecordingTransferRunning = false;

struct UdpBenchmarkContext {
  IPAddress address;
  uint16_t port;
  uint32_t session;
};

struct UdpRecordingContext {
  fs::FS *storage;
  SemaphoreHandle_t storageMutex;
  IPAddress address;
  String path;
  uint64_t offsetBytes;
  uint32_t lengthBytes;
  uint16_t port;
  uint32_t session;
};

void writeBigEndian16(uint8_t *destination, uint16_t value) {
  destination[0] = static_cast<uint8_t>(value >> 8);
  destination[1] = static_cast<uint8_t>(value);
}

void writeBigEndian32(uint8_t *destination, uint32_t value) {
  destination[0] = static_cast<uint8_t>(value >> 24);
  destination[1] = static_cast<uint8_t>(value >> 16);
  destination[2] = static_cast<uint8_t>(value >> 8);
  destination[3] = static_cast<uint8_t>(value);
}

uint32_t crc32(const uint8_t *data, size_t length) {
  return esp_rom_crc32_le(
      0, data, static_cast<uint32_t>(length));
}

struct UdpRecordingReadyBlock {
  uint8_t index;
  uint16_t bytes;
};

struct UdpRecordingReadContext {
  int fileDescriptor;
  uint8_t *buffer;
  QueueHandle_t freeBlocks;
  QueueHandle_t readyBlocks;
  SemaphoreHandle_t finished;
  uint32_t remainingBytes;
  volatile uint32_t sdReadElapsedMs;
  volatile bool cancelled;
  volatile bool producerDone;
  volatile bool readFailed;
};

void udpRecordingSdReaderTask(void *parameter) {
  auto *context = static_cast<UdpRecordingReadContext *>(parameter);
  while (context->remainingBytes > 0 && !context->cancelled) {
    uint8_t blockIndex = 0;
    while (!context->cancelled &&
           xQueueReceive(
               context->freeBlocks, &blockIndex,
               pdMS_TO_TICKS(50)) != pdTRUE) {
    }
    if (context->cancelled) break;

    const size_t wanted = min(
        static_cast<size_t>(context->remainingBytes),
        kUdpRecordingReadBufferBytes);
    uint8_t *block =
        context->buffer +
        static_cast<size_t>(blockIndex) * kUdpRecordingReadBufferBytes;
    size_t bytesRead = 0;
    const uint32_t readStartedAtMs = millis();
    while (bytesRead < wanted && !context->cancelled) {
      const ssize_t count = ::read(
          context->fileDescriptor, block + bytesRead,
          wanted - bytesRead);
      if (count <= 0) break;
      bytesRead += static_cast<size_t>(count);
    }
    context->sdReadElapsedMs += millis() - readStartedAtMs;
    if (bytesRead != wanted) {
      context->readFailed = true;
      break;
    }

    const UdpRecordingReadyBlock readyBlock = {
        .index = blockIndex,
        .bytes = static_cast<uint16_t>(bytesRead),
    };
    while (!context->cancelled &&
           xQueueSend(
               context->readyBlocks, &readyBlock,
               pdMS_TO_TICKS(50)) != pdTRUE) {
    }
    if (context->cancelled) break;
    context->remainingBytes -= static_cast<uint32_t>(bytesRead);
  }

  context->producerDone = true;
  xSemaphoreGive(context->finished);
  vTaskDelete(nullptr);
}

void udpRecordingTask(void *parameter) {
  std::unique_ptr<UdpRecordingContext> context(
      static_cast<UdpRecordingContext *>(parameter));
  delay(150);

  bool storageLocked = false;
  int fileDescriptor = -1;
  int udpSocket = -1;
  std::unique_ptr<uint8_t[]> readBuffer(
      new uint8_t[kUdpRecordingPipelineBufferBytes]);
  QueueHandle_t freeBlocks = nullptr;
  QueueHandle_t readyBlocks = nullptr;
  SemaphoreHandle_t readerFinished = nullptr;
  TaskHandle_t readerTask = nullptr;
  uint8_t packet[kUdpRecordingDatagramBytes] = {};
  uint32_t sequence = 0;
  uint32_t remaining = context->lengthBytes;
  uint32_t sentBytes = 0;
  uint32_t failedDatagrams = 0;
  uint32_t consumerWaitElapsedMs = 0;
  bool succeeded = false;
  const uint32_t startedAtMs = millis();

  if (readBuffer &&
      (!context->storageMutex ||
       (storageLocked =
            xSemaphoreTake(
                context->storageMutex, pdMS_TO_TICKS(5000)) == pdTRUE))) {
    char vfsPath[256] = {};
    snprintf(
        vfsPath, sizeof(vfsPath), "/sd%s", context->path.c_str());
    fileDescriptor = ::open(vfsPath, O_RDONLY);
    if (fileDescriptor >= 0 &&
        ::lseek(
            fileDescriptor, static_cast<off_t>(context->offsetBytes),
            SEEK_SET) >= 0) {
      udpSocket = lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
      freeBlocks = xQueueCreate(
          kUdpRecordingPipelineBlockCount, sizeof(uint8_t));
      readyBlocks = xQueueCreate(
          kUdpRecordingPipelineBlockCount,
          sizeof(UdpRecordingReadyBlock));
      readerFinished = xSemaphoreCreateBinary();
    }
  }

  UdpRecordingReadContext readContext = {
      .fileDescriptor = fileDescriptor,
      .buffer = readBuffer.get(),
      .freeBlocks = freeBlocks,
      .readyBlocks = readyBlocks,
      .finished = readerFinished,
      .remainingBytes = context->lengthBytes,
      .sdReadElapsedMs = 0,
      .cancelled = false,
      .producerDone = false,
      .readFailed = false,
  };
  if (udpSocket >= 0 && freeBlocks && readyBlocks && readerFinished) {
    for (uint8_t blockIndex = 0;
         blockIndex < kUdpRecordingPipelineBlockCount; ++blockIndex) {
      xQueueSend(freeBlocks, &blockIndex, 0);
    }
    if (xTaskCreatePinnedToCore(
            udpRecordingSdReaderTask, "udp-sd-reader", 3072,
            &readContext, 3, &readerTask, 1) != pdPASS) {
      readerTask = nullptr;
    }
  }

  sockaddr_in destination = {};
  destination.sin_family = AF_INET;
  destination.sin_port = htons(context->port);
  destination.sin_addr.s_addr =
      static_cast<uint32_t>(context->address);
  writeBigEndian32(packet, kUdpRecordingMagic);
  writeBigEndian32(packet + 4, context->session);

  while (udpSocket >= 0 && readerTask && remaining > 0 &&
         gTransferApActive &&
         millis() - startedAtMs < 120000) {
    UdpRecordingReadyBlock readyBlock {};
    const uint32_t waitStartedAtMs = millis();
    const BaseType_t received = xQueueReceive(
        readyBlocks, &readyBlock, pdMS_TO_TICKS(1000));
    consumerWaitElapsedMs += millis() - waitStartedAtMs;
    if (received != pdTRUE) {
      if (readContext.producerDone) break;
      continue;
    }

    uint8_t *block =
        readBuffer.get() +
        static_cast<size_t>(readyBlock.index) *
            kUdpRecordingReadBufferBytes;
    size_t blockOffset = 0;
    while (blockOffset < readyBlock.bytes && gTransferApActive) {
      const uint16_t payloadBytes = static_cast<uint16_t>(
          min(
              kUdpRecordingPayloadBytes,
              static_cast<size_t>(readyBlock.bytes) - blockOffset));
      memcpy(
          packet + kUdpRecordingHeaderBytes,
          block + blockOffset,
          payloadBytes);
      writeBigEndian32(packet + 8, sequence);
      writeBigEndian16(packet + 12, payloadBytes);
      writeBigEndian16(packet + 14, 0);
      writeBigEndian32(
          packet + 16,
          crc32(packet + kUdpRecordingHeaderBytes, payloadBytes));
      const size_t datagramBytes =
          kUdpRecordingHeaderBytes + payloadBytes;
      const ssize_t written = lwip_sendto(
          udpSocket, packet, datagramBytes, 0,
          reinterpret_cast<const sockaddr *>(&destination),
          sizeof(destination));
      if (written != static_cast<ssize_t>(datagramBytes)) {
        ++failedDatagrams;
        delay(1);
        continue;
      }
      blockOffset += payloadBytes;
      remaining -= payloadBytes;
      sentBytes += payloadBytes;
      ++sequence;
      // taskYIELD() only offers the core to another ready task at the same
      // priority. Block briefly so the idle task can service the watchdog
      // during sustained multi-megabyte transfers.
      if ((sequence & 255U) == 0) vTaskDelay(pdMS_TO_TICKS(1));
    }
    xQueueSend(freeBlocks, &readyBlock.index, 0);
  }

  if (readerTask) {
    readContext.cancelled = true;
    xSemaphoreTake(readerFinished, portMAX_DELAY);
  }

  if (udpSocket >= 0) {
    writeBigEndian32(packet + 8, sequence);
    writeBigEndian16(packet + 12, 0);
    writeBigEndian16(packet + 14, kUdpBenchmarkEndFlag);
    writeBigEndian32(packet + 16, 0);
    for (uint8_t repeat = 0; repeat < 8 && gTransferApActive; ++repeat) {
      lwip_sendto(
          udpSocket, packet, kUdpRecordingHeaderBytes, 0,
          reinterpret_cast<const sockaddr *>(&destination),
          sizeof(destination));
      delay(2);
    }
    lwip_close(udpSocket);
  }
  if (fileDescriptor >= 0) ::close(fileDescriptor);
  if (storageLocked) xSemaphoreGive(context->storageMutex);
  succeeded = remaining == 0;

  const uint32_t elapsedMs =
      max(static_cast<uint32_t>(1), millis() - startedAtMs);
  Serial.printf(
      "UDP recording range: offset=%llu bytes=%lu datagrams=%lu "
      "elapsed_ms=%lu sd_read_ms=%lu consumer_wait_ms=%lu "
      "speed_kib_s=%lu failed_datagrams=%lu "
      "free_heap=%lu min_free_heap=%lu result=%s\n",
      static_cast<unsigned long long>(context->offsetBytes),
      static_cast<unsigned long>(sentBytes),
      static_cast<unsigned long>(sequence),
      static_cast<unsigned long>(elapsedMs),
      static_cast<unsigned long>(readContext.sdReadElapsedMs),
      static_cast<unsigned long>(consumerWaitElapsedMs),
      static_cast<unsigned long>(
          static_cast<uint64_t>(sentBytes) * 1000ULL / elapsedMs / 1024ULL),
      static_cast<unsigned long>(failedDatagrams),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      succeeded ? "complete" : "interrupted");
  gTransferLastActivityMs = millis();
  gUdpRecordingTransferRunning = false;
  if (freeBlocks) vQueueDelete(freeBlocks);
  if (readyBlocks) vQueueDelete(readyBlocks);
  if (readerFinished) vSemaphoreDelete(readerFinished);
  readBuffer.reset();
  context.reset();
  vTaskDelete(nullptr);
}

void udpBenchmarkTask(void *parameter) {
  std::unique_ptr<UdpBenchmarkContext> context(
      static_cast<UdpBenchmarkContext *>(parameter));
  delay(150);

  const int udpSocket = lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (udpSocket < 0) {
    Serial.printf(
        "UDP RAM benchmark sender: socket_failed errno=%d\n", errno);
    gUdpBenchmarkRunning = false;
    context.reset();
    vTaskDelete(nullptr);
    return;
  }
  sockaddr_in destination = {};
  destination.sin_family = AF_INET;
  destination.sin_port = htons(context->port);
  destination.sin_addr.s_addr =
      static_cast<uint32_t>(context->address);
  uint8_t packet[kUdpBenchmarkDatagramBytes] = {};
  writeBigEndian32(packet, kUdpBenchmarkMagic);
  writeBigEndian32(packet + 4, context->session);
  for (size_t index = kUdpBenchmarkHeaderBytes;
       index < sizeof(packet); ++index) {
    packet[index] = static_cast<uint8_t>((index * 31U + 17U) & 0xffU);
  }

  uint32_t sequence = 0;
  uint32_t remaining = kNetworkBenchmarkBytes;
  uint32_t sentBytes = 0;
  uint32_t failedDatagrams = 0;
  const uint32_t startedAtMs = millis();
  while (remaining > 0 && gTransferApActive &&
         millis() - startedAtMs < 60000) {
    const uint16_t payloadBytes = static_cast<uint16_t>(
        min(static_cast<uint32_t>(kUdpBenchmarkPayloadBytes), remaining));
    writeBigEndian32(packet + 8, sequence);
    writeBigEndian16(packet + 12, payloadBytes);
    writeBigEndian16(packet + 14, 0);
    const size_t datagramBytes =
        kUdpBenchmarkHeaderBytes + payloadBytes;
    const ssize_t written = lwip_sendto(
        udpSocket, packet, datagramBytes, 0,
        reinterpret_cast<const sockaddr *>(&destination),
        sizeof(destination));
    const bool sent = written == static_cast<ssize_t>(datagramBytes);
    if (sent) {
      remaining -= payloadBytes;
      sentBytes += payloadBytes;
      ++sequence;
    } else {
      ++failedDatagrams;
      delay(1);
    }
    if ((sequence & 15U) == 0) vTaskDelay(pdMS_TO_TICKS(1));
  }

  writeBigEndian32(packet + 8, sequence);
  writeBigEndian16(packet + 12, 0);
  writeBigEndian16(packet + 14, kUdpBenchmarkEndFlag);
  for (uint8_t repeat = 0; repeat < 8 && gTransferApActive; ++repeat) {
    lwip_sendto(
        udpSocket, packet, kUdpBenchmarkHeaderBytes, 0,
        reinterpret_cast<const sockaddr *>(&destination),
        sizeof(destination));
    delay(2);
  }
  lwip_close(udpSocket);

  const uint32_t elapsedMs =
      max(static_cast<uint32_t>(1), millis() - startedAtMs);
  const uint32_t kibPerSecond = static_cast<uint32_t>(
      static_cast<uint64_t>(sentBytes) * 1000ULL / elapsedMs / 1024ULL);
  Serial.printf(
      "UDP RAM benchmark sender: bytes=%lu datagrams=%lu elapsed_ms=%lu "
      "speed_kib_s=%lu failed_datagrams=%lu channel=%u free_heap=%lu "
      "min_free_heap=%lu result=%s\n",
      static_cast<unsigned long>(sentBytes),
      static_cast<unsigned long>(sequence),
      static_cast<unsigned long>(elapsedMs),
      static_cast<unsigned long>(kibPerSecond),
      static_cast<unsigned long>(failedDatagrams),
      static_cast<unsigned int>(gTransferApChannel),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      remaining == 0 ? "complete" : "interrupted");
  gTransferLastActivityMs = millis();
  gUdpBenchmarkRunning = false;
  context.reset();
  vTaskDelete(nullptr);
}

struct TransferReadyBlock {
  uint8_t index;
  uint16_t bytes;
};

struct TransferReadContext {
  File *file;
  uint8_t *buffer;
  QueueHandle_t freeBlocks;
  QueueHandle_t readyBlocks;
  SemaphoreHandle_t finished;
  uint32_t remainingBytes;
  volatile uint32_t sdReadElapsedMs;
  uint32_t freeBlockWaitElapsedMs;
  uint32_t blocksRead;
  volatile bool cancelled;
  volatile bool producerDone;
  volatile bool readFailed;
};

void transferSdReaderTask(void *parameter) {
  auto *context = static_cast<TransferReadContext *>(parameter);
  while (context->remainingBytes > 0 && !context->cancelled) {
    uint8_t blockIndex = 0;
    const uint32_t freeBlockWaitStartedAtMs = millis();
    while (!context->cancelled &&
           xQueueReceive(
               context->freeBlocks, &blockIndex, pdMS_TO_TICKS(50)) !=
               pdTRUE) {
    }
    context->freeBlockWaitElapsedMs +=
        millis() - freeBlockWaitStartedAtMs;
    if (context->cancelled) break;

    const size_t wanted =
        min(
            static_cast<size_t>(context->remainingBytes),
            kTransferPipelineBlockBytes);
    const uint32_t readStartedAtMs = millis();
    const size_t bytesRead = context->file->read(
        context->buffer +
            static_cast<size_t>(blockIndex) * kTransferPipelineBlockBytes,
        wanted);
    context->sdReadElapsedMs += millis() - readStartedAtMs;
    if (bytesRead == 0) {
      context->readFailed = true;
      break;
    }

    const TransferReadyBlock readyBlock = {
        .index = blockIndex,
        .bytes = static_cast<uint16_t>(bytesRead),
    };
    bool queued = false;
    while (!context->cancelled) {
      if (xQueueSend(
              context->readyBlocks, &readyBlock, pdMS_TO_TICKS(50)) ==
          pdTRUE) {
        queued = true;
        break;
      }
    }
    if (!queued) break;
    context->remainingBytes -= static_cast<uint32_t>(bytesRead);
    ++context->blocksRead;
  }

  context->producerDone = true;
  xSemaphoreGive(context->finished);
  vTaskDelete(nullptr);
}

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

bool hasWaveHeader(File &file) {
  if (!file || file.isDirectory() || file.size() <= 44) return false;

  const size_t originalPosition = file.position();
  uint8_t header[12] = {};
  const bool readHeader =
      file.seek(0) && file.read(header, sizeof(header)) == sizeof(header);
  file.seek(originalPosition);

  return readHeader && header[0] == 'R' && header[1] == 'I' &&
         header[2] == 'F' && header[3] == 'F' && header[8] == 'W' &&
         header[9] == 'A' && header[10] == 'V' && header[11] == 'E';
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
        if (isWaveFileName(fileName) && hasWaveHeader(entry) &&
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
  const bool validWave = hasWaveHeader(file);
  file.close();
  if (storageMutex_) xSemaphoreGive(storageMutex_);
  return validWave;
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

  // HT40 was slower in real phone tests because the wider 2.4 GHz channel
  // collected substantially more interference. Keep the AP on HT20; it
  // delivered the higher and more stable RAM benchmark on this hardware.
  const wifi_second_chan_t requestedSecondaryChannel =
      WIFI_SECOND_CHAN_NONE;
  const bool bandwidthConfigured = WiFi.softAPbandwidth(WIFI_BW_HT20);
  const int channelConfigured =
      WiFi.setChannel(gTransferApChannel, requestedSecondaryChannel);
  wifi_bandwidth_t actualBandwidth = WIFI_BW_HT20;
  uint8_t actualPrimaryChannel = 0;
  wifi_second_chan_t actualSecondaryChannel = WIFI_SECOND_CHAN_NONE;
  const esp_err_t bandwidthReadResult =
      esp_wifi_get_bandwidth(WIFI_IF_AP, &actualBandwidth);
  const esp_err_t channelReadResult =
      esp_wifi_get_channel(
          &actualPrimaryChannel, &actualSecondaryChannel);
  Serial.printf(
      "Transfer AP radio: requested=HT20 configured=%s "
      "channel_result=%d actual_bw=%s primary=%u secondary=%d "
      "read_ok=%s\n",
      bandwidthConfigured ? "true" : "false",
      channelConfigured,
      bandwidthReadResult == ESP_OK && actualBandwidth == WIFI_BW_HT20
          ? "HT20"
          : "HT40",
      static_cast<unsigned int>(actualPrimaryChannel),
      static_cast<int>(actualSecondaryChannel),
      bandwidthReadResult == ESP_OK && channelReadResult == ESP_OK
          ? "true"
          : "false");

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
      "/v1/benchmark/udp", HTTP_GET,
      [this]() { startUdpNetworkBenchmark(); });
  gTransferServer->on(
      "/v1/recording/udp", HTTP_GET,
      [this]() { startUdpRecordingTransfer(); });
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
    // stays paused until the transfer AP stops.
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

  // Advertising alone can preempt the shared 2.4 GHz radio. Pause it while
  // measuring so the result reflects Wi-Fi throughput.
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

void NearNestConnectivity::startUdpNetworkBenchmark() {
  gTransferLastActivityMs = millis();
  if (!gTransferServer ||
      gTransferServer->header(kTransferTokenHeader) != gTransferToken) {
    if (gTransferServer) {
      gTransferServer->send(
          401, "application/json", "{\"error\":\"unauthorized\"}");
    }
    return;
  }
  const long requestedPort = gTransferServer->arg("port").toInt();
  if (requestedPort < 1024 || requestedPort > 65535) {
    gTransferServer->send(
        400, "application/json", "{\"error\":\"invalid_port\"}");
    return;
  }
  if (gUdpBenchmarkRunning) {
    gTransferServer->send(
        409, "application/json", "{\"error\":\"benchmark_running\"}");
    return;
  }

  std::unique_ptr<UdpBenchmarkContext> context(new UdpBenchmarkContext{
      .address = gTransferServer->client().remoteIP(),
      .port = static_cast<uint16_t>(requestedPort),
      .session = esp_random(),
  });
  if (!context) {
    gTransferServer->send(
        503, "application/json", "{\"error\":\"insufficient_memory\"}");
    return;
  }
  const uint32_t packetCount =
      (kNetworkBenchmarkBytes + kUdpBenchmarkPayloadBytes - 1) /
      kUdpBenchmarkPayloadBytes;
  gUdpBenchmarkRunning = true;
  const uint32_t session = context->session;
  if (xTaskCreatePinnedToCore(
          udpBenchmarkTask, "udp-benchmark", 4096, context.get(), 2,
          nullptr, 1) != pdPASS) {
    gUdpBenchmarkRunning = false;
    gTransferServer->send(
        503, "application/json", "{\"error\":\"task_unavailable\"}");
    return;
  }
  context.release();
  gTransferServer->send(
      202, "application/json",
      String("{\"bytes\":") + String(kNetworkBenchmarkBytes) +
          ",\"payloadBytes\":" + String(kUdpBenchmarkPayloadBytes) +
          ",\"packets\":" + String(packetCount) +
          ",\"session\":" + String(session) + "}");
}

void NearNestConnectivity::startUdpRecordingTransfer() {
  gTransferLastActivityMs = millis();
  if (!gTransferServer ||
      gTransferServer->header(kTransferTokenHeader) != gTransferToken) {
    if (gTransferServer) {
      gTransferServer->send(
          401, "application/json", "{\"error\":\"unauthorized\"}");
    }
    return;
  }
  const long requestedPort = gTransferServer->arg("port").toInt();
  const String recordingId = gTransferServer->arg("recordingId");
  uint64_t offsetBytes = 0;
  uint64_t requestedLength = 0;
  uint64_t recordingSize = 0;
  String path;
  if (requestedPort < 1024 || requestedPort > 65535 ||
      !parseUnsignedArgument(
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
  if (gUdpRecordingTransferRunning) {
    gTransferServer->send(
        409, "application/json", "{\"error\":\"transfer_running\"}");
    return;
  }

  std::unique_ptr<UdpRecordingContext> context(new UdpRecordingContext{
      .storage = storage_,
      .storageMutex = storageMutex_,
      .address = gTransferServer->client().remoteIP(),
      .path = path,
      .offsetBytes = offsetBytes,
      .lengthBytes = static_cast<uint32_t>(requestedLength),
      .port = static_cast<uint16_t>(requestedPort),
      .session = esp_random(),
  });
  if (!context) {
    gTransferServer->send(
        503, "application/json", "{\"error\":\"insufficient_memory\"}");
    return;
  }
  const uint32_t packetCount =
      (requestedLength + kUdpRecordingPayloadBytes - 1) /
      kUdpRecordingPayloadBytes;
  const uint32_t session = context->session;
  gUdpRecordingTransferRunning = true;
  if (xTaskCreatePinnedToCore(
          udpRecordingTask, "udp-recording", 4096, context.get(), 2,
          nullptr, 0) != pdPASS) {
    gUdpRecordingTransferRunning = false;
    gTransferServer->send(
        503, "application/json", "{\"error\":\"task_unavailable\"}");
    return;
  }
  context.release();
  gTransferServer->send(
      202, "application/json",
      String("{\"bytes\":") +
          String(static_cast<unsigned long>(requestedLength)) +
          ",\"payloadBytes\":" + String(kUdpRecordingPayloadBytes) +
          ",\"packets\":" + String(packetCount) +
          ",\"session\":" + String(session) + "}");
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

  std::unique_ptr<uint8_t[]> buffer(new uint8_t[kTransferBufferBytes]);
  QueueHandle_t freeBlocks =
      xQueueCreate(kTransferPipelineBlockCount, sizeof(uint8_t));
  QueueHandle_t readyBlocks =
      xQueueCreate(kTransferPipelineBlockCount, sizeof(TransferReadyBlock));
  SemaphoreHandle_t readerFinished = xSemaphoreCreateBinary();
  if (!buffer || !freeBlocks || !readyBlocks || !readerFinished) {
    if (freeBlocks) vQueueDelete(freeBlocks);
    if (readyBlocks) vQueueDelete(readyBlocks);
    if (readerFinished) vSemaphoreDelete(readerFinished);
    file.close();
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    gTransferServer->send(
        503, "application/json", "{\"error\":\"transfer_memory\"}");
    return;
  }

  for (uint8_t blockIndex = 0;
       blockIndex < kTransferPipelineBlockCount; ++blockIndex) {
    xQueueSend(freeBlocks, &blockIndex, 0);
  }
  TransferReadContext readContext = {
      .file = &file,
      .buffer = buffer.get(),
      .freeBlocks = freeBlocks,
      .readyBlocks = readyBlocks,
      .finished = readerFinished,
      .remainingBytes = lengthBytes,
      .sdReadElapsedMs = 0,
      .freeBlockWaitElapsedMs = 0,
      .blocksRead = 0,
      .cancelled = false,
      .producerDone = false,
      .readFailed = false,
  };
  TaskHandle_t readerTask = nullptr;
  if (xTaskCreatePinnedToCore(
          transferSdReaderTask,
          "transferSdReader",
          3072,
          &readContext,
          2,
          &readerTask,
          1) != pdPASS) {
    vQueueDelete(freeBlocks);
    vQueueDelete(readyBlocks);
    vSemaphoreDelete(readerFinished);
    file.close();
    if (storageMutex_) xSemaphoreGive(storageMutex_);
    gTransferServer->send(
        503, "application/json", "{\"error\":\"transfer_task\"}");
    return;
  }

  // Pause BLE advertising only while bytes are flowing. It resumes between
  // HTTP ranges so the app can reconnect and send transfer.ap.stop after it
  // leaves the temporary Wi-Fi network.
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  const bool resumeAdvertising =
      advertising && advertising->isAdvertising();
  if (resumeAdvertising) advertising->stop();
  delay(20);

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

  uint32_t remaining = lengthBytes;
  bool succeeded = true;
  uint32_t wifiWriteElapsedMs = 0;
  uint32_t pipelineWaitElapsedMs = 0;
  const uint32_t transferStartedAtMs = millis();
  while (remaining > 0 && client.connected()) {
    TransferReadyBlock readyBlock {};
    const uint32_t waitStartedAtMs = millis();
    const BaseType_t received = xQueueReceive(
        readyBlocks, &readyBlock, pdMS_TO_TICKS(1000));
    pipelineWaitElapsedMs += millis() - waitStartedAtMs;
    if (received != pdTRUE) {
      if (readContext.producerDone) {
        succeeded = false;
        break;
      }
      continue;
    }

    uint8_t *block =
        buffer.get() +
        static_cast<size_t>(readyBlock.index) * kTransferPipelineBlockBytes;
    size_t written = 0;
    uint32_t lastWriteAt = millis();
    const uint32_t writeStartedAtMs = millis();
    while (written < readyBlock.bytes && client.connected()) {
      const size_t count =
          client.write(block + written, readyBlock.bytes - written);
      if (count == 0) {
        if (millis() - lastWriteAt > 15000) break;
        delay(1);
        continue;
      }
      written += count;
      lastWriteAt = millis();
    }
    wifiWriteElapsedMs += millis() - writeStartedAtMs;
    if (written != readyBlock.bytes) {
      succeeded = false;
      break;
    }
    remaining -= static_cast<uint32_t>(readyBlock.bytes);
    xQueueSend(freeBlocks, &readyBlock.index, 0);
  }

  readContext.cancelled = true;
  xSemaphoreTake(readerFinished, portMAX_DELAY);
  succeeded =
      succeeded && !readContext.readFailed && remaining == 0;
  const uint32_t sdReadElapsedMs = readContext.sdReadElapsedMs;
  const uint32_t producerWaitElapsedMs =
      readContext.freeBlockWaitElapsedMs;
  const uint32_t blocksRead = readContext.blocksRead;
  file.close();
  if (storageMutex_) xSemaphoreGive(storageMutex_);
  client.stop();
  if (resumeAdvertising) advertising->start();
  vQueueDelete(freeBlocks);
  vQueueDelete(readyBlocks);
  vSemaphoreDelete(readerFinished);
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
      "sd_read_ms=%lu wifi_write_ms=%lu consumer_wait_ms=%lu "
      "producer_wait_ms=%lu blocks=%lu "
      "speed_kib_s=%lu channel=%u free_heap=%lu min_free_heap=%lu "
      "result=%s\n",
      recordingId.c_str(),
      static_cast<unsigned long long>(offsetBytes),
      static_cast<unsigned long>(lengthBytes),
      static_cast<unsigned long>(elapsedMs),
      static_cast<unsigned long>(sdReadElapsedMs),
      static_cast<unsigned long>(wifiWriteElapsedMs),
      static_cast<unsigned long>(pipelineWaitElapsedMs),
      static_cast<unsigned long>(producerWaitElapsedMs),
      static_cast<unsigned long>(blocksRead),
      static_cast<unsigned long>(kibPerSecond),
      static_cast<unsigned int>(gTransferApChannel),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(ESP.getMinFreeHeap()),
      succeeded ? "complete" : "interrupted");
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
