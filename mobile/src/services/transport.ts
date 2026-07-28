/**
 * ESP device transport layer.
 *
 * The wearable is an ESP-class device. Pairing and the "transfer from device"
 * stage happen over BLE (react-native-ble-plx); the bulk audio transfer +
 * cloud upload happen over WiFi (the device joins the same network / exposes an
 * HTTP endpoint, or hands the file to the phone which uploads it).
 *
 * This module exposes ONE interface with two implementations:
 *   - SimulatedTransport  — retained for unit tests and explicit UI previews.
 *   - BleWifiTransport    — BLE control + isolated hotspot negotiation, used
 *                           by the shipped app.
 *
 * Everything above this layer (sync flow, pairing UI) is written against
 * `DeviceTransport` only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import { PermissionsAndroid, Platform } from 'react-native';
import type {
  BleError,
  BleManager,
  Characteristic,
  Device,
  Subscription,
} from 'react-native-ble-plx';
import { startDirectWifiSync } from './audioTransfer';

export type SyncCallbacks = {
  onFileProgress: (completedFiles: number, totalFiles: number) => void;
  onNetworkBenchmark?: (bytesPerSecond: number) => void;
  onNetworkBenchmarkState?: (running: boolean) => void;
  onTransfer: (progress: number) => void; // 0..1
  onTransferTelemetry?: (telemetry: {
    bytesPerSecond: number;
    etaSeconds: number | null;
    totalBytes: number;
    transferredBytes: number;
  }) => void;
  onUpload: (progress: number) => void; // 0..1
  onProcessingStep: (index: number) => void; // step 0..3 completed
  onComplete: () => void;
  onFailed: (reason: string) => void;
};

export type SyncHandle = { cancel: () => void };

export type PairedDevice = {
  code: string;
  id: string;
  name: string;
  serialNumber: string;
  trust: 'hardware' | 'simulated';
};

export type DeviceRecordingManifest = {
  contentType: string;
  fileName: string;
  recordingId: string;
  sizeBytes: number;
};

export type LocalTransferAccess = {
  baseUrl: string;
  password: string;
  ssid: string;
  token: string;
};

export type DeviceTelemetry = {
  batteryPercent: number | null;
  storageTotalBytes: number;
  storageUsedBytes: number;
};

export interface DeviceTransport {
  /** BLE scan + bond. Resolves when a device is found (or rejects on timeout). */
  scanAndPair(): Promise<PairedDevice>;
  /**
   * Ask the hardware secure identity to sign the server-provided payload.
   * Implementations must never expose or export the device private key.
   */
  signPairingChallenge(payload: string): Promise<string>;
  /** List finalized recording metadata over BLE; audio bytes never use BLE. */
  listRecordingManifests(
    onCatalogProgress?: (recordingsFound: number) => void,
  ): Promise<DeviceRecordingManifest[]>;
  /** Start the isolated WPA2 recording network and receive its secret over BLE. */
  startLocalTransferAccessPoint(): Promise<LocalTransferAccess>;
  /** Stop the isolated recording network. */
  stopLocalTransferAccessPoint(): Promise<void>;
  /** Read the recorder's current state over BLE. */
  getRecordingStatus(): Promise<'idle' | 'recording'>;
  /** Read live battery and SD capacity from the wearable over BLE. */
  getDeviceTelemetry(): Promise<DeviceTelemetry>;
  /** Explicitly begin a fresh recording. */
  startRecording(): Promise<void>;
  /** Release SD audio only after backend multipart completion succeeds. */
  releaseRecording(recordingId: string): Promise<void>;
  /** Contact the bonded device over BLE to compare firmware. */
  checkFirmware(): Promise<{ version: string; upToDate: boolean }>;
  /** Run the full transfer→upload→process pipeline. Returns a cancel handle. */
  startSync(cbs: SyncCallbacks): SyncHandle;
}

// ---------------------------------------------------------------------------
// Simulated transport (default) — mirrors prototype timings (handoff §Motion).
// ---------------------------------------------------------------------------

export class SimulatedTransport implements DeviceTransport {
  scanAndPair(): Promise<PairedDevice> {
    return new Promise((resolve) => {
      // Pairing search: 1700ms before "device found" (§4).
      setTimeout(
        () =>
          resolve({
            id: 'sim-nn-7734',
            code: 'NN · 7734',
            name: "Aarav's Device",
            serialNumber: 'SIM-NN-7734',
            trust: 'simulated',
          }),
        1700,
      );
    });
  }

