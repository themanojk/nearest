import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ChildrenModule } from '../children/children.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import {
  DevicePairingSession,
  DevicePairingSessionSchema,
} from './schemas/device-pairing-session.schema';
import { Device, DeviceSchema } from './schemas/device.schema';

@Module({
  imports: [
    AuthModule,
    ChildrenModule,
    MongooseModule.forFeature([
      { name: Device.name, schema: DeviceSchema },
      {
        name: DevicePairingSession.name,
        schema: DevicePairingSessionSchema,
      },
    ]),
  ],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}

