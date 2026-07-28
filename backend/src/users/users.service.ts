import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  AuthProvider,
  User,
  UserDocument,
  UserStatus,
} from './schemas/user.schema';
import { UserResponse } from './users.types';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async findOrCreateEmailUser(email: string): Promise<UserDocument> {
    return this.userModel
      .findOneAndUpdate(
        { email },
        {
          $setOnInsert: {
            authProvider: AuthProvider.EmailOtp,
            email,
            status: UserStatus.Active,
          },
        },
        {
          new: true,
          setDefaultsOnInsert: true,
          upsert: true,
        },
      )
      .exec();
  }

  async findOrCreatePhoneUser(
    countryCode: string,
    number: string,
  ): Promise<UserDocument> {
    const now = new Date();
    return this.userModel
      .findOneAndUpdate(
        {
          'phone.countryCode': countryCode,
          'phone.number': number,
        },
        {
          $setOnInsert: {
            authProvider: AuthProvider.PhoneOtp,
            phone: {
              countryCode,
              number,
              verifiedAt: now,
            },
            status: UserStatus.Active,
          },
        },
        {
          new: true,
          setDefaultsOnInsert: true,
          upsert: true,
        },
      )
      .exec();
  }

  async getActiveDocument(userId: string): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({
        _id: this.parseUserId(userId),
        status: UserStatus.Active,
      })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async getById(userId: string): Promise<UserResponse> {
    return this.toResponse(await this.getActiveDocument(userId));
  }

  async update(userId: string, input: UpdateUserDto): Promise<UserResponse> {
    const set: Record<string, unknown> = {};
    if (input.firstName !== undefined) {
      set.firstName = input.firstName.trim();
    }
    if (input.lastName !== undefined) {
      set.lastName = input.lastName.trim();
    }
    if (input.preferences?.language !== undefined) {
      set['preferences.language'] = input.preferences.language;
    }
    if (input.preferences?.timezone !== undefined) {
      set['preferences.timezone'] = input.preferences.timezone;
    }
    for (const [channel, enabled] of Object.entries(
      input.preferences?.notificationChannels ?? {},
    )) {
      set[`preferences.notificationChannels.${channel}`] = enabled;
    }
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    const user = await this.userModel
      .findOneAndUpdate(
        {
          _id: this.parseUserId(userId),
          status: UserStatus.Active,
        },
        { $set: set },
        { new: true, runValidators: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toResponse(user);
  }

  toResponse(user: UserDocument): UserResponse {
    return {
      id: user._id.toHexString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      authProvider: user.authProvider,
      status: user.status,
      preferences: user.preferences,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private parseUserId(userId: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }
    return new Types.ObjectId(userId);
  }
}