  signPairingChallenge(): Promise<string> {
    return Promise.reject(
      new Error('Simulated devices cannot produce a trusted pairing signature'),
    );
  }

  listRecordingManifests(
    onCatalogProgress?: (recordingsFound: number) => void,
  ): Promise<DeviceRecordingManifest[]> {
    const recordings = [
      {
        recordingId: 'sim-recording-morning',
        fileName: 'morning.wav',
        contentType: 'audio/wav',
        sizeBytes: 240 * 1024 * 1024,
      },
      {
        recordingId: 'sim-recording-afternoon',
        fileName: 'afternoon.wav',
        contentType: 'audio/wav',
        sizeBytes: 260 * 1024 * 1024,
      },
    ];
    recordings.forEach((_, index) => onCatalogProgress?.(index + 1));
    return Promise.resolve(recordings);
  }

  startLocalTransferAccessPoint(): Promise<LocalTransferAccess> {
    return Promise.resolve({
      baseUrl: 'http://192.168.4.1',
      password: 'simulated-password',
      ssid: 'NearNest-Simulated',
      token: 'simulated-token',
    });
  }

  stopLocalTransferAccessPoint(): Promise<void> {
    return Promise.resolve();
  }

  releaseRecording(): Promise<void> {
    return Promise.resolve();
  }

  getRecordingStatus(): Promise<'idle' | 'recording'> {
    return Promise.resolve('idle');
  }

  getDeviceTelemetry(): Promise<DeviceTelemetry> {
    return Promise.resolve({
      batteryPercent: null,
      storageTotalBytes: 32 * 1024 * 1024 * 1024,
      storageUsedBytes: 0,
    });
  }

  startRecording(): Promise<void> {
    return Promise.resolve();
  }

  checkFirmware(): Promise<{ version: string; upToDate: boolean }> {
    // Firmware check: 1400ms before "up to date" (§Motion).
    return new Promise((resolve) =>
      setTimeout(() => resolve({ version: '2.3.1', upToDate: true }), 1400),
    );
  }

  startSync(cbs: SyncCallbacks): SyncHandle {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];
    let cancelled = false;
    const track = (t: ReturnType<typeof setTimeout>) => (timers.push(t), t);

    const ramp = (
      durationMs: number,
      onTick: (p: number) => void,
      onDone: () => void,
    ) => {
      const stepMs = 100; // progress bar fill: width 0.1s linear (§Motion)
      const steps = Math.max(1, Math.round(durationMs / stepMs));
      let i = 0;
      const iv = setInterval(() => {
        if (cancelled) return;
        i += 1;
        onTick(Math.min(1, i / steps));
        if (i >= steps) {
          clearInterval(iv);
          onDone();
        }
      }, stepMs);
      intervals.push(iv);
    };

    // transferring (~1500ms) → uploading (~1500ms) → processing (4 steps).
    const runTransfer = () =>
      ramp(1500, cbs.onTransfer, () => {
        cbs.onFileProgress(0, 2);
        track(setTimeout(runUpload, 150));
      });

    const runUpload = () =>
      ramp(1500, cbs.onUpload, () => {
        cbs.onFileProgress(2, 2);
        track(setTimeout(runProcessing, 150));
      });

    const runProcessing = () => {
      // 4 steps at 550ms + 600ms stagger, then 550ms to completion (§Motion).
      let step = 0;
      const advance = () => {
        if (cancelled) return;
        cbs.onProcessingStep(step);
        step += 1;
        if (step < 4) {
          track(setTimeout(advance, 550 + 600));
        } else {
          track(setTimeout(() => !cancelled && cbs.onComplete(), 550));
        }
      };
      track(setTimeout(advance, 550));
    };

    track(setTimeout(runTransfer, 100));

