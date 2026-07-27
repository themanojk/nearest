/**
 * ESP device transport layer.
 *
 * The wearable is an ESP-class device. Pairing and the "transfer from device"
 * stage happen over BLE (react-native-ble-plx); the bulk audio transfer +
 * cloud upload happen over WiFi (the device joins the same network / exposes an
 * HTTP endpoint, or hands the file to the phone which uploads it).
 *
 * This module exposes ONE interface with two implementations:
 *   - SimulatedTransport  — timings match the prototype so the whole app is
 *                           clickable with no hardware. Default.
 *   - BleWifiTransport    — real integration points, guarded so the app still
 *                           builds/runs without a device or on the simulator.
 *
 * Swap the exported `transport` (or wire a runtime flag) once the firmware
 * contract is finalised. Everything above this layer (sync flow, pairing UI)
 * is written against `DeviceTransport` only.
 */

export type SyncCallbacks = {
  onTransfer: (progress: number) => void; // 0..1
  onUpload: (progress: number) => void; // 0..1
  onProcessingStep: (index: number) => void; // step 0..3 completed
  onComplete: () => void;
  onFailed: (reason: string) => void;
};

export type SyncHandle = { cancel: () => void };

export type PairedDevice = { id: string; code: string; name: string };

export interface DeviceTransport {
  /** BLE scan + bond. Resolves when a device is found (or rejects on timeout). */
  scanAndPair(): Promise<PairedDevice>;
  /** Contact the bonded device over BLE to compare firmware. */
  checkFirmware(): Promise<{ version: string; upToDate: boolean }>;
  /** Run the full transfer→upload→process pipeline. Returns a cancel handle. */
  startSync(cbs: SyncCallbacks): SyncHandle;
}

// ---------------------------------------------------------------------------
// Simulated transport (default) — mirrors prototype timings (handoff §Motion).
// ---------------------------------------------------------------------------

class SimulatedTransport implements DeviceTransport {
  scanAndPair(): Promise<PairedDevice> {
    return new Promise((resolve) => {
      // Pairing search: 1700ms before "device found" (§4).
      setTimeout(
        () => resolve({ id: 'sim-nn-7734', code: 'NN · 7734', name: "Aarav's Device" }),
        1700,
      );
    });
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
      ramp(1500, cbs.onTransfer, () => track(setTimeout(runUpload, 150)));

    const runUpload = () =>
      ramp(1500, cbs.onUpload, () => track(setTimeout(runProcessing, 150)));

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
// Real BLE + WiFi transport — integration points. Guarded so importing this
// module never crashes when the native BLE module or a device is unavailable
// (e.g. iOS Simulator has no Bluetooth radio).
// ---------------------------------------------------------------------------

export class BleWifiTransport implements DeviceTransport {
  // Lazily created so react-native-ble-plx isn't touched unless we go real.
  private manager: any | null = null;

  private getManager() {
    if (!this.manager) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BleManager } = require('react-native-ble-plx');
      this.manager = new BleManager();
    }
    return this.manager;
  }

  async scanAndPair(): Promise<PairedDevice> {
    // TODO(device): request BLE permissions, scan for the NearNest service
    // UUID, connect + discover services, read the pairing code characteristic,
    // and bond. Reject with a typed error for the real failure paths the
    // handoff calls out: not found, out of range, already paired.
    throw new Error('BleWifiTransport.scanAndPair not yet implemented');
  }

  async checkFirmware(): Promise<{ version: string; upToDate: boolean }> {
    // TODO(device): read the firmware-version characteristic over BLE and
    // compare against the latest known release from the backend.
    throw new Error('BleWifiTransport.checkFirmware not yet implemented');
  }

  startSync(cbs: SyncCallbacks): SyncHandle {
    // TODO(device):
    //   1. BLE: instruct the device to begin transfer; stream chunks and report
    //      progress via cbs.onTransfer. For large recordings, have the device
    //      join WiFi and pull the file over HTTP for throughput.
    //   2. WiFi: upload the recording to the backend presigned URL (see
    //      backend /v1/audio-analysis) and report cbs.onUpload progress.
    //   3. Poll the backend job for processing steps -> cbs.onProcessingStep,
    //      then cbs.onComplete. Any dropped BLE link / failed upload ->
    //      cbs.onFailed (no sync credit is consumed on failure).
    cbs.onFailed('BleWifiTransport.startSync not yet implemented');
    return { cancel: () => {} };
  }
}

/** Active transport. Flip to `new BleWifiTransport()` when wiring hardware. */
export const transport: DeviceTransport = new SimulatedTransport();
