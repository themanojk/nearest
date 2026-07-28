import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { AnalysisService } from './analysis.service';
import {
  AnalysisResponse,
  AnalysisPageResponse,
  AudioPlaybackResponse,
  ConversationPageResponse,
  TimelineEventPageResponse,
  AcousticEventPageResponse,
  RiskIncidentPageResponse,
  CreateAnalysisResponse,
  MultipartPartsResponse,
  MultipartUploadStatusResponse,
  SegmentPageResponse,
  TranscriptionPageResponse,
} from './analysis.types';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { CreateMultipartPartsDto } from './dto/create-multipart-parts.dto';
import { ListAnalysesDto } from './dto/list-analyses.dto';
import { ListSegmentsDto } from './dto/list-segments.dto';
import { ListTranscriptionsDto } from './dto/list-transcriptions.dto';
import { StartDiarizationDto } from './dto/start-diarization.dto';
import { StartContextClassificationDto } from './dto/start-context-classification.dto';
import { StartAcousticDetectionDto } from './dto/start-acoustic-detection.dto';
import { StartRiskAggregationDto } from './dto/start-risk-aggregation.dto';

@Controller('audio-analysis')
@UseGuards(AccessTokenGuard)
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post()
  create(
    @CurrentUserId() tenantId: string,
    @Body() input: CreateAnalysisDto,
  ): Promise<CreateAnalysisResponse> {
    return this.analysis.create(tenantId, input);
  }

  @Get()
  list(
    @CurrentUserId() tenantId: string,
    @Query() query: ListAnalysesDto,
  ): Promise<AnalysisPageResponse> {
    return this.analysis.list(tenantId, query);
  }

  @Post(':analysisId/complete-upload')
  @HttpCode(200)
  completeUpload(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.completeUpload(tenantId, analysisId);
  }

  @Post(':analysisId/multipart/parts')
  createMultipartPartUrls(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: CreateMultipartPartsDto,
  ): Promise<MultipartPartsResponse> {
    return this.analysis.createMultipartPartUrls(
      tenantId,
      analysisId,
      input,
    );
  }

  @Get(':analysisId/multipart')
  getMultipartStatus(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<MultipartUploadStatusResponse> {
    return this.analysis.getMultipartStatus(tenantId, analysisId);
  }

  @Post(':analysisId/multipart/complete')
  @HttpCode(200)
  completeMultipartUpload(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.completeMultipartUpload(tenantId, analysisId);
  }

  @Delete(':analysisId/multipart')
  abortMultipartUpload(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.abortMultipartUpload(tenantId, analysisId);
  }

  @Get(':analysisId')
  getById(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.getById(tenantId, analysisId);
  }

  @Get(':analysisId/playback')
  getPlayback(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AudioPlaybackResponse> {
    return this.analysis.getPlayback(tenantId, analysisId);
  }

  @Get(':analysisId/segments')
  listSegments(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListSegmentsDto,
  ): Promise<SegmentPageResponse> {
    return this.analysis.listSegments(tenantId, analysisId, query);
  }

  @Get(':analysisId/transcripts')
  listTranscriptions(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<TranscriptionPageResponse> {
    return this.analysis.listTranscriptions(tenantId, analysisId, query);
  }

  @Post(':analysisId/diarize')
  @HttpCode(202)
  startDiarization(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartDiarizationDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startDiarization(tenantId, analysisId, input);
  }

  @Get(':analysisId/conversations')
  listConversations(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<ConversationPageResponse> {
    return this.analysis.listConversations(tenantId, analysisId, query);
  }

  @Post(':analysisId/classify-context')
  @HttpCode(202)
  startContextClassification(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartContextClassificationDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startContextClassification(
      tenantId,
      analysisId,
      input,
    );
  }

  @Get(':analysisId/timeline')
  listTimelineEvents(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<TimelineEventPageResponse> {
    return this.analysis.listTimelineEvents(tenantId, analysisId, query);
  }

  @Post(':analysisId/detect-acoustic-events')
  @HttpCode(202)
  startAcousticDetection(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartAcousticDetectionDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startAcousticDetection(
      tenantId,
      analysisId,
      input,
    );
  }

  @Get(':analysisId/acoustic-events')
  listAcousticEvents(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<AcousticEventPageResponse> {
    return this.analysis.listAcousticEvents(tenantId, analysisId, query);
  }

  @Post(':analysisId/aggregate-risk')
  @HttpCode(202)
  startRiskAggregation(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartRiskAggregationDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startRiskAggregation(tenantId, analysisId, input);
  }

  @Get(':analysisId/risk-incidents')
  listRiskIncidents(
    @CurrentUserId() tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<RiskIncidentPageResponse> {
    return this.analysis.listRiskIncidents(tenantId, analysisId, query);
  }
}