    return {
      cancel: () => {
        cancelled = true;
        timers.forEach(clearTimeout);
        intervals.forEach(clearInterval);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Real BLE + WiFi transport.
// ---------------------------------------------------------------------------

const SERVICE_UUID = '8ec90001-f315-4f60-9fb8-838830daea50';
const IDENTITY_UUID = '8ec90002-f315-4f60-9fb8-838830daea50';
const COMMAND_UUID = '8ec90003-f315-4f60-9fb8-838830daea50';
const STATUS_UUID = '8ec90004-f315-4f60-9fb8-838830daea50';
const STORED_DEVICE_KEY = 'nearnest.ble-device.v1';
const SCAN_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;

type DeviceIdentity = {
  firmwareVersion: string;
  hardwareRevision: string;
  identityReady: boolean;
  pairingCodeHint: number;
  serialNumber: string;
};

type FirmwareStatus = {
  batteryPercent?: number | null;
  baseUrl?: string;
  code?: string;
  contentType?: string;
  event: string;
  fileName?: string;
  message?: string;
  partNumber?: number;
  password?: string;
  recordingId?: string;
  sentBytes?: number;
  signature?: string;
  sizeBytes?: number;
  ssid?: string;
  state?: string;
  storageTotalBytes?: number;
  storageUsedBytes?: number;
  token?: string;
  totalBytes?: number;
};

type StatusWaiter = {
  predicate: (status: FirmwareStatus) => boolean;
  reject: (error: Error) => void;
  resolve: (status: FirmwareStatus) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BleWifiTransport implements DeviceTransport {
  private manager: BleManager | null = null;
  private device: Device | null = null;
  private identity: DeviceIdentity | null = null;
  private statusSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private waiters: StatusWaiter[] = [];

  private getManager(): BleManager {
    if (!this.manager) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BleManager } = require('react-native-ble-plx');
      const manager = new BleManager() as BleManager;
      this.manager = manager;
      return manager;
    }
    return this.manager;
  }

  async scanAndPair(): Promise<PairedDevice> {
    await this.requestPermissions();
    await this.waitForBluetooth();
    // A previous pairing attempt may have found and connected the ESP before a
    // later backend step failed. Connected BLE peripherals stop advertising,
    // so scanning again would incorrectly report "not found". Reuse the secure
    // connection (or the stored peripheral) before starting a fresh scan.
    await this.ensureConnected();
    const candidate = this.device;
    const identity = this.identity;
    if (!candidate || !identity) {
      throw new Error('Wearable connected without returning its identity');
    }
    await AsyncStorage.setItem(
      STORED_DEVICE_KEY,
      JSON.stringify({
        deviceId: candidate.id,
        serialNumber: identity.serialNumber,
      }),
    );
    const hint = String(identity.pairingCodeHint).padStart(2, '0');
    return {
      id: candidate.id,
      code: `NN · ••••${hint}`,
      name: candidate.name ?? `NearNest ${identity.serialNumber}`,
      serialNumber: identity.serialNumber,
      trust: 'hardware',
    };
  }

  async signPairingChallenge(payload: string): Promise<string> {
    const status = await this.commandAndWait(
      { op: 'pair.challenge', payload },
      (candidate) => candidate.event === 'pair.signature',
    );
    if (!status.signature) {
      throw new Error('Wearable returned an empty pairing signature');
    }
    return status.signature;
  }

  async listRecordingManifests(
    onCatalogProgress?: (recordingsFound: number) => void,
  ): Promise<DeviceRecordingManifest[]> {
    let receivedReady = true;
    try {
      const stopStatus = await this.commandAndWait(
        { op: 'recording.stop' },
        (candidate) =>
          candidate.event === 'recording.ready' ||
          candidate.event === 'recording.idle',
        5_000,
      );
      receivedReady =
        stopStatus.event === 'recording.ready' ||
        stopStatus.event === 'recording.idle';
    } catch (error) {
      if (!this.errorMessage(error).includes('before the timeout')) {
        throw error;
      }
      receivedReady = false;
    }

    if (!receivedReady) {
      // Firmware before the multi-recording protocol exposes only the current
      // finalized recording. This keeps sync operational until it is flashed.
      let status: FirmwareStatus;
      try {
        status = await this.commandAndWait(
          { op: 'recording.manifest' },
          (candidate) => candidate.event === 'recording.manifest',
        );
      } catch (error) {
        if (this.errorMessage(error).includes('recording.not_ready')) {
          throw new Error(
            'The ESP is running older firmware and has no finalized recording available. Flash the latest NearNestFirmware sketch and restart the ESP.',
          );
        }
        throw error;
      }
      const recording = this.recordingFromStatus(status);
      onCatalogProgress?.(1);
      return [recording];
    }
    const recordings = await this.readRecordingCatalog(onCatalogProgress);
    return recordings;
  }

  private async readRecordingCatalog(
    onCatalogProgress?: (recordingsFound: number) => void,
  ): Promise<DeviceRecordingManifest[]> {
    const recordings: DeviceRecordingManifest[] = [];
    let afterFileName = '';
    for (let index = 0; index < 10_000; index += 1) {
      const status = await this.commandAndWait(
        { afterFileName, op: 'recordings.next' },
        (candidate) =>
          candidate.event === 'recording.item' ||
          candidate.event === 'recording.list_complete',
      );
      if (status.event === 'recording.list_complete') break;
      const recording = this.recordingFromStatus(status);
      if (recording.fileName.localeCompare(afterFileName) <= 0) {
        throw new Error('Wearable returned an invalid recording catalog item');
      }
      recordings.push(recording);
      onCatalogProgress?.(recordings.length);
      afterFileName = recording.fileName;
    }
    return recordings;
  }

  async startLocalTransferAccessPoint(): Promise<LocalTransferAccess> {
    const status = await this.commandAndWait(
      { op: 'transfer.ap.start' },
      (candidate) => candidate.event === 'transfer.ap_ready',
    );
    if (
      !status.ssid ||
      !status.password ||
      !status.baseUrl ||
      !status.token
    ) {
      throw new Error('Wearable returned invalid transfer network details');
    }
    return {
      baseUrl: status.baseUrl,
      password: status.password,
      ssid: status.ssid,
      token: status.token,
    };
  }

  async stopLocalTransferAccessPoint(): Promise<void> {
    await this.commandAndWait(
      { op: 'transfer.ap.stop' },
      (candidate) => candidate.event === 'transfer.ap_stopped',
      10_000,
    );
  }

  async getRecordingStatus(): Promise<'idle' | 'recording'> {
    const status = await this.commandAndWait(
      { op: 'recording.status' },
      (candidate) => candidate.event === 'recording.status',
    );
    if (status.state !== 'idle' && status.state !== 'recording') {
      throw new Error('Wearable returned an invalid recording state');
    }
    return status.state;
  }

  async getDeviceTelemetry(): Promise<DeviceTelemetry> {
    const status = await this.commandAndWait(
      { op: 'device.telemetry' },
      (candidate) => candidate.event === 'device.telemetry',
    );
    const batteryPercent =
      status.batteryPercent === null
        ? null
        : Number(status.batteryPercent);
    const storageUsedBytes = Number(status.storageUsedBytes);
    const storageTotalBytes = Number(status.storageTotalBytes);
    if (
      (batteryPercent !== null &&
        (!Number.isFinite(batteryPercent) ||
          batteryPercent < 0 ||
          batteryPercent > 100)) ||
      !Number.isSafeInteger(storageUsedBytes) ||
      storageUsedBytes < 0 ||
      !Number.isSafeInteger(storageTotalBytes) ||
      storageTotalBytes <= 0 ||
      storageUsedBytes > storageTotalBytes
    ) {
      throw new Error('Wearable returned invalid device telemetry');
    }
    return {
      batteryPercent,
      storageTotalBytes,
      storageUsedBytes,
    };
  }

  async startRecording(): Promise<void> {
    await this.commandAndWait(
      { op: 'recording.start' },
      (candidate) => candidate.event === 'recording.started',
    );
  }

  async releaseRecording(recordingId: string): Promise<void> {
    await this.commandAndWait(
      { op: 'recording.release', recordingId },
      (candidate) =>
        candidate.event === 'recording.released' &&
        candidate.recordingId === recordingId,
    );
  }

  async checkFirmware(): Promise<{ version: string; upToDate: boolean }> {
    await this.ensureConnected();
    const identity = await this.readIdentity(this.device as Device);
    this.identity = identity;
    return { version: identity.firmwareVersion, upToDate: true };
  }

  startSync(cbs: SyncCallbacks): SyncHandle {
    const sync = startDirectWifiSync(this, cbs);
    return {
      cancel: () => {
        sync.cancel();
        void this.cancelActiveUpload();
      },
    };
  }

  private async requestPermissions(): Promise<void> {
    if (Platform.OS !== 'android') return;
    const permissions =
      Number(Platform.Version) >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            ...(Number(Platform.Version) >= 33
              ? [PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES]
              : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]),
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const results = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.some(
      (permission) =>
        results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );
    if (denied) {
      throw new Error('Bluetooth permission is required to find the wearable');
    }
  }

  private async waitForBluetooth(): Promise<void> {
    const manager = this.getManager();
    if ((await manager.state()) === 'PoweredOn') return;
    await new Promise<void>((resolve, reject) => {
      let subscription: Subscription | null = null;
      const timer = setTimeout(() => {
        subscription?.remove();
        reject(new Error('Turn on Bluetooth and try again'));
      }, 15_000);
      subscription = manager.onStateChange((state) => {
        if (state !== 'PoweredOn') return;
        clearTimeout(timer);
        subscription?.remove();
        resolve();
      }, true);
    });
  }

  private scanForDevice(): Promise<Device> {
    const manager = this.getManager();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, device?: Device) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        manager.stopDeviceScan();
        if (error) reject(error);
        else if (device) resolve(device);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'No NearNest wearable found. Keep it nearby and in pairing mode.',
            ),
          ),
        SCAN_TIMEOUT_MS,
      );
      manager.startDeviceScan(
        [SERVICE_UUID],
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            finish(new Error(this.bleMessage(error)));
          } else if (device) {
            finish(undefined, device);
          }
        },
      );
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.device && (await this.device.isConnected().catch(() => false))) {
      return;
    }
    await this.requestPermissions();
    await this.waitForBluetooth();

    const storedRaw = await AsyncStorage.getItem(STORED_DEVICE_KEY);
    const stored = storedRaw
      ? (JSON.parse(storedRaw) as {
          deviceId?: string;
          serialNumber?: string;
        })
      : undefined;
    if (stored?.deviceId) {
      const known = await this.getManager()
        .devices([stored.deviceId])
        .catch(() => []);
      if (known[0]) {
        try {
          await this.connectDevice(known[0], stored.serialNumber);
          return;
        } catch {
          // Fall back to scanning; Android can rotate or forget BLE handles.
        }
      }
    }

    const candidate = await this.scanForDevice();
    await this.connectDevice(candidate, stored?.serialNumber);
  }

  private async connectDevice(
    candidate: Device,
    expectedSerialNumber?: string,
  ): Promise<DeviceIdentity> {
    this.clearSubscriptions();
    let connected = candidate;
    if (!(await candidate.isConnected().catch(() => false))) {
      connected = await candidate.connect({
        autoConnect: false,
        requestMTU: 517,
        timeout: 20_000,
      });
    }
    connected = await connected.discoverAllServicesAndCharacteristics();
    if (Platform.OS === 'android' && connected.mtu < 100) {
      connected = await connected.requestMTU(517).catch(() => connected);
    }

    const identity = await this.readIdentity(connected);
    if (
      expectedSerialNumber &&
      identity.serialNumber !== expectedSerialNumber
    ) {
      await connected.cancelConnection().catch(() => undefined);
      throw new Error(
        `Found ${identity.serialNumber}, expected ${expectedSerialNumber}`,
      );
    }
    if (!identity.identityReady) {
      await connected.cancelConnection().catch(() => undefined);
      throw new Error(
        'Wearable identity is not provisioned. Flash device_secrets.h first.',
      );
    }

    this.device = connected;
    this.identity = identity;
    await this.establishSecureStatusChannel(connected);
    this.disconnectSubscription = connected.onDisconnected((error) => {
      this.device = null;
      this.identity = null;
      this.rejectWaiters(
        new Error(
          error
            ? `Wearable disconnected: ${this.bleMessage(error)}`
            : 'Wearable disconnected',
        ),
      );
    });
    return identity;
  }

  private async establishSecureStatusChannel(device: Device): Promise<void> {
    let initial: Characteristic | null = null;
    try {
      // Reading an authenticated characteristic asks Android/iOS to establish
      // the bond and show the system passkey prompt.
      initial = await device.readCharacteristicForService(
        SERVICE_UUID,
        STATUS_UUID,
      );
    } catch (error) {
      throw new Error(
        `Secure Bluetooth pairing failed. Enter the six-digit code printed on the wearable label. ${this.errorMessage(
          error,
        )}`,
      );
    }
    this.consumeCharacteristic(initial);
    this.statusSubscription = device.monitorCharacteristicForService(
      SERVICE_UUID,
      STATUS_UUID,
      (error, characteristic) => {
        if (error) {
          this.rejectWaiters(
            new Error(`Bluetooth status channel failed: ${this.bleMessage(error)}`),
          );
          return;
        }
        if (characteristic) this.consumeCharacteristic(characteristic);
      },
    );
  }

  private async readIdentity(device: Device): Promise<DeviceIdentity> {
    const characteristic = await device.readCharacteristicForService(
      SERVICE_UUID,
      IDENTITY_UUID,
    );
    if (!characteristic.value) {
      throw new Error('Wearable identity characteristic was empty');
    }
    const identity = JSON.parse(
      Buffer.from(characteristic.value, 'base64').toString('utf8'),
    ) as Partial<DeviceIdentity>;
    if (
      !identity.serialNumber ||
      !identity.hardwareRevision ||
      !identity.firmwareVersion ||
      !Number.isInteger(identity.pairingCodeHint)
    ) {
      throw new Error('Wearable returned invalid identity metadata');
    }
    return identity as DeviceIdentity;
  }

  private async commandAndWait(
    command: Record<string, unknown>,
    predicate: (status: FirmwareStatus) => boolean,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<FirmwareStatus> {
    await this.ensureConnected();
    const response = this.waitForStatus(predicate, timeoutMs);
    try {
      await this.writeCommand(command);
    } catch (error) {
      this.rejectWaiters(
        error instanceof Error ? error : new Error('BLE command failed'),
      );
      await response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  private recordingFromStatus(
    status: FirmwareStatus,
  ): DeviceRecordingManifest {
    if (
      !status.recordingId ||
      !status.fileName ||
      !status.contentType ||
      !Number.isSafeInteger(status.sizeBytes) ||
      (status.sizeBytes ?? 0) <= 0
    ) {
      throw new Error('Wearable returned invalid recording metadata');
    }
    return {
      contentType: status.contentType,
      fileName: status.fileName,
      recordingId: status.recordingId,
      sizeBytes: status.sizeBytes as number,
    };
  }

  private waitForStatus(
    predicate: (status: FirmwareStatus) => boolean,
    timeoutMs: number,
  ): Promise<FirmwareStatus> {
    return new Promise((resolve, reject) => {
      const waiter: StatusWaiter = {
        predicate,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(
            (candidate) => candidate !== waiter,
          );
          reject(new Error('Wearable did not respond before the timeout'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private async writeCommand(command: Record<string, unknown>): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('Wearable is not connected');
    const bytes = Buffer.from(JSON.stringify(command), 'utf8');
    console.info(`[NearNest BLE] command ${String(command.op ?? 'unknown')}`);
    if (bytes.length > 4096) {
      throw new Error('BLE command exceeds the firmware limit');
    }
    const chunkSize = Math.max(20, Math.min(180, device.mtu - 3));
    await this.writePacket(device, Buffer.from(`BEGIN:${bytes.length}`, 'utf8'));
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      await this.writePacket(device, bytes.subarray(offset, offset + chunkSize));
    }
  }

  private writePacket(
    device: Device,
    packet: Uint8Array,
  ): Promise<Characteristic> {
    return device.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      COMMAND_UUID,
      Buffer.from(packet).toString('base64'),
    );
  }

  private consumeCharacteristic(characteristic: Characteristic): void {
    if (!characteristic.value) return;
    try {
      const status = JSON.parse(
        Buffer.from(characteristic.value, 'base64').toString('utf8'),
      ) as FirmwareStatus;
      if (!status.event) return;
      console.info(
        `[NearNest BLE] status ${status.event}${
          status.code ? ` (${status.code})` : ''
        }`,
      );
      if (status.event === 'error') {
        this.rejectWaiters(
          new Error(
            status.message
              ? `${status.message}${status.code ? ` (${status.code})` : ''}`
              : status.code ?? 'Wearable reported an error',
          ),
        );
        return;
      }
      const matched = this.waiters.filter((waiter) =>
        waiter.predicate(status),
      );
      this.waiters = this.waiters.filter((waiter) => !matched.includes(waiter));
      matched.forEach((waiter) => {
        clearTimeout(waiter.timer);
        waiter.resolve(status);
      });
    } catch {
      this.rejectWaiters(new Error('Wearable returned invalid status data'));
    }
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }

  private clearSubscriptions(): void {
    this.statusSubscription?.remove();
    this.disconnectSubscription?.remove();
    this.statusSubscription = null;
    this.disconnectSubscription = null;
  }

  private async cancelActiveUpload(): Promise<void> {
    const device = this.device;
    if (!device || !(await device.isConnected().catch(() => false))) return;
    await this.writeCommand({ op: 'transfer.ap.stop' }).catch(() => undefined);
  }

  private bleMessage(error: BleError): string {
    return error.reason ?? error.message ?? 'Bluetooth operation failed';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Bluetooth operation failed';
  }
}

/** Active hardware transport. SimulatedTransport remains available to tests. */
export const transport: DeviceTransport = new BleWifiTransport();
