import AsyncStorage from '@react-native-async-storage/async-storage';
import { authenticatedRequest } from './auth';
import type {
  DeviceTransport,
  SyncCallbacks,
  SyncHandle,
} from './transport';
import { localTransfer } from './localTransfer';

const PENDING_TRANSFER_KEY = 'nearnest.pending-wifi-transfer.v2';
const LEGACY_PENDING_TRANSFER_KEY = 'nearnest.pending-wifi-transfer.v1';

export type DeviceRecordingManifest = {
  contentType: string;
  fileName: string;
  recordingId: string;
  sizeBytes: number;
};

export type MultipartTransfer = {
  analysisId: string;
  multipart: {
    partCount: number;
    partSizeBytes: number;
  };
};

export type WifiUploadPart = {
  expiresAt: string;
  lengthBytes: number;
  method: 'PUT';
  offsetBytes: number;
  partNumber: number;
  url: string;
};

type MultipartStatus = {
  completedBytes: number;
  completedParts: Array<{
    etag: string;
    partNumber: number;
    sizeBytes: number;
  }>;
  partCount: number;
  partSizeBytes: number;
  sizeBytes: number;
};

export function createWifiAudioTransfer(
  childId: string,
  recording: DeviceRecordingManifest,
): Promise<MultipartTransfer> {
  return authenticatedRequest<MultipartTransfer>('/audio-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      childId,
      fileName: recording.fileName,
      contentType: recording.contentType,
      sizeBytes: recording.sizeBytes,
      uploadMode: 'MULTIPART',
    }),
  });
}

