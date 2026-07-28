import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';
import { UserResponse } from './users.types';

@Controller('users')
@UseGuards(AccessTokenGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async getMe(
    @CurrentUserId() userId: string,
  ): Promise<{ data: UserResponse; success: true }> {
    return {
      success: true,
      data: await this.users.getById(userId),
    };
  }

  @Patch('me')
  async updateMe(
    @CurrentUserId() userId: string,
    @Body() input: UpdateUserDto,
  ): Promise<{ data: UserResponse; success: true }> {
    return {
      success: true,
      data: await this.users.update(userId, input),
    };
  }
}
