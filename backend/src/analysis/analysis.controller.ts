import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
  SegmentPageResponse,
  TranscriptionPageResponse,
} from './analysis.types';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { ListAnalysesDto } from './dto/list-analyses.dto';
import { ListSegmentsDto } from './dto/list-segments.dto';
import { ListTranscriptionsDto } from './dto/list-transcriptions.dto';
import { StartDiarizationDto } from './dto/start-diarization.dto';
import { StartContextClassificationDto } from './dto/start-context-classification.dto';
import { StartAcousticDetectionDto } from './dto/start-acoustic-detection.dto';
import { StartRiskAggregationDto } from './dto/start-risk-aggregation.dto';

@Controller('audio-analysis')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post()
  create(
    @Headers('x-tenant-id') tenantId: string,
    @Body() input: CreateAnalysisDto,
  ): Promise<CreateAnalysisResponse> {
    return this.analysis.create(tenantId, input);
  }

  @Get()
  list(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ListAnalysesDto,
  ): Promise<AnalysisPageResponse> {
    return this.analysis.list(tenantId, query);
  }

  @Post(':analysisId/complete-upload')
  @HttpCode(200)
  completeUpload(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.completeUpload(tenantId, analysisId);
  }

  @Get(':analysisId')
  getById(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AnalysisResponse> {
    return this.analysis.getById(tenantId, analysisId);
  }

  @Get(':analysisId/playback')
  getPlayback(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
  ): Promise<AudioPlaybackResponse> {
    return this.analysis.getPlayback(tenantId, analysisId);
  }

  @Get(':analysisId/segments')
  listSegments(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListSegmentsDto,
  ): Promise<SegmentPageResponse> {
    return this.analysis.listSegments(tenantId, analysisId, query);
  }

  @Get(':analysisId/transcripts')
  listTranscriptions(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<TranscriptionPageResponse> {
    return this.analysis.listTranscriptions(tenantId, analysisId, query);
  }

  @Post(':analysisId/diarize')
  @HttpCode(202)
  startDiarization(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartDiarizationDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startDiarization(tenantId, analysisId, input);
  }

  @Get(':analysisId/conversations')
  listConversations(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<ConversationPageResponse> {
    return this.analysis.listConversations(tenantId, analysisId, query);
  }

  @Post(':analysisId/classify-context')
  @HttpCode(202)
  startContextClassification(
    @Headers('x-tenant-id') tenantId: string,
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
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<TimelineEventPageResponse> {
    return this.analysis.listTimelineEvents(tenantId, analysisId, query);
  }

  @Post(':analysisId/detect-acoustic-events')
  @HttpCode(202)
  startAcousticDetection(
    @Headers('x-tenant-id') tenantId: string,
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
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<AcousticEventPageResponse> {
    return this.analysis.listAcousticEvents(tenantId, analysisId, query);
  }

  @Post(':analysisId/aggregate-risk')
  @HttpCode(202)
  startRiskAggregation(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Body() input: StartRiskAggregationDto,
  ): Promise<AnalysisResponse> {
    return this.analysis.startRiskAggregation(tenantId, analysisId, input);
  }

  @Get(':analysisId/risk-incidents')
  listRiskIncidents(
    @Headers('x-tenant-id') tenantId: string,
    @Param('analysisId') analysisId: string,
    @Query() query: ListTranscriptionsDto,
  ): Promise<RiskIncidentPageResponse> {
    return this.analysis.listRiskIncidents(tenantId, analysisId, query);
  }
}
