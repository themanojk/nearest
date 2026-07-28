import {
  Injectable,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Model, Types } from 'mongoose';
import { UsersService } from '../users/users.service';
import { UserStatus } from '../users/schemas/user.schema';
import { AuthResponse, AuthTokens, OtpSendResponse } from './auth.types';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import {
  OtpChallenge,
  OtpChannel,
} from './schemas/otp-challenge.schema';
import { RefreshSession } from './schemas/refresh-session.schema';

const OTP_TTL_SECONDS = 5 * 60;
const OTP_SEND_WINDOW_MS = 10 * 60 * 1000;
const OTP_SEND_LIMIT = 5;

@Injectable()
export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly developmentOtpCode: string;
  private readonly deliveryMode: string;
  private readonly otpSecret: string;
  private readonly refreshTokenTtlSeconds: number;

  constructor(
    @InjectModel(OtpChallenge.name)
    private readonly otpModel: Model<OtpChallenge>,
    @InjectModel(RefreshSession.name)
    private readonly refreshModel: Model<RefreshSession>,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessTokenTtlSeconds = config.getOrThrow<number>(
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
    );
    this.developmentOtpCode = config.getOrThrow<string>(
      'AUTH_DEVELOPMENT_OTP_CODE',
    );
    this.refreshTokenTtlSeconds = config.getOrThrow<number>(
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
    );
    this.deliveryMode = config.getOrThrow<string>(
      'AUTH_OTP_DELIVERY_MODE',
    );
    this.otpSecret = config.getOrThrow<string>('AUTH_OTP_SECRET');
  }

  async sendOtp(input: SendOtpDto): Promise<OtpSendResponse> {
    if (this.deliveryMode !== 'development') {
      throw new ServiceUnavailableException(
        'OTP delivery provider is not configured',
      );
    }

    const target = this.normaliseTarget(input);
    const recentCount = await this.otpModel
      .countDocuments({
        target,
        createdAt: {
          $gte: new Date(Date.now() - OTP_SEND_WINDOW_MS),
        },
      })
      .exec();
    if (recentCount >= OTP_SEND_LIMIT) {
      throw new HttpException(
        'Too many verification requests. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const challengeId = new Types.ObjectId();
    const code = this.developmentOtpCode;
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
    await this.otpModel.create({
      _id: challengeId,
      attempts: 0,
      channel: input.channel,
      codeHash: this.hashOtp(challengeId.toHexString(), code),
      expiresAt,
      maxAttempts: 5,
      target,
    });

    return {
      verificationId: challengeId.toHexString(),
      expiresInSeconds: OTP_TTL_SECONDS,
      developmentCode: code,
    };
  }

  async verifyOtp(input: VerifyOtpDto): Promise<AuthResponse> {
    const challengeId = new Types.ObjectId(input.verificationId);
    const challenge = await this.otpModel
      .findOne({
        _id: challengeId,
        consumedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
        $expr: { $lt: ['$attempts', '$maxAttempts'] },
      })
      .exec();
    if (!challenge) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const expected = Buffer.from(challenge.codeHash, 'hex');
    const actual = Buffer.from(
      this.hashOtp(input.verificationId, input.code),
      'hex',
    );
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      await this.otpModel
        .updateOne(
          { _id: challengeId, consumedAt: { $exists: false } },
          { $inc: { attempts: 1 } },
        )
        .exec();
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const consumed = await this.otpModel
      .findOneAndUpdate(
        {
          _id: challengeId,
          consumedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
          $expr: { $lt: ['$attempts', '$maxAttempts'] },
        },
        { $set: { consumedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!consumed) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const user =
      challenge.channel === OtpChannel.Email
        ? await this.users.findOrCreateEmailUser(challenge.target)
        : await this.users.findOrCreatePhoneUser(
            ...this.splitPhoneTarget(challenge.target),
          );
    if (user.status !== UserStatus.Active) {
      throw new UnauthorizedException('User account is not active');
    }
    return {
      user: this.users.toResponse(user),
      tokens: await this.issueTokens(user._id),
    };
  }

  async refresh(input: RefreshTokenDto): Promise<AuthResponse> {
    const now = new Date();
    const session = await this.refreshModel
      .findOneAndUpdate(
        {
          tokenHash: this.hashRefreshToken(input.refreshToken),
          revokedAt: { $exists: false },
          expiresAt: { $gt: now },
        },
        {
          $set: {
            revokedAt: now,
            revokeReason: 'rotated',
          },
        },
        { new: true },
      )
      .exec();
    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.users.getActiveDocument(
      session.userId.toHexString(),
    );
    return {
      user: this.users.toResponse(user),
      tokens: await this.issueTokens(user._id),
    };
  }

  async logout(input: RefreshTokenDto): Promise<void> {
    await this.refreshModel
      .updateOne(
        {
          tokenHash: this.hashRefreshToken(input.refreshToken),
          revokedAt: { $exists: false },
        },
        {
          $set: {
            revokedAt: new Date(),
            revokeReason: 'logout',
          },
        },
      )
      .exec();
  }

  private async issueTokens(userId: Types.ObjectId): Promise<AuthTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.refreshModel.create({
      userId,
      tokenHash: this.hashRefreshToken(refreshToken),
      expiresAt: new Date(
        Date.now() + this.refreshTokenTtlSeconds * 1000,
      ),
    });
    const accessToken = await this.jwt.signAsync(
      {
        sub: userId.toHexString(),
        type: 'access',
      },
      {
        expiresIn: this.accessTokenTtlSeconds,
      },
    );
    return {
      accessToken,
      accessTokenExpiresInSeconds: this.accessTokenTtlSeconds,
      refreshToken,
      refreshTokenExpiresInSeconds: this.refreshTokenTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  private normaliseTarget(input: SendOtpDto): string {
    if (input.channel === OtpChannel.Email && input.email) {
      return input.email.trim().toLowerCase();
    }
    if (input.channel === OtpChannel.Phone && input.phone) {
      return `${input.phone.countryCode}:${input.phone.number}`;
    }
    throw new UnauthorizedException('Invalid verification target');
  }

  private splitPhoneTarget(target: string): [string, string] {
    const match = target.match(/^(\+\d{1,3}):(\d{6,15})$/);
    if (!match) {
      throw new UnauthorizedException('Invalid verification target');
    }
    return [match[1], match[2]];
  }

  private hashOtp(verificationId: string, code: string): string {
    return createHmac('sha256', this.otpSecret)
      .update(`${verificationId}:${code}`)
      .digest('hex');
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
