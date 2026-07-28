import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import {
  AUDIO_INGEST_QUEUE,
  AUDIO_SCAN_QUEUE,
  CONTEXT_CLASSIFICATION_QUEUE,
  SPEECH_DIARIZATION_QUEUE,
  SPEECH_ASR_QUEUE,
  ACOUSTIC_EVENT_QUEUE,
  RISK_AGGREGATION_QUEUE,
} from './analysis.constants';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AudioIngestProcessor } from './audio-ingest.processor';
import { AudioScanProcessor } from './audio-scan.processor';
import { MediaProbeService } from './media-probe.service';
import {
  AnalysisJob,
  AnalysisJobSchema,
} from './schemas/analysis-job.schema';
import {
  ScanSegment,
  ScanSegmentSchema,
} from './schemas/scan-segment.schema';
import { WorkerClientService } from './worker-client.service';
import { SpeechAsrProcessor } from './speech-asr.processor';
import {
  TranscriptionChunk,
  TranscriptionChunkSchema,
} from './schemas/transcription-chunk.schema';
import { SpeechDiarizationProcessor } from './speech-diarization.processor';
import {
  SpeakerTurn,
  SpeakerTurnSchema,
} from './schemas/speaker-turn.schema';
import {
  ConversationSession,
  ConversationSessionSchema,
} from './schemas/conversation-session.schema';
import {
  TimelineEvent,
  TimelineEventSchema,
} from './schemas/timeline-event.schema';
import { ContextClassificationProcessor } from './context-classification.processor';
import {
  AcousticEvent,
  AcousticEventSchema,
} from './schemas/acoustic-event.schema';
import { AcousticEventProcessor } from './acoustic-event.processor';
import {
  RiskIncident,
  RiskIncidentSchema,
} from './schemas/risk-incident.schema';
import { RiskAggregationProcessor } from './risk-aggregation.processor';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      {
        name: AnalysisJob.name,
        schema: AnalysisJobSchema,
      },
      {
        name: ScanSegment.name,
        schema: ScanSegmentSchema,
      },
      {
        name: TranscriptionChunk.name,
        schema: TranscriptionChunkSchema,
      },
      {
        name: SpeakerTurn.name,
        schema: SpeakerTurnSchema,
      },
      {
        name: ConversationSession.name,
        schema: ConversationSessionSchema,
      },
      {
        name: TimelineEvent.name,
        schema: TimelineEventSchema,
      },
      {
        name: AcousticEvent.name,
        schema: AcousticEventSchema,
      },
      {
        name: RiskIncident.name,
        schema: RiskIncidentSchema,
      },
    ]),
    BullModule.registerQueue({
      name: AUDIO_INGEST_QUEUE,
    }),
    BullModule.registerQueue({
      name: AUDIO_SCAN_QUEUE,
    }),
    BullModule.registerQueue({
      name: SPEECH_ASR_QUEUE,
    }),
    BullModule.registerQueue({
      name: SPEECH_DIARIZATION_QUEUE,
    }),
    BullModule.registerQueue({
      name: CONTEXT_CLASSIFICATION_QUEUE,
    }),
    BullModule.registerQueue({
      name: ACOUSTIC_EVENT_QUEUE,
    }),
    BullModule.registerQueue({
      name: RISK_AGGREGATION_QUEUE,
    }),
    StorageModule,
  ],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    AudioIngestProcessor,
    AudioScanProcessor,
    MediaProbeService,
    SpeechAsrProcessor,
    SpeechDiarizationProcessor,
    ContextClassificationProcessor,
    AcousticEventProcessor,
    RiskAggregationProcessor,
    WorkerClientService,
  ],
})
export class AnalysisModule {}