export async function requestWifiUploadParts(
  transfer: MultipartTransfer,
  recordingSizeBytes: number,
  partNumbers: number[],
): Promise<WifiUploadPart[]> {
  const response = await authenticatedRequest<{
    parts: Array<Omit<WifiUploadPart, 'lengthBytes' | 'offsetBytes'>>;
  }>(`/audio-analysis/${transfer.analysisId}/multipart/parts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ partNumbers }),
  });

  return response.parts.map((part) => {
    const offsetBytes =
      (part.partNumber - 1) * transfer.multipart.partSizeBytes;
    return {
      ...part,
      offsetBytes,
      lengthBytes: Math.min(
        transfer.multipart.partSizeBytes,
        recordingSizeBytes - offsetBytes,
      ),
    };
  });
}

export function getWifiTransferStatus(
  analysisId: string,
): Promise<MultipartStatus> {
  return authenticatedRequest(`/audio-analysis/${analysisId}/multipart`);
}

export function completeWifiAudioTransfer(analysisId: string): Promise<void> {
  return authenticatedRequest(
    `/audio-analysis/${analysisId}/multipart/complete`,
    { method: 'POST' },
  ).then(() => undefined);
}

export function abortWifiAudioTransfer(analysisId: string): Promise<void> {
  return authenticatedRequest(`/audio-analysis/${analysisId}/multipart`, {
    method: 'DELETE',
  }).then(() => undefined);
}

type OwnedDevice = {
  childId?: string;
  id: string;
  lifecycleStatus: string;
  pairingStatus: string;
};

type PendingRecording = {
  phase: 'processing' | 'uploading';
  recording: DeviceRecordingManifest;
  released: boolean;
  transfer: MultipartTransfer;
};

type PendingTransferQueue = {
  childId: string;
  recordings: PendingRecording[];
  version: 2;
};

type TransferPart = {
  cacheKey: string;
  lengthBytes: number;
  offsetBytes: number;
  partNumber: number;
  path: string | null;
  pending: PendingRecording;
};

const NETWORK_BENCHMARK_BYTES = 16 * 1024 * 1024;

/**
 * BLE carries commands and the one-time hotspot secret. Recording bytes move
 * ESP → phone over the isolated hotspot, then phone → object storage after the
 * phone has disconnected from the hotspot and regained internet access.
 */
export function startDirectWifiSync(
  deviceTransport: DeviceTransport,
  callbacks: SyncCallbacks,
): SyncHandle {
  let cancelled = false;

  const run = async () => {
    const devices = await authenticatedRequest<OwnedDevice[]>('/devices');
    const device = devices.find(
      (candidate) =>
        candidate.pairingStatus === 'paired' &&
        candidate.lifecycleStatus === 'active' &&
        candidate.childId,
    );
    if (!device?.childId) {
      throw new Error('No active paired wearable was found');
    }

    callbacks.onTransfer(0);
    const manifests = await deviceTransport.listRecordingManifests(
      (recordingsFound) => {
        callbacks.onTransfer(
          Math.min(0.05, recordingsFound / (recordingsFound + 1) / 20),
        );
      },
    );
    callbacks.onFileProgress(0, manifests.length);
    if (cancelled) return;

    const queue = await loadPendingQueue(device.childId, manifests);
    for (const recording of manifests) {
      if (
        queue.recordings.some(
          (pending) => pending.recording.recordingId === recording.recordingId,
        )
      ) {
        continue;
      }
      const transfer = await createWifiAudioTransfer(device.childId, recording);
      queue.recordings.push({
        phase: 'uploading',
        recording,
        released: false,
        transfer,
      });
      await savePendingQueue(queue);
    }
    if (queue.recordings.length === 0) {
      throw new Error('No finalized recordings were found on the wearable');
    }

    const catalogIds = new Set(
      manifests.map((recording) => recording.recordingId),
    );
    for (const pending of queue.recordings) {
      if (pending.phase !== 'processing' || pending.released) continue;
      if (!catalogIds.has(pending.recording.recordingId)) {
        // A release acknowledgement may be lost after the ESP removed the file.
        pending.released = true;
        continue;
      }
      try {
        await deviceTransport.releaseRecording(
          pending.recording.recordingId,
        );
        pending.released = true;
      } catch {
        // Keep the completed analysis in the queue so this exact SD file is not
        // uploaded a second time. Release will be retried on the next sync.
      }
    }
    await savePendingQueue(queue);
    const reportFileProgress = () => {
      callbacks.onFileProgress(
        queue.recordings.filter(
          (pending) => pending.phase === 'processing',
        ).length,
        queue.recordings.length,
      );
    };
    reportFileProgress();

    const statusByAnalysis = new Map<string, MultipartStatus>();
    const transferParts: TransferPart[] = [];
    for (const pending of queue.recordings) {
      if (pending.phase === 'processing') continue;
      const recording = manifests.find(
        (candidate) =>
          candidate.recordingId === pending.recording.recordingId,
      );
      if (!recording) {
        throw new Error(
          `Pending recording ${pending.recording.fileName} is no longer on the wearable`,
        );
      }
      const status = await getWifiTransferStatus(pending.transfer.analysisId);
      statusByAnalysis.set(pending.transfer.analysisId, status);
      const completed = new Set(
        status.completedParts.map((part) => part.partNumber),
      );
      for (
        let partNumber = 1;
        partNumber <= status.partCount;
        partNumber += 1
      ) {
        if (completed.has(partNumber)) continue;
        const offsetBytes = (partNumber - 1) * status.partSizeBytes;
        const lengthBytes = Math.min(
          status.partSizeBytes,
          recording.sizeBytes - offsetBytes,
        );
        if (lengthBytes <= 0 || lengthBytes > 10 * 1024 * 1024) {
          throw new Error(
            `Unsupported transfer part size for ${recording.fileName}`,
          );
        }
        const cacheKey = `${pending.transfer.analysisId}-${partNumber}`;
        transferParts.push({
          cacheKey,
          lengthBytes,
          offsetBytes,
          partNumber,
          path: await localTransfer.getCachedPart(cacheKey, lengthBytes),
          pending,
        });
      }
    }

    const totalTransferBytes = Math.max(
      1,
      transferParts.reduce((total, part) => total + part.lengthBytes, 0),
    );
    const transferredBytes = new Map<string, number>();
    transferParts.forEach((part) => {
      transferredBytes.set(
        part.cacheKey,
        part.path ? part.lengthBytes : 0,
      );
    });
    let lastTransferSampleAt = Date.now();
    let lastTransferSampleBytes = [...transferredBytes.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    );
    let smoothedTransferBytesPerSecond = 0;
    const reportTransferProgress = () => {
      const transferred = [...transferredBytes.values()].reduce(
        (total, bytes) => total + bytes,
        0,
      );
      callbacks.onTransfer(Math.min(1, transferred / totalTransferBytes));
      const now = Date.now();
      const elapsedMs = now - lastTransferSampleAt;
      if (elapsedMs >= 500) {
        const sampleBytesPerSecond =
          (Math.max(0, transferred - lastTransferSampleBytes) * 1000) /
          elapsedMs;
        smoothedTransferBytesPerSecond =
          smoothedTransferBytesPerSecond === 0
            ? sampleBytesPerSecond
            : smoothedTransferBytesPerSecond * 0.7 +
              sampleBytesPerSecond * 0.3;
        lastTransferSampleAt = now;
        lastTransferSampleBytes = transferred;
      }
      callbacks.onTransferTelemetry?.({
        bytesPerSecond: smoothedTransferBytesPerSecond,
        etaSeconds:
          smoothedTransferBytesPerSecond > 0
            ? Math.ceil(
                (totalTransferBytes - transferred) /
                  smoothedTransferBytesPerSecond,
              )
            : null,
        totalBytes: totalTransferBytes,
        transferredBytes: transferred,
      });
    };
    reportTransferProgress();

    const partsToDownload = transferParts.filter((part) => !part.path);
    if (partsToDownload.length > 0) {
      const bytesNeeded = partsToDownload.reduce(
        (total, part) => total + part.lengthBytes,
        0,
      );
      const availableBytes = await localTransfer.getAvailableCacheBytes();
      const reserveBytes = 64 * 1024 * 1024;
      if (availableBytes < bytesNeeded + reserveBytes) {
        throw new Error(
          `Not enough phone storage. Free at least ${Math.ceil(
            (bytesNeeded + reserveBytes - availableBytes) /
              (1024 * 1024),
          )} MB and try again.`,
        );
      }

      const access = await deviceTransport.startLocalTransferAccessPoint();
      let hotspotConnected = false;
      const progressSubscription = localTransfer.subscribe((event) => {
        if (event.phase !== 'download') return;
        const part = transferParts.find(
          (candidate) => candidate.cacheKey === event.jobId,
        );
        if (!part) return;
        transferredBytes.set(
          part.cacheKey,
          Math.min(
            part.lengthBytes,
            Math.max(0, event.bytesTransferred),
          ),
        );
        reportTransferProgress();
      });
      try {
        await localTransfer.connect(access.ssid, access.password);
        hotspotConnected = true;
        callbacks.onNetworkBenchmarkState?.(true);
        try {
          const benchmark = await localTransfer.benchmark(
            `${access.baseUrl}/v1/benchmark`,
            access.token,
            NETWORK_BENCHMARK_BYTES,
          );
          console.info(
            `[NearNest transfer] RAM benchmark ${(
              benchmark.bytesPerSecond /
              (1024 * 1024)
            ).toFixed(2)} MB/s (${benchmark.elapsedMs} ms)`,
          );
          callbacks.onNetworkBenchmark?.(benchmark.bytesPerSecond);
        } catch (error) {
          console.warn(
            '[NearNest transfer] RAM benchmark unavailable',
            error,
          );
        } finally {
          callbacks.onNetworkBenchmarkState?.(false);
        }
        for (const part of partsToDownload) {
          if (cancelled) return;
          const query =
            `recordingId=${encodeURIComponent(
              part.pending.recording.recordingId,
            )}&offsetBytes=${part.offsetBytes}&lengthBytes=${part.lengthBytes}`;
          part.path = await localTransfer.downloadRange(
            part.cacheKey,
            `${access.baseUrl}/v1/recording?${query}`,
            access.token,
            part.lengthBytes,
            part.cacheKey,
          );
          transferredBytes.set(part.cacheKey, part.lengthBytes);
          reportTransferProgress();
        }
      } finally {
        progressSubscription.remove();
        if (hotspotConnected) {
          await localTransfer.disconnect().catch(() => undefined);
        }
        await deviceTransport
          .stopLocalTransferAccessPoint()
          .catch(() => undefined);
      }
    }
    if (cancelled) return;
    callbacks.onTransfer(1);
    await localTransfer.waitForInternet();

    const totalBytes = Math.max(
      1,
      queue.recordings.reduce(
        (total, pending) => total + pending.recording.sizeBytes,
        0,
      ),
    );
    const uploadedBytes = new Map<string, number>();
    queue.recordings.forEach((pending) => {
      if (pending.phase === 'processing') {
        uploadedBytes.set(
          pending.recording.recordingId,
          pending.recording.sizeBytes,
        );
      }
    });
    statusByAnalysis.forEach((status, analysisId) => {
      const pending = queue.recordings.find(
        (candidate) => candidate.transfer.analysisId === analysisId,
      );
      if (pending) {
        uploadedBytes.set(
          pending.recording.recordingId,
          status.completedBytes,
        );
      }
    });
    const reportUploadProgress = () => {
      const uploaded = [...uploadedBytes.values()].reduce(
        (total, bytes) => total + bytes,
        0,
      );
      callbacks.onUpload(Math.min(1, uploaded / totalBytes));
    };
    reportUploadProgress();

    for (const pending of queue.recordings) {
      if (cancelled) return;
      if (pending.phase === 'processing') continue;
      const recording = manifests.find(
        (candidate) =>
          candidate.recordingId === pending.recording.recordingId,
      );
      if (!recording) {
        throw new Error(
          `Pending recording ${pending.recording.fileName} is no longer on the wearable`,
        );
      }
      const transfer = pending.transfer;
      let status =
        statusByAnalysis.get(transfer.analysisId) ??
        (await getWifiTransferStatus(transfer.analysisId));
      uploadedBytes.set(recording.recordingId, status.completedBytes);
      reportUploadProgress();

      while (!cancelled && status.completedParts.length < status.partCount) {
        const completed = new Set(
          status.completedParts.map((part) => part.partNumber),
        );
        const nextPartNumbers = Array.from(
          { length: status.partCount },
          (_, index) => index + 1,
        )
          .filter((partNumber) => !completed.has(partNumber))
          // The ESP uploads sequentially, so a small batch avoids URLs expiring
          // on slow WiFi while preserving enough work to keep it busy.
          .slice(0, 5);
        const parts = await requestWifiUploadParts(
          transfer,
          recording.sizeBytes,
          nextPartNumbers,
        );
        const batchProgressBytes = new Map<number, number>();
        const progressSubscription = localTransfer.subscribe((event) => {
          if (event.phase !== 'upload') return;
          const part = parts.find(
            (candidate) =>
              `${transfer.analysisId}-${candidate.partNumber}` === event.jobId,
          );
          if (!part) return;
          const partProgress = Math.min(
            part.lengthBytes,
            Math.max(0, event.bytesTransferred),
          );
          batchProgressBytes.set(
            part.partNumber,
            Math.max(
              batchProgressBytes.get(part.partNumber) ?? 0,
              partProgress,
            ),
          );
          const optimisticBytes =
            status.completedBytes +
            [...batchProgressBytes.values()].reduce(
              (total, bytes) => total + bytes,
              0,
            );
          uploadedBytes.set(
            recording.recordingId,
            Math.min(recording.sizeBytes, optimisticBytes),
          );
          reportUploadProgress();
        });
        try {
          for (const uploadPart of parts) {
            if (cancelled) return;
            if (Date.parse(uploadPart.expiresAt) <= Date.now() + 5_000) {
              throw new Error(
                `Upload URL for part ${uploadPart.partNumber} has expired`,
              );
            }
            const cachedPart = transferParts.find(
              (candidate) =>
                candidate.pending.transfer.analysisId ===
                  transfer.analysisId &&
                candidate.partNumber === uploadPart.partNumber,
            );
            if (!cachedPart?.path) {
              throw new Error(
                `Cached part ${uploadPart.partNumber} is missing for ${recording.fileName}`,
              );
            }
            const jobId = `${transfer.analysisId}-${uploadPart.partNumber}`;
            await localTransfer.uploadFile(
              jobId,
              uploadPart.url,
              cachedPart.path,
            );
          }
        } finally {
          progressSubscription.remove();
        }
        const refreshed = await getWifiTransferStatus(transfer.analysisId);
        if (refreshed.completedBytes <= status.completedBytes) {
          throw new Error(
            `Object storage did not persist chunks for ${recording.fileName}`,
          );
        }
        const persisted = new Set(
          refreshed.completedParts.map((part) => part.partNumber),
        );
        for (const uploadedPart of parts) {
          if (!persisted.has(uploadedPart.partNumber)) continue;
          const cachedPart = transferParts.find(
            (candidate) =>
              candidate.pending.transfer.analysisId === transfer.analysisId &&
              candidate.partNumber === uploadedPart.partNumber,
          );
          if (cachedPart?.path) {
            await localTransfer
              .deleteCachedPart(cachedPart.path)
              .catch(() => false);
            cachedPart.path = null;
          }
        }
        status = refreshed;
        uploadedBytes.set(recording.recordingId, status.completedBytes);
        reportUploadProgress();
      }
      if (cancelled) return;

      await completeWifiAudioTransfer(transfer.analysisId);
      pending.phase = 'processing';
      uploadedBytes.set(recording.recordingId, recording.sizeBytes);
      await savePendingQueue(queue);
      reportFileProgress();
      reportUploadProgress();
      try {
        await deviceTransport.releaseRecording(recording.recordingId);
        pending.released = true;
        await savePendingQueue(queue);
      } catch {
        // Backend completion is authoritative. The queue prevents a duplicate
        // upload and retries only the SD release on the next sync.
      }
    }
    if (cancelled) return;
    // Synchronization is complete once object storage has accepted every
    // multipart upload. Analysis runs independently and must not turn a
    // successful recording upload into a sync failure when a worker is down.
    queue.recordings = queue.recordings.filter(
      (pending) => !pending.released,
    );
    await savePendingQueue(queue);
    callbacks.onComplete();
  };

  void run().catch((error: unknown) => {
    if (!cancelled) {
      const reason =
        error instanceof Error ? error.message : 'Wi-Fi sync failed';
      console.error(`[NearNest sync] ${reason}`);
      callbacks.onFailed(reason);
    }
  });

  return {
    cancel: () => {
      cancelled = true;
      void localTransfer.cancelAll().catch(() => undefined);
      void localTransfer.disconnect().catch(() => undefined);
    },
  };
}

async function loadPendingQueue(
  childId: string,
  manifests: DeviceRecordingManifest[],
): Promise<PendingTransferQueue> {
  const pendingRaw = await AsyncStorage.getItem(PENDING_TRANSFER_KEY);
  if (pendingRaw) {
    try {
      const pending = JSON.parse(pendingRaw) as PendingTransferQueue;
      if (
        pending.version === 2 &&
        pending.childId === childId &&
        Array.isArray(pending.recordings)
      ) {
        const recordings = pending.recordings.filter(
          (entry): entry is PendingRecording =>
            Boolean(
              entry?.recording?.recordingId &&
                entry.recording.fileName &&
                Number.isSafeInteger(entry.recording.sizeBytes) &&
                entry.transfer?.analysisId &&
                Number.isSafeInteger(entry.transfer.multipart?.partCount) &&
                Number.isSafeInteger(
                  entry.transfer.multipart?.partSizeBytes,
                ),
            ),
        );
        const cleaned = { ...pending, recordings };
        if (recordings.length !== pending.recordings.length) {
          await savePendingQueue(cleaned);
        }
        return cleaned;
      }
    } catch {
      // A malformed queue is replaced below.
    }
  }

  const legacyRaw = await AsyncStorage.getItem(LEGACY_PENDING_TRANSFER_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as {
        childId: string;
        phase?: 'processing' | 'uploading';
        recordingId: string;
        transfer: MultipartTransfer;
      };
      const catalogRecording = manifests.find(
        (candidate) => candidate.recordingId === legacy.recordingId,
      );
      if (legacy.childId === childId) {
        const recording = catalogRecording ?? {
          contentType: 'audio/wav',
          fileName: `${legacy.recordingId}.wav`,
          recordingId: legacy.recordingId,
          sizeBytes: 0,
        };
        const migrated: PendingTransferQueue = {
          childId,
          recordings: [
            {
              phase: legacy.phase ?? 'uploading',
              recording,
              released:
                legacy.phase === 'processing' && !catalogRecording,
              transfer: legacy.transfer,
            },
          ],
          version: 2,
        };
        await savePendingQueue(migrated);
        return migrated;
      }
    } catch {
      // A stale legacy transfer is ignored.
    }
  }
  return { childId, recordings: [], version: 2 };
}

async function savePendingQueue(queue: PendingTransferQueue): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_PENDING_TRANSFER_KEY);
  if (queue.recordings.length === 0) {
    await AsyncStorage.removeItem(PENDING_TRANSFER_KEY);
    return;
  }
  await AsyncStorage.setItem(PENDING_TRANSFER_KEY, JSON.stringify(queue));
}
