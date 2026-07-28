import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadGatewayException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ObjectMetadata {
  contentLength: number;
  contentType?: string;
}

interface PresignedUpload {
  expiresAt: Date;
  headers: Record<string, string>;
  method: 'PUT';
  url: string;
}

interface PresignedPlayback {
  expiresAt: Date;
  url: string;
}

export interface MultipartPart {
  etag: string;
  partNumber: number;
  sizeBytes: number;
}

export interface PresignedMultipartPart {
  expiresAt: Date;
  method: 'PUT';
  partNumber: number;
  url: string;
}

@Injectable()
export class ObjectStorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly signingClient: S3Client;
  private readonly configureBucketCors: boolean;
  private readonly frontendOrigin: string;
  private readonly readUrlTtlSeconds: number;
  private readonly uploadUrlTtlSeconds: number;
  private bucketPromise?: Promise<void>;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.configureBucketCors = config.getOrThrow<boolean>(
      'S3_CONFIGURE_BUCKET_CORS',
    );
    this.frontendOrigin = config.getOrThrow<string>('FRONTEND_ORIGIN');
    this.readUrlTtlSeconds =
      config.getOrThrow<number>('READ_URL_TTL_SECONDS');
    this.uploadUrlTtlSeconds = config.getOrThrow<number>(
      'UPLOAD_URL_TTL_SECONDS',
    );
    const clientOptions = {
      forcePathStyle: config.getOrThrow<boolean>('S3_FORCE_PATH_STYLE'),
      region: config.getOrThrow<string>('S3_REGION'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    };
    this.client = new S3Client({
      ...clientOptions,
      endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
    });
    this.signingClient = new S3Client({
      ...clientOptions,
      endpoint: config.getOrThrow<string>('S3_PUBLIC_ENDPOINT'),
    });
  }

  async createUploadUrl(
    objectKey: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    await this.ensureBucket();
    const url = await getSignedUrl(
      this.signingClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
      { expiresIn: this.uploadUrlTtlSeconds },
    );

    return {
      method: 'PUT',
      url,
      headers: {
        'content-type': contentType,
      },
      expiresAt: new Date(Date.now() + this.uploadUrlTtlSeconds * 1000),
    };
  }

  async createReadUrl(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
      { expiresIn: this.readUrlTtlSeconds },
    );
  }

  async createMultipartUpload(
    objectKey: string,
    contentType: string,
  ): Promise<string> {
    await this.ensureBucket();
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) {
      throw new BadGatewayException('Object storage did not create an upload');
    }
    return response.UploadId;
  }

  async createMultipartPartUrl(
    objectKey: string,
    uploadId: string,
    partNumber: number,
  ): Promise<PresignedMultipartPart> {
    const url = await getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.uploadUrlTtlSeconds },
    );
    return {
      method: 'PUT',
      partNumber,
      url,
      expiresAt: new Date(Date.now() + this.uploadUrlTtlSeconds * 1000),
    };
  }

  async listMultipartParts(
    objectKey: string,
    uploadId: string,
  ): Promise<MultipartPart[]> {
    const parts: MultipartPart[] = [];
    let partNumberMarker: string | undefined;
    do {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of response.Parts ?? []) {
        if (part.PartNumber && part.ETag) {
          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            sizeBytes: part.Size ?? 0,
          });
        }
      }
      partNumberMarker = response.IsTruncated
        ? response.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker);
    return parts;
  }

  async completeMultipartUpload(
    objectKey: string,
    uploadId: string,
    parts: Array<{ etag: string; partNumber: number }>,
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((left, right) => left.partNumber - right.partNumber)
            .map((part) => ({
              ETag: part.etag,
              PartNumber: part.partNumber,
            })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );
  }

  async createPlaybackUrl(objectKey: string): Promise<PresignedPlayback> {
    const url = await this.createReadUrl(objectKey);
    return {
      url,
      expiresAt: new Date(Date.now() + this.readUrlTtlSeconds * 1000),
    };
  }

  async assertObject(
    objectKey: string,
    expectedSizeBytes: number,
  ): Promise<ObjectMetadata> {
    let response;
    try {
      response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );
    } catch {
      throw new BadGatewayException(
        'Uploaded audio object could not be verified',
      );
    }

    const contentLength = response.ContentLength ?? 0;
    if (contentLength !== expectedSizeBytes) {
      throw new UnprocessableEntityException(
        `Uploaded object size ${contentLength} does not match declared size ${expectedSizeBytes}`,
      );
    }

    return {
      contentLength,
      contentType: response.ContentType,
    };
  }

  private ensureBucket(): Promise<void> {
    this.bucketPromise ??= this.createBucketIfMissing();
    return this.bucketPromise;
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(
          new CreateBucketCommand({
            Bucket: this.bucket,
          }),
        );
      } catch (error) {
        const name =
          error instanceof Error && 'name' in error
            ? error.name
            : 'UnknownError';
        if (
          name !== 'BucketAlreadyExists' &&
          name !== 'BucketAlreadyOwnedByYou'
        ) {
          this.bucketPromise = undefined;
          throw new BadGatewayException('Object storage is unavailable');
        }
      }
    }

    if (this.configureBucketCors) {
      try {
        await this.client.send(
          new PutBucketCorsCommand({
            Bucket: this.bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedHeaders: ['*'],
                  AllowedMethods: ['GET', 'HEAD', 'PUT'],
                  AllowedOrigins: [this.frontendOrigin],
                  ExposeHeaders: ['etag'],
                  MaxAgeSeconds: 3600,
                },
              ],
            },
          }),
        );
      } catch {
        this.bucketPromise = undefined;
        throw new BadGatewayException(
          'Object storage browser upload policy could not be configured',
        );
      }
    }
  }
}
