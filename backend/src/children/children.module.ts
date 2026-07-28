import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { ChildrenController } from './children.controller';
import { ChildrenService } from './children.service';
import {
  ChildProfile,
  ChildProfileSchema,
} from './schemas/child-profile.schema';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      {
        name: ChildProfile.name,
        schema: ChildProfileSchema,
      },
    ]),
  ],
  controllers: [ChildrenController],
  providers: [ChildrenService],
  exports: [ChildrenService],
})
export class ChildrenModule {}
