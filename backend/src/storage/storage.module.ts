import { Module } from '@nestjs/common';
import { ObjectStorageService } from './storage.service';

@Module({
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class StorageModule {}
