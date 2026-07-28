package com.nearnestmobile

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
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
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

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
