/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import {
  AuthProvider,
  UserDocument,
  UserStatus,
} from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  OtpChallenge,
  OtpChallengeDocument,
  OtpChannel,
} from './schemas/otp-challenge.schema';
import {
  RefreshSession,
  RefreshSessionDocument,
} from './schemas/refresh-session.schema';

const USER_ID = new Types.ObjectId('66a111111111111111111111');

function userDocument(): UserDocument {
  const now = new Date('2026-07-27T10:00:00.000Z');
  return {
    _id: USER_ID,
    authProvider: AuthProvider.EmailOtp,
    email: 'parent@example.com',
    status: UserStatus.Active,
    preferences: {
      language: 'en',
      timezone: 'UTC',
      notificationChannels: {
        email: false,
        push: true,
        sms: false,
      },
    },
    createdAt: now,
    updatedAt: now,
  } as unknown as UserDocument;
}

describe('AuthService', () => {
  function setup() {
    let challenge: OtpChallengeDocument | undefined;
    const otpModel = {
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
      create: jest.fn().mockImplementation(
        (input: OtpChallenge & { _id: Types.ObjectId }) => {
          challenge = {
            ...input,
            createdAt: new Date(),
          } as unknown as OtpChallengeDocument;
          return Promise.resolve(challenge);
        },
      ),
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockImplementation(() => Promise.resolve(challenge)),
      }),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockImplementation(() => Promise.resolve(challenge)),
      }),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }),
    } as unknown as Model<OtpChallenge>;

    const refreshSession = {
      _id: new Types.ObjectId('66a222222222222222222222'),
      userId: USER_ID,
      tokenHash: 'stored-hash',
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as RefreshSessionDocument;
    const refreshModel = {
      create: jest.fn().mockResolvedValue(refreshSession),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(refreshSession),
      }),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }),
    } as unknown as Model<RefreshSession>;

    const user = userDocument();
    const users = {
      findOrCreateEmailUser: jest.fn().mockResolvedValue(user),
      findOrCreatePhoneUser: jest.fn().mockResolvedValue(user),
      getActiveDocument: jest.fn().mockResolvedValue(user),
      toResponse: jest.fn().mockReturnValue({
        id: USER_ID.toHexString(),
        email: user.email,
        authProvider: user.authProvider,
        status: user.status,
        preferences: user.preferences,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      }),
    } as unknown as UsersService;
    const jwt = {
      signAsync: jest.fn().mockResolvedValue('signed-access-token'),
    } as unknown as JwtService;
    const values: Record<string, string | number> = {
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
      AUTH_DEVELOPMENT_OTP_CODE: '1234',
      AUTH_OTP_DELIVERY_MODE: 'development',
      AUTH_OTP_SECRET:
        'test-otp-secret-that-is-long-enough-for-hmac-use',
      AUTH_REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
    };
    const config = {
      getOrThrow: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return {
      jwt,
      otpModel,
      refreshModel,
      service: new AuthService(
        otpModel,
        refreshModel,
        users,
        jwt,
        config,
      ),
      users,
    };
  }

  it('creates a short-lived OTP challenge without storing the plain code', async () => {
    const { otpModel, service } = setup();

    const result = await service.sendOtp({
      channel: OtpChannel.Email,
      email: ' Parent@Example.com ',
    });

    expect(result.developmentCode).toBe('1234');
    expect(result.expiresInSeconds).toBe(300);
    expect(otpModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'parent@example.com',
        codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(otpModel.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        codeHash: result.developmentCode,
      }),
    );
  });

  it('verifies an OTP and issues hashed refresh-token state', async () => {
    const { jwt, otpModel, refreshModel, service, users } = setup();
    const sent = await service.sendOtp({
      channel: OtpChannel.Email,
      email: 'parent@example.com',
    });

    const result = await service.verifyOtp({
      verificationId: sent.verificationId,
      code: sent.developmentCode!,
    });

    expect(otpModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new Types.ObjectId(sent.verificationId),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          consumedAt: expect.any(Date),
        }),
      }),
      { new: true },
    );
    expect(users.findOrCreateEmailUser).toHaveBeenCalledWith(
      'parent@example.com',
    );
    expect(refreshModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(jwt.signAsync).toHaveBeenCalledWith(
      {
        sub: USER_ID.toHexString(),
        type: 'access',
      },
      { expiresIn: 900 },
    );
    expect(result.tokens.accessToken).toBe('signed-access-token');
    expect(result.tokens.refreshToken).toHaveLength(43);
  });

  it('increments attempts and rejects an incorrect OTP', async () => {
    const { otpModel, service } = setup();
    const sent = await service.sendOtp({
      channel: OtpChannel.Email,
      email: 'parent@example.com',
    });

    await expect(
      service.verifyOtp({
        verificationId: sent.verificationId,
        code: '9999',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(otpModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new Types.ObjectId(sent.verificationId),
      }),
      { $inc: { attempts: 1 } },
    );
  });

  it('rotates a refresh token before issuing a replacement', async () => {
    const { refreshModel, service } = setup();

    const result = await service.refresh({
      refreshToken: 'a'.repeat(43),
    });

    expect(refreshModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        revokedAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          revokeReason: 'rotated',
        }),
      }),
      { new: true },
    );
    expect(refreshModel.create).toHaveBeenCalled();
    expect(result.tokens.refreshToken).not.toBe('a'.repeat(43));
  });
});
