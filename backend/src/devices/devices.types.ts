import {
  DeviceLifecycleStatus,
  DevicePairingStatus,
} from './schemas/device.schema';

export interface DeviceResponse {
  childId?: string;
  createdAt: string;
  displayName?: string;
  firmwareVersion: string;
  hardwareRevision: string;
  id: string;
  lifecycleStatus: DeviceLifecycleStatus;
  pairedAt?: string;
  pairingStatus: DevicePairingStatus;
  serialNumber: string;
  updatedAt: string;
}

export interface PairingSessionResponse {
  challenge?: {
    challengeId: string;
    expiresAt: string;
    nonce: string;
    payload: string;
  };
  device?: DeviceResponse;
  expiresAt: string;
  id: string;
  serialNumber?: string;
  status: string;
}

