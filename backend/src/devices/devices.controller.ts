import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { CompletePairingDto } from './dto/complete-pairing.dto';
import { DiscoverDeviceDto } from './dto/discover-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { VerifyDeviceChallengeDto } from './dto/verify-device-challenge.dto';
import { DevicesService } from './devices.service';

@Controller()
@UseGuards(AccessTokenGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('device-pairing-sessions')
  startPairing(@CurrentUserId() ownerUserId: string) {
    return this.envelope(this.devices.startPairing(ownerUserId));
  }

  @Post('device-pairing-sessions/:sessionId/discover')
  discover(
    @CurrentUserId() ownerUserId: string,
    @Param('sessionId') sessionId: string,
    @Body() input: DiscoverDeviceDto,
  ) {
    return this.envelope(
      this.devices.discover(ownerUserId, sessionId, input),
    );
  }

  @Post('device-pairing-sessions/:sessionId/challenge')
  @HttpCode(200)
  verifyChallenge(
    @CurrentUserId() ownerUserId: string,
    @Param('sessionId') sessionId: string,
    @Body() input: VerifyDeviceChallengeDto,
  ) {
    return this.envelope(
      this.devices.verifyChallenge(ownerUserId, sessionId, input),
    );
  }

  @Post('device-pairing-sessions/:sessionId/complete')
  @HttpCode(200)
  complete(
    @CurrentUserId() ownerUserId: string,
    @Param('sessionId') sessionId: string,
    @Body() input: CompletePairingDto,
  ) {
    return this.envelope(
      this.devices.completePairing(ownerUserId, sessionId, input),
    );
  }

  @Get('devices')
  async list(@CurrentUserId() ownerUserId: string) {
    return {
      success: true as const,
      data: await this.devices.list(ownerUserId),
    };
  }

  @Get('devices/:deviceId')
  get(
    @CurrentUserId() ownerUserId: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.envelope(this.devices.get(ownerUserId, deviceId));
  }

  @Patch('devices/:deviceId')
  update(
    @CurrentUserId() ownerUserId: string,
    @Param('deviceId') deviceId: string,
    @Body() input: UpdateDeviceDto,
  ) {
    return this.envelope(this.devices.update(ownerUserId, deviceId, input));
  }

  @Post('devices/:deviceId/unpair')
  @HttpCode(200)
  unpair(
    @CurrentUserId() ownerUserId: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.envelope(this.devices.unpair(ownerUserId, deviceId));
  }

  @Post('devices/:deviceId/mark-lost')
  @HttpCode(200)
  markLost(
    @CurrentUserId() ownerUserId: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.envelope(this.devices.markLost(ownerUserId, deviceId));
  }

  private async envelope<T>(value: Promise<T>) {
    return {
      success: true as const,
      data: await value,
    };
  }
}

