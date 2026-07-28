import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { DevicesService } from './devices.service';
import { PairingSessionStatus } from './schemas/device-pairing-session.schema';

function query<T>(result: T) {
  return {
    exec: jest.fn().mockResolvedValue(result),
    sort: jest.fn().mockReturnThis(),
  };
}

describe('DevicesService security boundaries', () => {
  const deviceModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
  };
  const sessionModel = {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };
  const children = { getById: jest.fn() };
  const service = new DevicesService(
    deviceModel as never,
    sessionModel as never,
    children as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('always scopes device reads to the authenticated owner', async () => {
    deviceModel.findOne.mockReturnValue(query(null));
    const deviceId = new Types.ObjectId().toHexString();

    await expect(service.get('owner-a', deviceId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(deviceModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(deviceId),
      ownerUserId: 'owner-a',
    });
  });

  it('rejects expired sessions before touching a device', async () => {
    const sessionId = new Types.ObjectId();
    sessionModel.findOne.mockReturnValue(
      query({
        _id: sessionId,
        ownerUserId: 'owner-a',
        status: PairingSessionStatus.DeviceDiscovered,
        expiresAt: new Date(Date.now() - 1),
      }),
    );

    await expect(
      service.verifyChallenge('owner-a', sessionId.toHexString(), {
        challengeId: '8b3d81d0-ff8f-4da3-9263-7695e16da571',
        signature: 'a'.repeat(86),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deviceModel.findById).not.toHaveBeenCalled();
  });

  it('does not rebind a completed session to another child', async () => {
    const sessionId = new Types.ObjectId();
    sessionModel.findOne.mockReturnValue(
      query({
        _id: sessionId,
        ownerUserId: 'owner-a',
        status: PairingSessionStatus.Completed,
        expiresAt: new Date(Date.now() + 60_000),
        childId: new Types.ObjectId(),
        deviceId: new Types.ObjectId(),
      }),
    );

    await expect(
      service.completePairing('owner-a', sessionId.toHexString(), {
        childId: new Types.ObjectId().toHexString(),
        displayName: 'School wearable',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(children.getById).not.toHaveBeenCalled();
    expect(deviceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects challenge replay after verification', async () => {
    const sessionId = new Types.ObjectId();
    sessionModel.findOne.mockReturnValue(
      query({
        _id: sessionId,
        ownerUserId: 'owner-a',
        status: PairingSessionStatus.Verified,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await expect(
      service.verifyChallenge('owner-a', sessionId.toHexString(), {
        challengeId: '8b3d81d0-ff8f-4da3-9263-7695e16da571',
        signature: 'a'.repeat(86),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

