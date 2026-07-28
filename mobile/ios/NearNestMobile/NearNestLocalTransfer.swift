import Foundation
import NetworkExtension
import React
import Darwin

@objc(NearNestLocalTransfer)
final class NearNestLocalTransfer: RCTEventEmitter, URLSessionDataDelegate, URLSessionTaskDelegate {
  private final class TransferContext {
    enum Phase {
      case benchmark
      case download
      case upload
    }

    let phase: Phase
    let jobId: String
    let expectedBytes: Int64
    let resolve: RCTPromiseResolveBlock
    let reject: RCTPromiseRejectBlock
    var transferredBytes: Int64 = 0
    var lastReportedBytes: Int64 = 0
    var responseStatus = 0
    let startedAt = Date()
    var fileHandle: FileHandle?
    var temporaryURL: URL?
    var destinationURL: URL?

    init(
      phase: Phase,
      jobId: String,
      expectedBytes: Int64,
      resolve: @escaping RCTPromiseResolveBlock,
      reject: @escaping RCTPromiseRejectBlock
    ) {
      self.phase = phase
      self.jobId = jobId
      self.expectedBytes = expectedBytes
      self.resolve = resolve
      self.reject = reject
    }
  }

  private let stateQueue = DispatchQueue(label: "com.nearnest.local-transfer.state")
  private let fileManager = FileManager.default
  private var contexts: [Int: TransferContext] = [:]
  private var activeSSID: String?
  private var hasListeners = false
  private lazy var transferSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 15 * 60
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let queue = OperationQueue()
    queue.name = "com.nearnest.local-transfer.url-session"
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    ["NearNestLocalTransferProgress"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  @objc(connectToHotspot:password:resolver:rejecter:)
  func connectToHotspot(
    _ ssid: String,
    password: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard !ssid.isEmpty, (8...63).contains(password.count) else {
      reject("wifi.invalid_credentials", "Invalid hotspot credentials", nil)
      return
    }
    let configuration = NEHotspotConfiguration(
      ssid: ssid,
      passphrase: password,
      isWEP: false
    )
    configuration.joinOnce = true
    NEHotspotConfigurationManager.shared.apply(configuration) { [weak self] error in
      if let error {
        let hotspotError = error as NSError
        if hotspotError.domain == NEHotspotConfigurationErrorDomain,
           hotspotError.code == NEHotspotConfigurationError.alreadyAssociated.rawValue {
          self?.activeSSID = ssid
          resolve(nil)
          return
        }
        reject("wifi.request_failed", error.localizedDescription, error)
        return
      }
      self?.activeSSID = ssid
      resolve(nil)
    }
  }

  @objc(disconnectFromHotspot:rejecter:)
  func disconnectFromHotspot(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if let ssid = activeSSID {
      NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
    }
    activeSSID = nil
    // Configuration removal is synchronous, while the Wi-Fi route transition
    // is not. The subsequent internet probe waits for the usable route.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      resolve(nil)
    }
  }

