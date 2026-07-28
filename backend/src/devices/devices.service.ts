import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { ChildrenService } from '../children/children.service';
import { CompletePairingDto } from './dto/complete-pairing.dto';
import { DiscoverDeviceDto } from './dto/discover-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { VerifyDeviceChallengeDto } from './dto/verify-device-challenge.dto';
import {
  pairingChallengePayload,
  verifyPairingSignature,
} from './pairing-crypto';
import {
  DevicePairingSession,
  DevicePairingSessionDocument,
  PairingSessionStatus,
} from './schemas/device-pairing-session.schema';
import {
  Device,
  DeviceDocument,
  DeviceLifecycleStatus,
  DevicePairingStatus,
} from './schemas/device.schema';
import { DeviceResponse, PairingSessionResponse } from './devices.types';

const SESSION_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const SESSION_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class DevicesService {
  constructor(
    @InjectModel(Device.name)
    private readonly deviceModel: Model<Device>,
    @InjectModel(DevicePairingSession.name)
    private readonly sessionModel: Model<DevicePairingSession>,
    private readonly children: ChildrenService,
  ) {}

  async startPairing(ownerUserId: string): Promise<PairingSessionResponse> {
    const session = await this.sessionModel.create({
      ownerUserId,
      status: PairingSessionStatus.Created,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      purgeAt: new Date(Date.now() + SESSION_AUDIT_TTL_MS),
      failedAttempts: 0,
      maxAttempts: 5,
    });
    return this.toSessionResponse(session);
  }

  async discover(
    ownerUserId: string,
    sessionId: string,
    input: DiscoverDeviceDto,
  ): Promise<PairingSessionResponse> {
    const session = await this.findActiveSession(ownerUserId, sessionId, [
      PairingSessionStatus.Created,
      PairingSessionStatus.DeviceDiscovered,
    ]);
    const serialNumber = input.serialNumber.trim().toUpperCase();
    const device = await this.deviceModel
      .findOne({
        serialNumber,
        pairingStatus: DevicePairingStatus.Unpaired,
        lifecycleStatus: DeviceLifecycleStatus.Active,
      })
      .exec();
    if (!device) {
      throw new NotFoundException('Eligible pre-provisioned device not found');
    }

    if (
      session.deviceId &&
      !session.deviceId.equals(device._id)
    ) {
      throw new ConflictException(
        'Pairing session is already bound to another device',
      );
    }

    const challengeId = randomUUID();
    const challengeNonce = randomBytes(32).toString('base64url');
    const challengeExpiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const updated = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: session._id,
          ownerUserId,
          expiresAt: { $gt: new Date() },
          challengeConsumedAt: { $exists: false },
          status: {
            $in: [
              PairingSessionStatus.Created,
              PairingSessionStatus.DeviceDiscovered,
            ],
          },
        },
        {
          $set: {
            deviceId: device._id,
            serialNumber,
            status: PairingSessionStatus.DeviceDiscovered,
            challengeId,
            challengeNonce,
            challengeExpiresAt,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) {
      throw new ConflictException('Pairing session state changed');
    }
    return this.toSessionResponse(updated);
  }

  async verifyChallenge(
    ownerUserId: string,
    sessionId: string,
    input: VerifyDeviceChallengeDto,
  ): Promise<PairingSessionResponse> {
    const session = await this.findActiveSession(ownerUserId, sessionId, [
      PairingSessionStatus.DeviceDiscovered,
    ]);
    if (
      !session.deviceId ||
      !session.challengeId ||
      !session.challengeNonce ||
      !session.challengeExpiresAt ||
      session.challengeId !== input.challengeId ||
      session.challengeExpiresAt <= new Date() ||
      session.failedAttempts >= session.maxAttempts
    ) {
      throw new UnauthorizedException('Invalid or expired device challenge');
    }
    const device = await this.deviceModel.findById(session.deviceId).exec();
    if (
      !device ||
      device.pairingStatus !== DevicePairingStatus.Unpaired ||
      device.lifecycleStatus !== DeviceLifecycleStatus.Active
    ) {
      throw new ConflictException('Device is no longer eligible for pairing');
    }

    const payload = pairingChallengePayload(
      sessionId,
      session.challengeId,
      session.challengeNonce,
    );
    if (
      !verifyPairingSignature(
        device.identityPublicKeyPem,
        payload,
        input.signature,
      )
    ) {
      await this.sessionModel
        .updateOne(
          {
            _id: session._id,
            ownerUserId,
            challengeConsumedAt: { $exists: false },
          },
          {
            $inc: { failedAttempts: 1 },
          },
        )
        .exec();
      throw new UnauthorizedException('Invalid device challenge signature');
    }

    const verified = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: session._id,
          ownerUserId,
          challengeId: input.challengeId,
          challengeConsumedAt: { $exists: false },
          challengeExpiresAt: { $gt: new Date() },
          status: PairingSessionStatus.DeviceDiscovered,
          $expr: { $lt: ['$failedAttempts', '$maxAttempts'] },
        },
        {
          $set: {
            challengeConsumedAt: new Date(),
            status: PairingSessionStatus.Verified,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!verified) {
      throw new ConflictException('Device challenge was already consumed');
    }
    return this.toSessionResponse(verified);
  }

  async completePairing(
    ownerUserId: string,
    sessionId: string,
    input: CompletePairingDto,
  ): Promise<DeviceResponse> {
    const session = await this.findOwnedSession(ownerUserId, sessionId);
    if (session.status === PairingSessionStatus.Completed) {
      if (session.childId?.toHexString() !== input.childId || !session.deviceId) {
        throw new ConflictException(
          'Completed pairing cannot be rebound to another child',
        );
      }
      const existing = await this.deviceModel.findOne({
        _id: session.deviceId,
        ownerUserId,
        pairedSessionId: session._id,
      }).exec();
      if (!existing) {
        throw new ConflictException('Completed pairing device is unavailable');
      }
      return this.toDeviceResponse(existing);
    }
    this.assertSessionActive(session);
    if (
      session.status !== PairingSessionStatus.Verified ||
      !session.deviceId
    ) {
      throw new ConflictException('Device challenge has not been verified');
    }
    await this.children.getById(ownerUserId, input.childId);

    const childId = new Types.ObjectId(input.childId);
    const now = new Date();
    const device = await this.deviceModel
      .findOneAndUpdate(
        {
          _id: session.deviceId,
          pairingStatus: DevicePairingStatus.Unpaired,
          lifecycleStatus: DeviceLifecycleStatus.Active,
          ownerUserId: { $exists: false },
        },
        {
          $set: {
            childId,
            displayName: input.displayName.trim(),
            ownerUserId,
            pairedAt: now,
            pairedSessionId: session._id,
            pairingStatus: DevicePairingStatus.Paired,
          },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();
    if (!device) {
      const recovered = await this.deviceModel.findOne({
        _id: session.deviceId,
        ownerUserId,
        pairedSessionId: session._id,
      }).exec();
      if (!recovered) {
        throw new ConflictException('Device was claimed by another pairing');
      }
      await this.markSessionCompleted(session, childId, now);
      return this.toDeviceResponse(recovered);
    }

    await this.markSessionCompleted(session, childId, now);
    return this.toDeviceResponse(device);
  }

  async list(ownerUserId: string): Promise<DeviceResponse[]> {
    const devices = await this.deviceModel
      .find({ ownerUserId })
      .sort({ _id: -1 })
      .exec();
    return devices.map((device) => this.toDeviceResponse(device));
  }

  async get(ownerUserId: string, deviceId: string): Promise<DeviceResponse> {
    return this.toDeviceResponse(
      await this.findOwnedDevice(ownerUserId, deviceId),
    );
  }

  async update(
    ownerUserId: string,
    deviceId: string,
    input: UpdateDeviceDto,
  ): Promise<DeviceResponse> {
    const device = await this.deviceModel
      .findOneAndUpdate(
        { _id: this.objectId(deviceId), ownerUserId },
        { $set: { displayName: input.displayName.trim() } },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();
    if (!device) throw new NotFoundException('Device not found');
    return this.toDeviceResponse(device);
  }

  async unpair(ownerUserId: string, deviceId: string): Promise<DeviceResponse> {
    const device = await this.deviceModel
      .findOneAndUpdate(
        {
          _id: this.objectId(deviceId),
          ownerUserId,
          pairingStatus: DevicePairingStatus.Paired,
        },
        {
          $inc: { credentialVersion: 1 },
          $set: { pairingStatus: DevicePairingStatus.Unpaired },
          $unset: {
            childId: 1,
            ownerUserId: 1,
            pairedAt: 1,
            pairedSessionId: 1,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!device) throw new NotFoundException('Paired device not found');
    return this.toDeviceResponse(device);
  }

  async markLost(ownerUserId: string, deviceId: string): Promise<DeviceResponse> {
    const device = await this.deviceModel
      .findOneAndUpdate(
        { _id: this.objectId(deviceId), ownerUserId },
        {
          $inc: { credentialVersion: 1 },
          $set: {
            lifecycleStatus: DeviceLifecycleStatus.Lost,
            pairingStatus: DevicePairingStatus.Revoked,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!device) throw new NotFoundException('Device not found');
    return this.toDeviceResponse(device);
  }

  private async markSessionCompleted(
    session: DevicePairingSessionDocument,
    childId: Types.ObjectId,
    completedAt: Date,
  ): Promise<void> {
    await this.sessionModel.updateOne(
      {
        _id: session._id,
        status: PairingSessionStatus.Verified,
      },
      {
        $set: {
          childId,
          completedAt,
          purgeAt: new Date(Date.now() + SESSION_AUDIT_TTL_MS),
          status: PairingSessionStatus.Completed,
        },
      },
    ).exec();
  }

  private async findActiveSession(
    ownerUserId: string,
    sessionId: string,
    statuses: PairingSessionStatus[],
  ): Promise<DevicePairingSessionDocument> {
    const session = await this.findOwnedSession(ownerUserId, sessionId);
    this.assertSessionActive(session);
    if (!statuses.includes(session.status)) {
      throw new ConflictException('Pairing session is not in the required state');
    }
    return session;
  }

  private async findOwnedSession(
    ownerUserId: string,
    sessionId: string,
  ): Promise<DevicePairingSessionDocument> {
    const session = await this.sessionModel.findOne({
      _id: this.objectId(sessionId),
      ownerUserId,
    }).exec();
    if (!session) throw new NotFoundException('Pairing session not found');
    return session;
  }

  private assertSessionActive(session: DevicePairingSessionDocument): void {
    if (session.expiresAt <= new Date()) {
      throw new ForbiddenException('Pairing session has expired');
    }
  }

  private async findOwnedDevice(
    ownerUserId: string,
    deviceId: string,
  ): Promise<DeviceDocument> {
    const device = await this.deviceModel.findOne({
      _id: this.objectId(deviceId),
      ownerUserId,
    }).exec();
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  private objectId(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid identifier');
    }
    return new Types.ObjectId(id);
  }

  private toSessionResponse(
    session: DevicePairingSessionDocument,
  ): PairingSessionResponse {
    const challenge =
      session.status === PairingSessionStatus.DeviceDiscovered &&
      session.challengeId &&
      session.challengeNonce &&
      session.challengeExpiresAt
        ? {
            challengeId: session.challengeId,
            nonce: session.challengeNonce,
            expiresAt: session.challengeExpiresAt.toISOString(),
            payload: pairingChallengePayload(
              session._id.toHexString(),
              session.challengeId,
              session.challengeNonce,
            ),
          }
        : undefined;
    return {
      id: session._id.toHexString(),
      status: session.status,
      serialNumber: session.serialNumber,
      expiresAt: session.expiresAt.toISOString(),
      challenge,
    };
  }

  private toDeviceResponse(device: DeviceDocument): DeviceResponse {
    return {
      id: device._id.toHexString(),
      serialNumber: device.serialNumber,
      childId: device.childId?.toHexString(),
      displayName: device.displayName,
      hardwareRevision: device.hardwareRevision,
      firmwareVersion: device.firmwareVersion,
      pairingStatus: device.pairingStatus,
      lifecycleStatus: device.lifecycleStatus,
      pairedAt: device.pairedAt?.toISOString(),
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
    };
  }
}
