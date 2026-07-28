import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthResponse, OtpSendResponse } from './auth.types';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/send')
  async sendOtp(
    @Body() input: SendOtpDto,
  ): Promise<{ data: OtpSendResponse; success: true }> {
    return {
      success: true,
      data: await this.auth.sendOtp(input),
    };
  }

  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @Body() input: VerifyOtpDto,
  ): Promise<{ data: AuthResponse; success: true }> {
    return {
      success: true,
      data: await this.auth.verifyOtp(input),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() input: RefreshTokenDto,
  ): Promise<{ data: AuthResponse; success: true }> {
    return {
      success: true,
      data: await this.auth.refresh(input),
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() input: RefreshTokenDto,
  ): Promise<{ data: Record<string, never>; success: true }> {
    await this.auth.logout(input);
    return {
      success: true,
      data: {},
    };
  }
}
