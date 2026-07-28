import AsyncStorage from '@react-native-async-storage/async-storage';
import { authenticatedRequest } from './auth';
import { startDirectWifiSync } from './audioTransfer';
import { localTransfer } from './localTransfer';
import type {
  DeviceRecordingManifest,
  DeviceTransport,
} from './transport';

jest.mock('./auth', () => ({
  authenticatedRequest: jest.fn(),
}));
jest.mock('./localTransfer', () => ({
  localTransfer: {
    benchmark: jest.fn().mockResolvedValue({
      bytes: 16 * 1024 * 1024,
      bytesPerSecond: 2 * 1024 * 1024,
      elapsedMs: 8_000,
    }),
    benchmarkUdp: jest.fn().mockResolvedValue({
      bytes: 16 * 1024 * 1024,
      bytesPerSecond: 3 * 1024 * 1024,
      duplicates: 0,
      elapsedMs: 5_333,
      outOfOrder: 0,
      packetLossPercent: 0,
      packetsExpected: 12_123,
      packetsReceived: 12_123,
    }),
    cancelAll: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    deleteCachedPart: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(undefined),
    downloadRange: jest.fn(
      async (
        _jobId: string,
        _url: string,
        _token: string,
        _expectedBytes: number,
        cacheKey: string,
      ) => `/cache/${cacheKey}.part`,
    ),
    downloadRangeHybridUdp: jest.fn(
      async (
        _jobId: string,
        _url: string,
        _token: string,
        expectedBytes: number,
        cacheKey: string,
      ) => ({
        missingPackets: 0,
        packetLossPercent: 0,
        path: `/cache/${cacheKey}.part`,
        repairedBytes: 0,
        udpBytesPerSecond: expectedBytes,
      }),
    ),
    getAvailableCacheBytes: jest
      .fn()
      .mockResolvedValue(1024 * 1024 * 1024),
    getCachedPart: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn(() => ({ remove: jest.fn() })),
    uploadFile: jest.fn().mockResolvedValue({ bytes: 1 }),
    waitForInternet: jest.fn().mockResolvedValue(undefined),
  },
}));

const request = authenticatedRequest as jest.MockedFunction<
  typeof authenticatedRequest
>;

const recordings: DeviceRecordingManifest[] = [
  {
    contentType: 'audio/wav',
    fileName: 'rec_0001.wav',
    recordingId: 'sd-rec_0001.wav',
    sizeBytes: 1_024,
  },
  {
    contentType: 'audio/wav',
    fileName: 'rec_0002.wav',
    recordingId: 'sd-rec_0002.wav',
    sizeBytes: 2_048,
  },
];

function completedAnalysis() {
  return {
    acousticStage: { status: 'COMPLETED' },
    conversationStage: { status: 'COMPLETED' },
    scanStage: { status: 'COMPLETED' },
    status: 'COMPLETED',
    transcriptionStage: { status: 'COMPLETED' },
  };
}

test('uploads and releases every finalized recording', async () => {
  const statusReads = new Map<string, number>();
  let created = 0;
  request.mockImplementation(async (path, init) => {
    if (path === '/devices') {
      return [
        {
          childId: 'child-1',
          id: 'device-1',
          lifecycleStatus: 'active',
          pairingStatus: 'paired',
        },
      ] as never;
    }
    if (path === '/audio-analysis' && init?.method === 'POST') {
      created += 1;
      return {
        analysisId: `analysis-${created}`,
        multipart: { partCount: 1, partSizeBytes: 10 * 1024 * 1024 },
      } as never;
    }
    const analysisId = path.match(/analysis-\d/)?.[0];
    if (path.endsWith('/multipart/parts')) {
      return {
        parts: [
          {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            method: 'PUT',
            partNumber: 1,
            url: `http://storage/${analysisId}`,
          },
        ],
      } as never;
    }
    if (path.endsWith('/multipart') && init?.method !== 'DELETE') {
      const reads = (statusReads.get(analysisId ?? '') ?? 0) + 1;
      statusReads.set(analysisId ?? '', reads);
      const sizeBytes = analysisId === 'analysis-1' ? 1_024 : 2_048;
      return {
        completedBytes: reads === 1 ? 0 : sizeBytes,
        completedParts:
          reads === 1
            ? []
            : [{ etag: '"etag"', partNumber: 1, sizeBytes }],
        partCount: 1,
        partSizeBytes: 10 * 1024 * 1024,
        sizeBytes,
      } as never;
    }
    if (path.endsWith('/multipart/complete')) {
      return {} as never;
    }
    if (analysisId) {
      return completedAnalysis() as never;
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  const uploaded: string[] = [];
  const released: string[] = [];
  const onFileProgress = jest.fn();
  const transport = {
    checkFirmware: jest.fn(),
    listRecordingManifests: jest.fn().mockResolvedValue(recordings),
    getRecordingStatus: jest.fn().mockResolvedValue('recording'),
    releaseRecording: jest.fn(async (recordingId: string) => {
      released.push(recordingId);
    }),
    scanAndPair: jest.fn(),
    signPairingChallenge: jest.fn(),
    startLocalTransferAccessPoint: jest.fn().mockResolvedValue({
      baseUrl: 'http://192.168.4.1',
      password: 'password123',
      ssid: 'NearNest-Test',
      token: 'token',
    }),
    startRecording: jest.fn().mockResolvedValue(undefined),
    startSync: jest.fn(),
    stopLocalTransferAccessPoint: jest.fn().mockResolvedValue(undefined),
  } as unknown as DeviceTransport;
  (localTransfer.uploadFile as jest.Mock).mockImplementation(
    async (jobId: string) => {
      uploaded.push(
        jobId.startsWith('analysis-1')
          ? 'sd-rec_0001.wav'
          : 'sd-rec_0002.wav',
      );
      return { bytes: 1 };
    },
  );

  await new Promise<void>((resolve, reject) => {
    startDirectWifiSync(transport, {
      onComplete: resolve,
      onFailed: reject,
      onFileProgress,
      onProcessingStep: jest.fn(),
      onTransfer: jest.fn(),
      onUpload: jest.fn(),
    });
  });

  expect(created).toBe(2);
  expect(uploaded).toEqual([
    'sd-rec_0001.wav',
    'sd-rec_0002.wav',
  ]);
  expect(released).toEqual(uploaded);
  expect(request).not.toHaveBeenCalledWith(
    expect.stringMatching(/^\/audio-analysis\/analysis-\d+$/),
  );
  expect(onFileProgress.mock.calls).toEqual([
    [0, 2],
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
  expect(await AsyncStorage.getItem('nearnest.pending-wifi-transfer.v2')).toBe(
    null,
  );
});
