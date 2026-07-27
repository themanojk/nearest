import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  RISK_AGGREGATION_JOB,
  RISK_AGGREGATION_QUEUE,
} from './analysis.constants';
import { AggregateRiskJob, RiskSummary } from './analysis.types';
import {
  aggregateRiskCandidates,
  RISK_MODEL,
} from './risk-aggregator';
import { AcousticEvent } from './schemas/acoustic-event.schema';
import {
  AnalysisJob,
  AnalysisStatus,
  PipelineStageStatus,
} from './schemas/analysis-job.schema';
import { RiskIncident } from './schemas/risk-incident.schema';
import { TimelineEvent } from './schemas/timeline-event.schema';

@Processor(RISK_AGGREGATION_QUEUE, { concurrency: 2 })
export class RiskAggregationProcessor extends WorkerHost {
  private readonly logger = new Logger(RiskAggregationProcessor.name);

  constructor(
    @InjectModel(AnalysisJob.name)
    private readonly analysisModel: Model<AnalysisJob>,
    @InjectModel(TimelineEvent.name)
    private readonly timelineEventModel: Model<TimelineEvent>,
    @InjectModel(AcousticEvent.name)
    private readonly acousticEventModel: Model<AcousticEvent>,
    @InjectModel(RiskIncident.name)
    private readonly incidentModel: Model<RiskIncident>,
  ) {
    super();
  }

  async process(job: Job<AggregateRiskJob>): Promise<RiskSummary> {
    if (job.name !== RISK_AGGREGATION_JOB) {
      throw new Error(`Unsupported risk aggregation job: ${job.name}`);
    }
    const startedAt = performance.now();
    const analysisJobId = new Types.ObjectId(job.data.analysisId);
    const claimed = await this.analysisModel
      .findOneAndUpdate(
        {
          _id: analysisJobId,
          tenantId: job.data.tenantId,
          'riskStage.status': {
            $in: [
              PipelineStageStatus.Pending,
              PipelineStageStatus.Queueing,
              PipelineStageStatus.Queued,
            ],
          },
        },
        {
          $set: {
            status: AnalysisStatus.Processing,
            progress: 98,
            'riskStage.status': PipelineStageStatus.Running,
            'riskStage.progress': 10,
            'riskStage.updatedAt': new Date(),
            failureReason: null,
          },
          $inc: { 'riskStage.attempts': 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      const existing = await this.analysisModel.findById(analysisJobId).exec();
      if (
        existing?.riskStage?.status === PipelineStageStatus.Completed &&
        existing.riskSummary
      ) {
        return existing.riskSummary;
      }
      throw new Error('Analysis is not available for risk aggregation');
    }

    this.logger.log(`risk.started analysisId=${job.data.analysisId}`);
    try {
      const [transcriptEvents, acousticEvents] = await Promise.all([
        this.timelineEventModel
          .find({ analysisJobId, tenantId: job.data.tenantId })
          .lean()
          .exec(),
        this.acousticEventModel
          .find({ analysisJobId, tenantId: job.data.tenantId })
          .lean()
          .exec(),
      ]);
      const candidates = [
        ...transcriptEvents.map((event) => ({
          startMs: event.startMs,
          endMs: event.endMs,
          source: 'transcript' as const,
          label: event.eventType,
          severity: event.severity,
          confidence: event.confidence,
          evidenceText: event.evidence,
        })),
        ...acousticEvents.map((event) => ({
          startMs: event.startMs,
          endMs: event.endMs,
          source: 'acoustic' as const,
          label: event.label,
          category: event.category,
          severity: event.severity,
          confidence: event.confidence,
        })),
      ];
      const incidents = aggregateRiskCandidates(candidates);

      await this.incidentModel
        .deleteMany({ analysisJobId, tenantId: job.data.tenantId })
        .exec();
      if (incidents.length > 0) {
        await this.incidentModel.insertMany(
          incidents.map((incident) => ({
            ...incident,
            analysisJobId,
            tenantId: job.data.tenantId,
            childInvolvement: 'unknown',
            reviewStatus: 'unreviewed',
            modelName: RISK_MODEL,
          })),
          { ordered: true },
        );
      }

      const summary: RiskSummary = {
        model: RISK_MODEL,
        processingSeconds:
          Math.round((performance.now() - startedAt) * 1000) / 1_000_000,
        incidentCount: incidents.length,
        highSeverityCount: incidents.filter(
          (incident) => incident.severity === 'high',
        ).length,
        multimodalIncidentCount: incidents.filter(
          (incident) => incident.modalities.length > 1,
        ).length,
        evidenceCount: candidates.length,
      };
      await this.analysisModel
        .updateOne(
          { _id: analysisJobId, tenantId: job.data.tenantId },
          {
            $set: {
              status: AnalysisStatus.Completed,
              progress: 100,
              completedAt: new Date(),
              riskSummary: summary,
              'riskStage.status': PipelineStageStatus.Completed,
              'riskStage.progress': 100,
              'riskStage.updatedAt': new Date(),
            },
          },
        )
        .exec();
      this.logger.log(
        `risk.completed analysisId=${job.data.analysisId} evidence=${candidates.length} incidents=${incidents.length}`,
      );
      return summary;
    } catch (error) {
      const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const reason =
        error instanceof Error ? error.message : 'Unknown risk error';
      await this.analysisModel
        .updateOne(
          { _id: analysisJobId, tenantId: job.data.tenantId },
          {
            $set: {
              status: terminal
                ? AnalysisStatus.Failed
                : AnalysisStatus.Processing,
              failureReason: reason,
              'riskStage.status': terminal
                ? PipelineStageStatus.Failed
                : PipelineStageStatus.Queued,
              'riskStage.updatedAt': new Date(),
            },
          },
        )
        .exec();
      throw error;
    }
  }
}
