package com.nearnestmobile

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.CRC32
import kotlin.math.max
import kotlin.math.min
import org.json.JSONObject

class NearNestLocalTransferModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val connectivityManager =
    context.getSystemService(ConnectivityManager::class.java)
  private val executor = Executors.newSingleThreadExecutor()
  private val cancellationGeneration = AtomicLong(0)
  private val cacheRoot = File(context.cacheDir, "nearnest-transfer")

  @Volatile private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun getName(): String = "NearNestLocalTransfer"

  @ReactMethod
  fun connectToHotspot(ssid: String, password: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.reject(
        "wifi.unsupported",
        "NearNest hotspot transfer requires Android 10 or newer",
      )
      return
    }
    if (ssid.isBlank() || password.length !in 8..63) {
      promise.reject("wifi.invalid_credentials", "Invalid hotspot credentials")
      return
    }

    disconnectInternal()
    val specifier =
      WifiNetworkSpecifier.Builder()
        .setSsid(ssid)
        .setWpa2Passphrase(password)
        .build()
    val request =
      NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .setNetworkSpecifier(specifier)
        .build()
    var settled = false
    val callback =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          if (settled || networkCallback !== this) return
          settled = true
          if (!connectivityManager.bindProcessToNetwork(network)) {
            disconnectInternal()
            promise.reject(
              "wifi.bind_failed",
              "Android could not route the transfer through the NearNest hotspot",
            )
            return
          }
          promise.resolve(null)
        }

        override fun onUnavailable() {
          if (settled || networkCallback !== this) return
          settled = true
          disconnectInternal()
          promise.reject(
            "wifi.unavailable",
            "Could not connect to the NearNest transfer hotspot",
          )
        }

        override fun onLost(network: Network) {
          connectivityManager.bindProcessToNetwork(null)
        }
      }
    networkCallback = callback
    try {
      connectivityManager.requestNetwork(request, callback, 30_000)
    } catch (error: Exception) {
      networkCallback = null
      promise.reject("wifi.request_failed", error.message, error)
    }
  }

  @ReactMethod
  fun disconnectFromHotspot(promise: Promise) {
    cancellationGeneration.incrementAndGet()
    disconnectInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun getAvailableCacheBytes(promise: Promise) {
    if (!cacheRoot.exists()) cacheRoot.mkdirs()
    promise.resolve(cacheRoot.usableSpace.toDouble())
  }

  @ReactMethod
  fun waitForInternet(promise: Promise) {
    val active = connectivityManager.activeNetwork
    val capabilities = connectivityManager.getNetworkCapabilities(active)
    if (capabilities?.hasCapability(
        NetworkCapabilities.NET_CAPABILITY_VALIDATED,
      ) == true) {
      promise.resolve(null)
      return
    }
    val request =
      NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()
    var settled = false
    fun resolveIfValidated(
      callback: ConnectivityManager.NetworkCallback,
      network: Network,
    ) {
      if (settled) return
      val current =
        connectivityManager.getNetworkCapabilities(network) ?: return
      if (!current.hasCapability(
          NetworkCapabilities.NET_CAPABILITY_VALIDATED,
        )) return
      settled = true
      try {
        connectivityManager.unregisterNetworkCallback(callback)
      } catch (_: Exception) {
      }
      promise.resolve(null)
    }
    val callback =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          resolveIfValidated(this, network)
        }

        override fun onCapabilitiesChanged(
          network: Network,
          networkCapabilities: NetworkCapabilities,
        ) {
          resolveIfValidated(this, network)
        }

        override fun onUnavailable() {
          if (settled) return
          settled = true
          promise.reject(
            "network.unavailable",
            "The phone did not regain internet access after leaving the wearable hotspot",
          )
        }
      }
    try {
      connectivityManager.requestNetwork(request, callback, 30_000)
    } catch (error: Exception) {
      promise.reject("network.request_failed", error.message, error)
    }
  }

  @ReactMethod
  fun getCachedPart(cacheKey: String, expectedBytes: Double, promise: Promise) {
    val file = cacheFile(cacheKey)
    if (file == null) {
      promise.reject("cache.invalid_key", "Invalid transfer cache key")
      return
    }
    val expected = expectedBytes.toLong()
    promise.resolve(
      if (file.isFile && file.length() == expected) file.absolutePath else null,
    )
  }

  @ReactMethod
  fun benchmarkDownload(
    url: String,
    token: String,
    expectedBytes: Double,
    promise: Promise,
  ) {
    val expected = expectedBytes.toLong()
    if (expected <= 0) {
      promise.reject("benchmark.invalid_request", "Invalid benchmark size")
      return
    }
    val generation = cancellationGeneration.get()
    executor.execute {
      var connection: HttpURLConnection? = null
      try {
        connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = "GET"
        connection.setRequestProperty("X-NearNest-Transfer-Token", token)
        connection.connect()
        if (connection.responseCode != HttpURLConnection.HTTP_OK) {
          throw IllegalStateException(
            "Wearable benchmark returned HTTP ${connection.responseCode}",
          )
        }

        var received = 0L
        val startedAtNanos = System.nanoTime()
        BufferedInputStream(connection.inputStream, 64 * 1024).use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            ensureNotCancelled(generation)
            val count = input.read(buffer)
            if (count < 0) break
            received += count
          }
        }
        val elapsedMs =
          max(1L, (System.nanoTime() - startedAtNanos) / 1_000_000L)
        if (received != expected) {
          throw IllegalStateException(
            "Wearable benchmark sent $received bytes; expected $expected",
          )
        }
        val result = Arguments.createMap()
        result.putDouble("bytes", received.toDouble())
        result.putDouble("elapsedMs", elapsedMs.toDouble())
        result.putDouble(
          "bytesPerSecond",
          received.toDouble() * 1000.0 / elapsedMs.toDouble(),
        )
        promise.resolve(result)
      } catch (error: Exception) {
        promise.reject("benchmark.failed", error.message, error)
      } finally {
        connection?.disconnect()
      }
    }
  }

  @ReactMethod
  fun benchmarkUdp(
    url: String,
    token: String,
    expectedBytes: Double,
    promise: Promise,
  ) {
    val expected = expectedBytes.toLong()
    if (expected <= 0) {
      promise.reject("benchmark.invalid_request", "Invalid UDP benchmark size")
      return
    }
    val generation = cancellationGeneration.get()
    executor.execute {
      var socket: DatagramSocket? = null
      var connection: HttpURLConnection? = null
      try {
        socket = DatagramSocket(0)
        socket.receiveBufferSize = 1024 * 1024
        socket.soTimeout = 250

        val separator = if (url.contains("?")) "&" else "?"
        connection =
          URL("$url${separator}port=${socket.localPort}")
            .openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 15_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = "GET"
        connection.setRequestProperty("X-NearNest-Transfer-Token", token)
        connection.connect()
        if (connection.responseCode != HttpURLConnection.HTTP_ACCEPTED) {
          throw IllegalStateException(
            "Wearable UDP benchmark returned HTTP ${connection.responseCode}",
          )
        }
        val configuration =
          JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        val session = configuration.getLong("session")
        val packetsExpected = configuration.getInt("packets")
        val configuredBytes = configuration.getLong("bytes")
        if (configuredBytes != expected || packetsExpected <= 0) {
          throw IllegalStateException("Wearable returned an invalid UDP benchmark configuration")
        }

        val seen = BooleanArray(packetsExpected)
        val buffer = ByteArray(2048)
        val datagram = DatagramPacket(buffer, buffer.size)
        var packetsReceived = 0
        var receivedBytes = 0L
        var duplicates = 0
        var outOfOrder = 0
        var highestSequence = -1
        var firstPacketAtNanos = 0L
        var lastPacketAtNanos = 0L
        var endReceivedAtNanos = 0L
        val deadline = System.nanoTime() + 60_000_000_000L

        while (System.nanoTime() < deadline) {
          ensureNotCancelled(generation)
          datagram.length = buffer.size
          try {
            socket.receive(datagram)
          } catch (_: SocketTimeoutException) {
            if (endReceivedAtNanos > 0 &&
                System.nanoTime() - endReceivedAtNanos >= 500_000_000L) {
              break
            }
            continue
          }
          if (datagram.length < 16) continue
          val header =
            ByteBuffer.wrap(datagram.data, datagram.offset, 16)
              .order(ByteOrder.BIG_ENDIAN)
          val magic = header.int
          val packetSession = header.int.toLong() and 0xffffffffL
          val sequence = header.int
          val payloadBytes = header.short.toInt() and 0xffff
          val flags = header.short.toInt() and 0xffff
          if (magic != 0x4e4e5542 || packetSession != session) continue
          if ((flags and 1) != 0) {
            if (endReceivedAtNanos == 0L) {
              endReceivedAtNanos = System.nanoTime()
            }
            continue
          }
          if (sequence !in 0 until packetsExpected ||
              payloadBytes <= 0 ||
              datagram.length < 16 + payloadBytes) {
            continue
          }
          val now = System.nanoTime()
          if (firstPacketAtNanos == 0L) firstPacketAtNanos = now
          lastPacketAtNanos = now
          if (seen[sequence]) {
            duplicates += 1
            continue
          }
          if (sequence < highestSequence) outOfOrder += 1
          highestSequence = max(highestSequence, sequence)
          seen[sequence] = true
          packetsReceived += 1
          receivedBytes += payloadBytes.toLong()
        }
        if (firstPacketAtNanos == 0L || endReceivedAtNanos == 0L) {
          throw IllegalStateException("Wearable UDP benchmark did not complete")
        }
        val elapsedMs =
          max(1L, (lastPacketAtNanos - firstPacketAtNanos) / 1_000_000L)
        val lost = packetsExpected - packetsReceived
        val result = Arguments.createMap()
        result.putDouble("bytes", receivedBytes.toDouble())
        result.putDouble("elapsedMs", elapsedMs.toDouble())
        result.putDouble(
          "bytesPerSecond",
          receivedBytes.toDouble() * 1000.0 / elapsedMs.toDouble(),
        )
        result.putInt("packetsExpected", packetsExpected)
        result.putInt("packetsReceived", packetsReceived)
        result.putInt("duplicates", duplicates)
        result.putInt("outOfOrder", outOfOrder)
        result.putDouble(
          "packetLossPercent",
          lost.toDouble() * 100.0 / packetsExpected.toDouble(),
        )
        promise.resolve(result)
      } catch (error: Exception) {
        promise.reject("benchmark.udp_failed", error.message, error)
      } finally {
        connection?.disconnect()
        socket?.close()
      }
    }
  }

  @ReactMethod
  fun downloadRange(
    jobId: String,
    url: String,
    token: String,
    expectedBytes: Double,
    cacheKey: String,
    promise: Promise,
  ) {
    val destination = cacheFile(cacheKey)
    val length = expectedBytes.toLong()
    if (destination == null || length <= 0) {
      promise.reject("download.invalid_request", "Invalid download request")
      return
    }
    val generation = cancellationGeneration.get()
    executor.execute {
      var connection: HttpURLConnection? = null
      val temporary = File(destination.parentFile, "${destination.name}.tmp")
      try {
        destination.parentFile?.mkdirs()
        if (destination.isFile && destination.length() == length) {
          promise.resolve(destination.absolutePath)
          return@execute
        }
        temporary.delete()
        connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = "GET"
        connection.setRequestProperty("X-NearNest-Transfer-Token", token)
        connection.connect()
        if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) {
          throw IllegalStateException(
            "Wearable returned HTTP ${connection.responseCode}",
          )
        }
        var transferred = 0L
        BufferedInputStream(connection.inputStream, 64 * 1024).use { input ->
          BufferedOutputStream(FileOutputStream(temporary), 64 * 1024).use { output ->
            val buffer = ByteArray(64 * 1024)
            var lastReported = 0L
            while (true) {
              ensureNotCancelled(generation)
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
              transferred += count
              if (transferred - lastReported >= 64 * 1024 || transferred == length) {
                emitProgress("download", jobId, transferred, length)
                lastReported = transferred
              }
            }
          }
        }
        if (transferred != length || temporary.length() != length) {
          throw IllegalStateException(
            "Wearable sent $transferred bytes; expected $length",
          )
        }
        if (destination.exists()) destination.delete()
        if (!temporary.renameTo(destination)) {
          throw IllegalStateException("Could not finalize the cached recording part")
        }
        emitProgress("download", jobId, length, length)
        promise.resolve(destination.absolutePath)
      } catch (error: Exception) {
        temporary.delete()
        promise.reject("download.failed", error.message, error)
      } finally {
        connection?.disconnect()
      }
    }
  }

  @ReactMethod
  fun downloadRangeHybridUdp(
    jobId: String,
    url: String,
    token: String,
    expectedBytes: Double,
    cacheKey: String,
    promise: Promise,
  ) {
    val destination = cacheFile(cacheKey)
    val length = expectedBytes.toLong()
    if (destination == null || length <= 0) {
      promise.reject("download.invalid_request", "Invalid UDP download request")
      return
    }
    val generation = cancellationGeneration.get()
    executor.execute {
      val temporary = File(destination.parentFile, "${destination.name}.tmp")
      var socket: DatagramSocket? = null
      var startConnection: HttpURLConnection? = null
      try {
        destination.parentFile?.mkdirs()
        if (destination.isFile && destination.length() == length) {
          val cached = Arguments.createMap()
          cached.putString("path", destination.absolutePath)
          cached.putDouble("udpBytesPerSecond", 0.0)
          cached.putInt("missingPackets", 0)
          cached.putDouble("packetLossPercent", 0.0)
          cached.putDouble("repairedBytes", 0.0)
          promise.resolve(cached)
          return@execute
        }
        temporary.delete()
        socket = DatagramSocket(0)
        socket.receiveBufferSize = 1024 * 1024
        socket.soTimeout = 250

        val requestedUri = Uri.parse(url)
        val startUri =
          requestedUri
            .buildUpon()
            .appendQueryParameter("port", socket.localPort.toString())
            .build()
        startConnection =
          URL(startUri.toString()).openConnection() as HttpURLConnection
        startConnection.connectTimeout = 15_000
        startConnection.readTimeout = 15_000
        startConnection.instanceFollowRedirects = false
        startConnection.requestMethod = "GET"
        startConnection.setRequestProperty("X-NearNest-Transfer-Token", token)
        startConnection.connect()
        if (startConnection.responseCode != HttpURLConnection.HTTP_ACCEPTED) {
          throw IllegalStateException(
            "Wearable UDP range returned HTTP ${startConnection.responseCode}",
          )
        }
        val configuration =
          JSONObject(
            startConnection.inputStream.bufferedReader().use { it.readText() },
          )
        val session = configuration.getLong("session")
        val packetsExpected = configuration.getInt("packets")
        val payloadCapacity = configuration.getInt("payloadBytes")
        if (configuration.getLong("bytes") != length ||
            packetsExpected <= 0 ||
            payloadCapacity <= 0) {
          throw IllegalStateException("Wearable returned an invalid UDP range configuration")
        }

        val seen = BooleanArray(packetsExpected)
        val packetBuffer = ByteArray(2048)
        val datagram = DatagramPacket(packetBuffer, packetBuffer.size)
        var packetsReceived = 0
        var udpBytes = 0L
        var corruptPackets = 0
        var firstPacketAtNanos = 0L
        var lastPacketAtNanos = 0L
        var endReceivedAtNanos = 0L
        val deadline = System.nanoTime() + 120_000_000_000L
        val crc = CRC32()

        RandomAccessFile(temporary, "rw").use { output ->
          output.setLength(length)
          val sequentialBuffer = ByteArray(64 * 1024)
          var sequentialBytes = 0
          var sequentialFileOffset = 0L
          var nextSequentialSequence = 0

          fun flushSequential() {
            if (sequentialBytes == 0) return
            output.seek(sequentialFileOffset)
            output.write(sequentialBuffer, 0, sequentialBytes)
            sequentialFileOffset += sequentialBytes
            sequentialBytes = 0
          }

          while (System.nanoTime() < deadline) {
            ensureNotCancelled(generation)
            datagram.length = packetBuffer.size
            try {
              socket.receive(datagram)
            } catch (_: SocketTimeoutException) {
              if (endReceivedAtNanos > 0 &&
                  System.nanoTime() - endReceivedAtNanos >= 500_000_000L) {
                break
              }
              continue
            }
            if (datagram.length < 20) continue
            val header =
              ByteBuffer.wrap(datagram.data, datagram.offset, 20)
                .order(ByteOrder.BIG_ENDIAN)
            val magic = header.int
            val packetSession = header.int.toLong() and 0xffffffffL
            val sequence = header.int
            val payloadBytes = header.short.toInt() and 0xffff
            val flags = header.short.toInt() and 0xffff
            val expectedCrc = header.int.toLong() and 0xffffffffL
            if (magic != 0x4e4e5552 || packetSession != session) continue
            if ((flags and 1) != 0) {
              if (endReceivedAtNanos == 0L) {
                endReceivedAtNanos = System.nanoTime()
              }
              continue
            }
            if (sequence !in 0 until packetsExpected ||
                payloadBytes <= 0 ||
                payloadBytes > payloadCapacity ||
                datagram.length < 20 + payloadBytes ||
                seen[sequence]) {
              continue
            }
            crc.reset()
            crc.update(datagram.data, datagram.offset + 20, payloadBytes)
            if (crc.value != expectedCrc) {
              corruptPackets += 1
              continue
            }
            val now = System.nanoTime()
            if (firstPacketAtNanos == 0L) firstPacketAtNanos = now
            lastPacketAtNanos = now
            val relativeOffset = sequence.toLong() * payloadCapacity.toLong()
            if (sequence == nextSequentialSequence &&
                relativeOffset == sequentialFileOffset + sequentialBytes) {
              if (sequentialBytes + payloadBytes > sequentialBuffer.size) {
                flushSequential()
              }
              System.arraycopy(
                datagram.data,
                datagram.offset + 20,
                sequentialBuffer,
                sequentialBytes,
                payloadBytes,
              )
              sequentialBytes += payloadBytes
              nextSequentialSequence += 1
            } else {
              flushSequential()
              output.seek(relativeOffset)
              output.write(datagram.data, datagram.offset + 20, payloadBytes)
            }
            seen[sequence] = true
            packetsReceived += 1
            udpBytes += payloadBytes.toLong()
            if (udpBytes % (64 * 1024) < payloadBytes) {
              emitProgress("download", jobId, udpBytes, length)
            }
          }
          flushSequential()
          if (firstPacketAtNanos == 0L || endReceivedAtNanos == 0L) {
            throw IllegalStateException("Wearable UDP range did not complete")
          }

          val originalOffset =
            requestedUri.getQueryParameter("offsetBytes")?.toLongOrNull()
              ?: throw IllegalStateException("UDP range offset is missing")
          val recordingId =
            requestedUri.getQueryParameter("recordingId")
              ?: throw IllegalStateException("UDP recording ID is missing")
          val repairPath =
            requestedUri.path?.removeSuffix("/udp")
              ?: throw IllegalStateException("UDP repair path is invalid")
          var repairedBytes = 0L
          var missingPackets = 0
          var sequence = 0
          while (sequence < packetsExpected) {
            if (seen[sequence]) {
              sequence += 1
              continue
            }
            val firstMissing = sequence
            while (sequence < packetsExpected && !seen[sequence]) {
              missingPackets += 1
              sequence += 1
            }
            val relativeStart =
              firstMissing.toLong() * payloadCapacity.toLong()
            val relativeEnd =
              min(
                length,
                sequence.toLong() * payloadCapacity.toLong(),
              )
            val repairLength = relativeEnd - relativeStart
            val repairUri =
              requestedUri
                .buildUpon()
                .path(repairPath)
                .clearQuery()
                .appendQueryParameter("recordingId", recordingId)
                .appendQueryParameter(
                  "offsetBytes",
                  (originalOffset + relativeStart).toString(),
                )
                .appendQueryParameter("lengthBytes", repairLength.toString())
                .build()
            var repairConnection: HttpURLConnection? = null
            try {
              repairConnection =
                URL(repairUri.toString()).openConnection() as HttpURLConnection
              repairConnection.connectTimeout = 15_000
              repairConnection.readTimeout = 30_000
              repairConnection.instanceFollowRedirects = false
              repairConnection.requestMethod = "GET"
              repairConnection.setRequestProperty(
                "X-NearNest-Transfer-Token",
                token,
              )
              repairConnection.connect()
              if (repairConnection.responseCode != HttpURLConnection.HTTP_PARTIAL) {
                throw IllegalStateException(
                  "Wearable repair returned HTTP ${repairConnection.responseCode}",
                )
              }
              output.seek(relativeStart)
              BufferedInputStream(
                repairConnection.inputStream,
                64 * 1024,
              ).use { input ->
                val repairBuffer = ByteArray(64 * 1024)
                var repairRemaining = repairLength
                while (repairRemaining > 0) {
                  ensureNotCancelled(generation)
                  val count =
                    input.read(
                      repairBuffer,
                      0,
                      min(repairBuffer.size.toLong(), repairRemaining).toInt(),
                    )
                  if (count < 0) break
                  output.write(repairBuffer, 0, count)
                  repairRemaining -= count
                  repairedBytes += count
                  emitProgress(
                    "download",
                    jobId,
                    min(length, udpBytes + repairedBytes),
                    length,
                  )
                }
                if (repairRemaining != 0L) {
                  throw IllegalStateException("Wearable repair was incomplete")
                }
              }
            } finally {
              repairConnection?.disconnect()
            }
          }
          output.fd.sync()

          val elapsedMs =
            max(
              1L,
              (lastPacketAtNanos - firstPacketAtNanos) / 1_000_000L,
            )
          if (destination.exists()) destination.delete()
          if (!temporary.renameTo(destination)) {
            throw IllegalStateException("Could not finalize the UDP recording part")
          }
          emitProgress("download", jobId, length, length)
          val result = Arguments.createMap()
          result.putString("path", destination.absolutePath)
          result.putDouble(
            "udpBytesPerSecond",
            udpBytes.toDouble() * 1000.0 / elapsedMs.toDouble(),
          )
          result.putInt("missingPackets", missingPackets + corruptPackets)
          result.putDouble(
            "packetLossPercent",
            (missingPackets + corruptPackets).toDouble() * 100.0 /
              packetsExpected.toDouble(),
          )
          result.putDouble("repairedBytes", repairedBytes.toDouble())
          Log.i(
            "NearNestTransfer",
            "UDP range bytes=$udpBytes packets=$packetsReceived/$packetsExpected " +
              "missing=$missingPackets corrupt=$corruptPackets repaired=$repairedBytes " +
              "elapsedMs=$elapsedMs",
          )
          promise.resolve(result)
        }
      } catch (error: Exception) {
        temporary.delete()
        promise.reject("download.udp_failed", error.message, error)
      } finally {
        startConnection?.disconnect()
        socket?.close()
      }
    }
  }

  @ReactMethod
  fun uploadFile(
    jobId: String,
    url: String,
    path: String,
    promise: Promise,
  ) {
    val file = File(path)
    if (!isInsideCache(file) || !file.isFile || file.length() <= 0) {
      promise.reject("upload.invalid_file", "Cached recording part is unavailable")
      return
    }
    val generation = cancellationGeneration.get()
    executor.execute {
      var connection: HttpURLConnection? = null
      try {
        connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 20_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = "PUT"
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(file.length())
        connection.setRequestProperty("Content-Type", "application/octet-stream")
        var transferred = 0L
        BufferedInputStream(FileInputStream(file), 64 * 1024).use { input ->
          BufferedOutputStream(connection.outputStream, 64 * 1024).use { output ->
            val buffer = ByteArray(64 * 1024)
            var lastReported = 0L
            while (true) {
              ensureNotCancelled(generation)
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
              transferred += count
              if (transferred - lastReported >= 256 * 1024 ||
                  transferred == file.length()) {
                emitProgress("upload", jobId, transferred, file.length())
                lastReported = transferred
              }
            }
          }
        }
        val status = connection.responseCode
        if (status !in 200..299) {
          throw IllegalStateException("Object storage returned HTTP $status")
        }
        emitProgress("upload", jobId, file.length(), file.length())
        val result = Arguments.createMap()
        result.putDouble("bytes", file.length().toDouble())
        result.putString("etag", connection.getHeaderField("ETag"))
        promise.resolve(result)
      } catch (error: Exception) {
        promise.reject("upload.failed", error.message, error)
      } finally {
        connection?.disconnect()
      }
    }
  }

  @ReactMethod
  fun deleteCachedPart(path: String, promise: Promise) {
    val file = File(path)
    if (!isInsideCache(file)) {
      promise.reject("cache.invalid_path", "Invalid transfer cache path")
      return
    }
    promise.resolve(!file.exists() || file.delete())
  }

  @ReactMethod
  fun cancelAll(promise: Promise) {
    cancellationGeneration.incrementAndGet()
    promise.resolve(null)
  }

  // Required by NativeEventEmitter.
  @ReactMethod fun addListener(eventName: String) = Unit

  @ReactMethod fun removeListeners(count: Double) = Unit

  override fun invalidate() {
    cancellationGeneration.incrementAndGet()
    disconnectInternal()
    executor.shutdownNow()
    super.invalidate()
  }

  private fun cacheFile(cacheKey: String): File? {
    if (!cacheKey.matches(Regex("[A-Za-z0-9._-]{1,160}"))) return null
    return File(cacheRoot, "$cacheKey.part")
  }

  private fun isInsideCache(file: File): Boolean =
    try {
      file.canonicalPath.startsWith("${cacheRoot.canonicalPath}${File.separator}")
    } catch (_: Exception) {
      false
    }

  private fun disconnectInternal() {
    connectivityManager.bindProcessToNetwork(null)
    val callback = networkCallback
    networkCallback = null
    if (callback != null) {
      try {
        connectivityManager.unregisterNetworkCallback(callback)
      } catch (_: Exception) {
        // It may already have been released by Android.
      }
    }
  }

  private fun ensureNotCancelled(generation: Long) {
    if (generation != cancellationGeneration.get() ||
        Thread.currentThread().isInterrupted) {
      throw IllegalStateException("Transfer was cancelled")
    }
  }

  private fun emitProgress(
    phase: String,
    jobId: String,
    transferred: Long,
    total: Long,
  ) {
    val event = Arguments.createMap()
    event.putString("phase", phase)
    event.putString("jobId", jobId)
    event.putDouble("bytesTransferred", max(0L, transferred).toDouble())
    event.putDouble("totalBytes", max(1L, total).toDouble())
    context
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("NearNestLocalTransferProgress", event)
  }
}
