import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription,
} from 'react-native';

type ProgressEvent = {
  bytesTransferred: number;
  jobId: string;
  phase: 'download' | 'upload';
  totalBytes: number;
};

type UploadResult = {
  bytes: number;
  etag?: string;
};

export type NetworkBenchmarkResult = {
  bytes: number;
  bytesPerSecond: number;
  elapsedMs: number;
};

type NearNestLocalTransferNative = {
  addListener(eventName: string): void;
  benchmarkDownload(
    url: string,
    token: string,
    expectedBytes: number,
  ): Promise<NetworkBenchmarkResult>;
  cancelAll(): Promise<void>;
  connectToHotspot(ssid: string, password: string): Promise<void>;
  deleteCachedPart(path: string): Promise<boolean>;
  disconnectFromHotspot(): Promise<void>;
  downloadRange(
    jobId: string,
    url: string,
    token: string,
    expectedBytes: number,
    cacheKey: string,
  ): Promise<string>;
  getAvailableCacheBytes(): Promise<number>;
  getCachedPart(
    cacheKey: string,
    expectedBytes: number,
  ): Promise<string | null>;
  removeListeners(count: number): void;
  uploadFile(
    jobId: string,
    url: string,
    path: string,
  ): Promise<UploadResult>;
  waitForInternet(): Promise<void>;
};

function nativeModule(): NearNestLocalTransferNative {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error(
      'Local wearable Wi-Fi transfer is unavailable on this platform',
    );
  }
  const module = NativeModules
    .NearNestLocalTransfer as NearNestLocalTransferNative | undefined;
  if (!module) {
    throw new Error(
      'NearNest transfer module is unavailable. Rebuild and reinstall the app.',
    );
  }
  return module;
}

export const localTransfer = {
  benchmark: (
    url: string,
    token: string,
    expectedBytes: number,
  ) => nativeModule().benchmarkDownload(url, token, expectedBytes),
  cancelAll: () => nativeModule().cancelAll(),
  connect: (ssid: string, password: string) =>
    nativeModule().connectToHotspot(ssid, password),
  deleteCachedPart: (path: string) =>
    nativeModule().deleteCachedPart(path),
  disconnect: () => nativeModule().disconnectFromHotspot(),
  downloadRange: (
    jobId: string,
    url: string,
    token: string,
    expectedBytes: number,
    cacheKey: string,
  ) =>
    nativeModule().downloadRange(
      jobId,
      url,
      token,
      expectedBytes,
      cacheKey,
    ),
  getAvailableCacheBytes: () => nativeModule().getAvailableCacheBytes(),
  getCachedPart: (cacheKey: string, expectedBytes: number) =>
    nativeModule().getCachedPart(cacheKey, expectedBytes),
  subscribe(
    listener: (event: ProgressEvent) => void,
  ): EmitterSubscription {
    const module = nativeModule();
    return new NativeEventEmitter(module).addListener(
      'NearNestLocalTransferProgress',
      listener,
    );
  },
  uploadFile: (jobId: string, url: string, path: string) =>
    nativeModule().uploadFile(jobId, url, path),
  waitForInternet: () => nativeModule().waitForInternet(),
};