  @objc(getAvailableCacheBytes:rejecter:)
  func getAvailableCacheBytes(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try ensureCacheDirectory()
      let attributes = try fileManager.attributesOfFileSystem(
        forPath: cacheRoot.path
      )
      let free = (attributes[.systemFreeSize] as? NSNumber)?.doubleValue ?? 0
      resolve(free)
    } catch {
      reject("cache.unavailable", error.localizedDescription, error)
    }
  }

  @objc(getCachedPart:expectedBytes:resolver:rejecter:)
  func getCachedPart(
    _ cacheKey: String,
    expectedBytes: Double,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    guard let fileURL = cacheURL(cacheKey: cacheKey) else {
      reject("cache.invalid_key", "Invalid transfer cache key", nil)
      return
    }
    let expected = Int64(expectedBytes)
    let attributes = try? fileManager.attributesOfItem(atPath: fileURL.path)
    let size = (attributes?[.size] as? NSNumber)?.int64Value
    resolve(size == expected ? fileURL.path : nil)
  }

  @objc(downloadRange:url:token:expectedBytes:cacheKey:resolver:rejecter:)
  func downloadRange(
    _ jobId: String,
    url urlString: String,
    token: String,
    expectedBytes: Double,
    cacheKey: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let remoteURL = URL(string: urlString),
      let destinationURL = cacheURL(cacheKey: cacheKey),
      expectedBytes > 0
    else {
      reject("download.invalid_request", "Invalid download request", nil)
      return
    }
    let expected = Int64(expectedBytes)
    do {
      try ensureCacheDirectory()
      if fileManager.fileExists(atPath: destinationURL.path),
         fileSize(destinationURL) == expected {
        resolve(destinationURL.path)
        return
      }
      let temporaryURL = destinationURL.appendingPathExtension("tmp")
      try? fileManager.removeItem(at: temporaryURL)
      guard fileManager.createFile(atPath: temporaryURL.path, contents: nil) else {
        throw NSError(
          domain: "NearNestLocalTransfer",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Could not create the cached recording part"]
        )
      }
      let fileHandle = try FileHandle(forWritingTo: temporaryURL)
      var request = URLRequest(url: remoteURL)
      request.httpMethod = "GET"
      request.timeoutInterval = 30
      request.cachePolicy = .reloadIgnoringLocalCacheData
      request.setValue(token, forHTTPHeaderField: "X-NearNest-Transfer-Token")
      let task = transferSession.dataTask(with: request)
      let context = TransferContext(
        phase: .download,
        jobId: jobId,
        expectedBytes: expected,
        resolve: resolve,
        reject: reject
      )
      context.fileHandle = fileHandle
      context.temporaryURL = temporaryURL
      context.destinationURL = destinationURL
      stateQueue.sync {
        contexts[task.taskIdentifier] = context
      }
      task.resume()
    } catch {
      reject("download.failed", error.localizedDescription, error)
    }
  }

  @objc(benchmarkDownload:token:expectedBytes:resolver:rejecter:)
  func benchmarkDownload(
    _ urlString: String,
    token: String,
    expectedBytes: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let remoteURL = URL(string: urlString), expectedBytes > 0 else {
      reject("benchmark.invalid_request", "Invalid benchmark request", nil)
      return
    }
    var request = URLRequest(url: remoteURL)
    request.httpMethod = "GET"
    request.timeoutInterval = 60
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue(token, forHTTPHeaderField: "X-NearNest-Transfer-Token")
    let task = transferSession.dataTask(with: request)
    let context = TransferContext(
      phase: .benchmark,
      jobId: "network-benchmark",
      expectedBytes: Int64(expectedBytes),
      resolve: resolve,
      reject: reject
    )
    stateQueue.sync {
      contexts[task.taskIdentifier] = context
    }
    task.resume()
  }

  @objc(benchmarkUdp:token:expectedBytes:resolver:rejecter:)
  func benchmarkUdp(
    _ urlString: String,
    token: String,
    expectedBytes: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard expectedBytes > 0 else {
      reject("benchmark.invalid_request", "Invalid UDP benchmark size", nil)
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      let descriptor = Darwin.socket(
        AF_INET,
        SOCK_DGRAM,
        Int32(IPPROTO_UDP)
      )
      guard descriptor >= 0 else {
        reject("benchmark.udp_failed", "Could not create the UDP socket", nil)
        return
      }
      defer { Darwin.close(descriptor) }

      var receiveBufferBytes: Int32 = 1024 * 1024
      _ = withUnsafePointer(to: &receiveBufferBytes) {
        Darwin.setsockopt(
          descriptor,
          SOL_SOCKET,
          SO_RCVBUF,
          $0,
          socklen_t(MemoryLayout<Int32>.size)
        )
      }
      var timeout = timeval(tv_sec: 0, tv_usec: 250_000)
      _ = withUnsafePointer(to: &timeout) {
        Darwin.setsockopt(
          descriptor,
          SOL_SOCKET,
          SO_RCVTIMEO,
          $0,
          socklen_t(MemoryLayout<timeval>.size)
        )
      }

      var localAddress = sockaddr_in()
      localAddress.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      localAddress.sin_family = sa_family_t(AF_INET)
      localAddress.sin_port = 0
      localAddress.sin_addr = in_addr(s_addr: INADDR_ANY)
      let bindResult = withUnsafePointer(to: &localAddress) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(
            descriptor,
            $0,
            socklen_t(MemoryLayout<sockaddr_in>.size)
          )
        }
      }
      guard bindResult == 0 else {
        reject("benchmark.udp_failed", "Could not bind the UDP socket", nil)
        return
      }

      var boundAddress = sockaddr_in()
      var boundAddressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
      let addressResult = withUnsafeMutablePointer(to: &boundAddress) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.getsockname(descriptor, $0, &boundAddressLength)
        }
      }
      guard addressResult == 0 else {
        reject("benchmark.udp_failed", "Could not read the UDP port", nil)
        return
      }
      let localPort = Int(UInt16(bigEndian: boundAddress.sin_port))
      guard
        var components = URLComponents(string: urlString)
      else {
        reject("benchmark.invalid_request", "Invalid UDP benchmark URL", nil)
        return
      }
      var queryItems = components.queryItems ?? []
      queryItems.append(URLQueryItem(name: "port", value: String(localPort)))
      components.queryItems = queryItems
      guard let startURL = components.url else {
        reject("benchmark.invalid_request", "Invalid UDP benchmark URL", nil)
        return
      }

      var request = URLRequest(url: startURL)
      request.httpMethod = "GET"
      request.timeoutInterval = 15
      request.cachePolicy = .reloadIgnoringLocalCacheData
      request.setValue(token, forHTTPHeaderField: "X-NearNest-Transfer-Token")
      let semaphore = DispatchSemaphore(value: 0)
      var responseData: Data?
      var responseStatus = 0
      var responseError: Error?
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 15
      configuration.timeoutIntervalForResource = 15
      URLSession(configuration: configuration)
        .dataTask(with: request) { data, response, error in
          responseData = data
          responseStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
          responseError = error
          semaphore.signal()
        }
        .resume()
      guard semaphore.wait(timeout: .now() + 16) == .success,
            responseError == nil,
            responseStatus == 202,
            let responseData,
            let json = try? JSONSerialization.jsonObject(with: responseData)
              as? [String: Any],
            let sessionNumber = json["session"] as? NSNumber,
            let packetNumber = json["packets"] as? NSNumber,
            let byteNumber = json["bytes"] as? NSNumber
      else {
        reject(
          "benchmark.udp_failed",
          responseError?.localizedDescription ??
            "Wearable did not start the UDP benchmark",
          responseError
        )
        return
      }

      let session = sessionNumber.uint32Value
      let packetsExpected = packetNumber.intValue
      guard packetsExpected > 0,
            byteNumber.int64Value == Int64(expectedBytes)
      else {
        reject(
          "benchmark.udp_failed",
          "Wearable returned an invalid UDP benchmark configuration",
          nil
        )
        return
      }

      func readUInt16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
      }
      func readUInt32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        (UInt32(bytes[offset]) << 24) |
          (UInt32(bytes[offset + 1]) << 16) |
          (UInt32(bytes[offset + 2]) << 8) |
          UInt32(bytes[offset + 3])
      }

      var seen = [Bool](repeating: false, count: packetsExpected)
      var buffer = [UInt8](repeating: 0, count: 2048)
      var packetsReceived = 0
      var receivedBytes: Int64 = 0
      var duplicates = 0
      var outOfOrder = 0
      var highestSequence = -1
      var firstPacketAt: UInt64 = 0
      var lastPacketAt: UInt64 = 0
      var endReceivedAt: UInt64 = 0
      let deadline =
        DispatchTime.now().uptimeNanoseconds + 60_000_000_000

      while DispatchTime.now().uptimeNanoseconds < deadline {
        let count = buffer.withUnsafeMutableBytes {
          Darwin.recv(descriptor, $0.baseAddress, $0.count, 0)
        }
        if count < 0 {
          if endReceivedAt > 0,
             DispatchTime.now().uptimeNanoseconds - endReceivedAt >=
               500_000_000 {
            break
          }
          continue
        }
        guard count >= 16,
              readUInt32(buffer, 0) == 0x4e4e5542,
              readUInt32(buffer, 4) == session
        else {
          continue
        }
        let sequence = Int(readUInt32(buffer, 8))
        let payloadBytes = Int(readUInt16(buffer, 12))
        let flags = readUInt16(buffer, 14)
        if flags & 1 != 0 {
          if endReceivedAt == 0 {
            endReceivedAt = DispatchTime.now().uptimeNanoseconds
          }
          continue
        }
        guard sequence >= 0, sequence < packetsExpected,
              payloadBytes > 0, count >= 16 + payloadBytes
        else {
          continue
        }
        let now = DispatchTime.now().uptimeNanoseconds
        if firstPacketAt == 0 { firstPacketAt = now }
        lastPacketAt = now
        if seen[sequence] {
          duplicates += 1
          continue
        }
        if sequence < highestSequence { outOfOrder += 1 }
        highestSequence = max(highestSequence, sequence)
        seen[sequence] = true
        packetsReceived += 1
        receivedBytes += Int64(payloadBytes)
      }
      guard firstPacketAt > 0, endReceivedAt > 0 else {
        reject(
          "benchmark.udp_failed",
          "Wearable UDP benchmark did not complete",
          nil
        )
        return
      }
      let elapsedMs = max(
        1,
        Int64(lastPacketAt - firstPacketAt) / 1_000_000
      )
      let lost = packetsExpected - packetsReceived
      resolve([
        "bytes": NSNumber(value: receivedBytes),
        "elapsedMs": NSNumber(value: elapsedMs),
        "bytesPerSecond": NSNumber(
          value: Double(receivedBytes) * 1000.0 / Double(elapsedMs)
        ),
        "packetsExpected": NSNumber(value: packetsExpected),
        "packetsReceived": NSNumber(value: packetsReceived),
        "duplicates": NSNumber(value: duplicates),
        "outOfOrder": NSNumber(value: outOfOrder),
        "packetLossPercent": NSNumber(
          value: Double(lost) * 100.0 / Double(packetsExpected)
        ),
      ])
    }
  }

  @objc(uploadFile:url:path:resolver:rejecter:)
  func uploadFile(
    _ jobId: String,
    url urlString: String,
    path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let fileURL = URL(fileURLWithPath: path)
    guard
      let remoteURL = URL(string: urlString),
      isInsideCache(fileURL),
      fileManager.fileExists(atPath: fileURL.path),
      fileSize(fileURL) > 0
    else {
      reject("upload.invalid_file", "Cached recording part is unavailable", nil)
      return
    }
    var request = URLRequest(url: remoteURL)
    request.httpMethod = "PUT"
    request.timeoutInterval = 30
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let task = transferSession.uploadTask(with: request, fromFile: fileURL)
    let context = TransferContext(
      phase: .upload,
      jobId: jobId,
      expectedBytes: fileSize(fileURL),
      resolve: resolve,
      reject: reject
    )
    stateQueue.sync {
      contexts[task.taskIdentifier] = context
    }
    task.resume()
  }

  @objc(deleteCachedPart:resolver:rejecter:)
  func deleteCachedPart(
    _ path: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let fileURL = URL(fileURLWithPath: path)
    guard isInsideCache(fileURL) else {
      reject("cache.invalid_path", "Invalid transfer cache path", nil)
      return
    }
    do {
      if fileManager.fileExists(atPath: fileURL.path) {
        try fileManager.removeItem(at: fileURL)
      }
      resolve(true)
    } catch {
      reject("cache.delete_failed", error.localizedDescription, error)
    }
  }

  @objc(cancelAll:rejecter:)
  func cancelAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    transferSession.getAllTasks { tasks in
      tasks.forEach { $0.cancel() }
      resolve(nil)
    }
  }

  @objc(waitForInternet:rejecter:)
  func waitForInternet(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let deadline = Date().addingTimeInterval(30)
    probeInternet(deadline: deadline, resolve: resolve, reject: reject)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      failTask(
        dataTask.taskIdentifier,
        code: "network.invalid_response",
        message: "Transfer returned an invalid response"
      )
      return
    }
    let accepted: Bool = stateQueue.sync {
      guard let context = contexts[dataTask.taskIdentifier] else { return false }
      context.responseStatus = http.statusCode
      switch context.phase {
      case .benchmark:
        return http.statusCode == 200
      case .download:
        return http.statusCode == 206
      case .upload:
        return (200...299).contains(http.statusCode)
      }
    }
    if accepted {
      completionHandler(.allow)
    } else {
      completionHandler(.cancel)
      failTask(
        dataTask.taskIdentifier,
        code: "network.http_error",
        message: "Transfer returned HTTP \(http.statusCode)"
      )
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    var progress: (String, Int64, Int64)?
    do {
      try stateQueue.sync {
        guard let context = contexts[dataTask.taskIdentifier],
              context.phase != .upload else { return }
        if context.phase == .download {
          try context.fileHandle?.write(contentsOf: data)
        }
        context.transferredBytes += Int64(data.count)
        if context.phase == .download &&
            (context.transferredBytes - context.lastReportedBytes >= 64 * 1024 ||
             context.transferredBytes == context.expectedBytes) {
          context.lastReportedBytes = context.transferredBytes
          progress = (
            context.jobId,
            context.transferredBytes,
            context.expectedBytes
          )
        }
      }
      if let progress {
        emitProgress(
          phase: "download",
          jobId: progress.0,
          transferred: progress.1,
          total: progress.2
        )
      }
    } catch {
      dataTask.cancel()
      failTask(
        dataTask.taskIdentifier,
        code: "download.write_failed",
        message: error.localizedDescription
      )
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    guard totalBytesExpectedToSend > 0 else { return }
    var progress: (String, Int64, Int64)?
    stateQueue.sync {
      guard let context = contexts[task.taskIdentifier],
            context.phase == .upload else { return }
      context.transferredBytes = totalBytesSent
      if totalBytesSent - context.lastReportedBytes >= 256 * 1024 ||
          totalBytesSent == totalBytesExpectedToSend {
        context.lastReportedBytes = totalBytesSent
        progress = (context.jobId, totalBytesSent, totalBytesExpectedToSend)
      }
    }
    if let progress {
      emitProgress(
        phase: "upload",
        jobId: progress.0,
        transferred: progress.1,
        total: progress.2
      )
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    var context: TransferContext?
    stateQueue.sync {
      context = contexts.removeValue(forKey: task.taskIdentifier)
    }
    guard let context else { return }
    try? context.fileHandle?.close()

    if let error {
      if let temporaryURL = context.temporaryURL {
        try? fileManager.removeItem(at: temporaryURL)
      }
      context.reject("transfer.failed", error.localizedDescription, error)
      return
    }
    guard (200...299).contains(context.responseStatus) ||
            (context.phase == .download && context.responseStatus == 206) else {
      context.reject(
        "transfer.http_error",
        "Transfer returned HTTP \(context.responseStatus)",
        nil
      )
      return
    }

    switch context.phase {
    case .benchmark:
      guard context.transferredBytes == context.expectedBytes else {
        context.reject(
          "benchmark.length_mismatch",
          "Wearable sent \(context.transferredBytes) bytes; expected \(context.expectedBytes)",
          nil
        )
        return
      }
      let elapsedMs = max(1, Int(Date().timeIntervalSince(context.startedAt) * 1000))
      context.resolve([
        "bytes": NSNumber(value: context.transferredBytes),
        "elapsedMs": NSNumber(value: elapsedMs),
        "bytesPerSecond": NSNumber(
          value: Double(context.transferredBytes) * 1000 / Double(elapsedMs)
        ),
      ])
    case .download:
      guard
        context.transferredBytes == context.expectedBytes,
        let temporaryURL = context.temporaryURL,
        let destinationURL = context.destinationURL
      else {
        if let temporaryURL = context.temporaryURL {
          try? fileManager.removeItem(at: temporaryURL)
        }
        context.reject(
          "download.length_mismatch",
          "Wearable sent \(context.transferredBytes) bytes; expected \(context.expectedBytes)",
          nil
        )
        return
      }
      do {
        try? fileManager.removeItem(at: destinationURL)
        try fileManager.moveItem(at: temporaryURL, to: destinationURL)
        emitProgress(
          phase: "download",
          jobId: context.jobId,
          transferred: context.expectedBytes,
          total: context.expectedBytes
        )
        context.resolve(destinationURL.path)
      } catch {
        context.reject("download.finalize_failed", error.localizedDescription, error)
      }
    case .upload:
      emitProgress(
        phase: "upload",
        jobId: context.jobId,
        transferred: context.expectedBytes,
        total: context.expectedBytes
      )
      let http = task.response as? HTTPURLResponse
      var result: [String: Any] = [
        "bytes": NSNumber(value: context.expectedBytes)
      ]
      if let etag = http?.value(forHTTPHeaderField: "ETag") {
        result["etag"] = etag
      } else {
        result["etag"] = NSNull()
      }
      context.resolve(result)
    }
  }

  private var cacheRoot: URL {
    let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    return caches.appendingPathComponent("nearnest-transfer", isDirectory: true)
  }

  private func ensureCacheDirectory() throws {
    try fileManager.createDirectory(
      at: cacheRoot,
      withIntermediateDirectories: true
    )
  }

  private func cacheURL(cacheKey: String) -> URL? {
    guard
      cacheKey.range(
        of: #"^[A-Za-z0-9._-]{1,160}$"#,
        options: .regularExpression
      ) != nil
    else {
      return nil
    }
    return cacheRoot.appendingPathComponent("\(cacheKey).part")
  }

  private func isInsideCache(_ fileURL: URL) -> Bool {
    let root = cacheRoot.standardizedFileURL.path + "/"
    return fileURL.standardizedFileURL.path.hasPrefix(root)
  }

  private func fileSize(_ fileURL: URL) -> Int64 {
    let attributes = try? fileManager.attributesOfItem(atPath: fileURL.path)
    return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  }

  private func failTask(_ identifier: Int, code: String, message: String) {
    var context: TransferContext?
    stateQueue.sync {
      context = contexts.removeValue(forKey: identifier)
    }
    guard let context else { return }
    try? context.fileHandle?.close()
    if let temporaryURL = context.temporaryURL {
      try? fileManager.removeItem(at: temporaryURL)
    }
    context.reject(code, message, nil)
  }

  private func emitProgress(
    phase: String,
    jobId: String,
    transferred: Int64,
    total: Int64
  ) {
    guard hasListeners else { return }
    sendEvent(
      withName: "NearNestLocalTransferProgress",
      body: [
        "phase": phase,
        "jobId": jobId,
        "bytesTransferred": NSNumber(value: max(0, transferred)),
        "totalBytes": NSNumber(value: max(1, total)),
      ]
    )
  }

  private func probeInternet(
    deadline: Date,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard Date() < deadline else {
      reject(
        "network.unavailable",
        "The phone did not regain internet access after leaving the wearable hotspot",
        nil
      )
      return
    }
    var request = URLRequest(
      url: URL(string: "https://captive.apple.com/hotspot-detect.html")!
    )
    request.httpMethod = "GET"
    request.timeoutInterval = 4
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 4
    configuration.timeoutIntervalForResource = 4
    URLSession(configuration: configuration)
      .dataTask(with: request) { [weak self] _, response, _ in
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
          resolve(nil)
          return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
          self?.probeInternet(deadline: deadline, resolve: resolve, reject: reject)
        }
      }
      .resume()
  }
}
