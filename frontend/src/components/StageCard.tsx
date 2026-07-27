import type { StageStatus } from '../types';

interface StageCardProps {
  detail: string;
  index: string;
  label: string;
  progress: number;
  status: StageStatus | 'UPLOADING';
}

const statusLabels: Record<StageCardProps['status'], string> = {
  PENDING: 'Waiting',
  QUEUEING: 'Queueing',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Complete',
  FAILED: 'Failed',
  UPLOADING: 'Uploading',
};

export function StageCard({
  detail,
  index,
  label,
  progress,
  status,
}: StageCardProps) {
  const normalizedProgress =
    status === 'COMPLETED' ? 100 : Math.max(0, Math.min(progress, 100));

  return (
    <article className={`stage-card stage-${status.toLowerCase()}`}>
      <div className="stage-card-topline">
        <span className="stage-index">{index}</span>
        <span className="status-pill">{statusLabels[status]}</span>
      </div>
      <h3>{label}</h3>
      <p>{detail}</p>
      <div
        className="stage-progress"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={normalizedProgress}
      >
        <span style={{ width: `${normalizedProgress}%` }} />
      </div>
    </article>
  );
}
