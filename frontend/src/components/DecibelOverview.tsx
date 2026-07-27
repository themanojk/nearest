import { useMemo, useState } from 'react';
import type { Segment } from '../types';

interface DecibelOverviewProps {
  durationMs: number;
  windows: Segment[];
}

interface ChartPoint {
  endMs: number;
  peakDbfs: number;
  rmsDbfs: number;
  startMs: number;
}

const WIDTH = 1_000;
const HEIGHT = 270;
const PLOT = { left: 58, right: 18, top: 18, bottom: 38 };
const MIN_DB = -80;
const MAX_DB = 0;
const GRID_LEVELS = [0, -20, -40, -60, -80];
const MAX_POINTS = 480;

function formatTimelineTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clampDb(value: number | undefined) {
  return Math.max(MIN_DB, Math.min(MAX_DB, value ?? MIN_DB));
}

function downsample(windows: Segment[]): ChartPoint[] {
  if (windows.length <= MAX_POINTS) {
    return windows.map((window) => ({
      startMs: window.startMs,
      endMs: window.endMs,
      rmsDbfs: clampDb(window.rmsDbfs),
      peakDbfs: clampDb(window.peakDbfs),
    }));
  }

  const bucketSize = Math.ceil(windows.length / MAX_POINTS);
  const points: ChartPoint[] = [];
  for (let index = 0; index < windows.length; index += bucketSize) {
    const bucket = windows.slice(index, index + bucketSize);
    points.push({
      startMs: bucket[0].startMs,
      endMs: bucket.at(-1)?.endMs ?? bucket[0].endMs,
      rmsDbfs:
        bucket.reduce((sum, window) => sum + clampDb(window.rmsDbfs), 0) /
        bucket.length,
      peakDbfs: Math.max(...bucket.map((window) => clampDb(window.peakDbfs))),
    });
  }
  return points;
}

export function DecibelOverview({
  durationMs,
  windows,
}: DecibelOverviewProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number>();
  const points = useMemo(() => downsample(windows), [windows]);
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const barWidth = points.length > 0 ? plotWidth / points.length : plotWidth;
  const hovered =
    hoveredIndex === undefined ? undefined : points[hoveredIndex];

  function yForDb(db: number) {
    return PLOT.top + ((MAX_DB - clampDb(db)) / (MAX_DB - MIN_DB)) * plotHeight;
  }

  function handlePointer(clientX: number, left: number, renderedWidth: number) {
    if (points.length === 0) return;
    const svgX = ((clientX - left) / renderedWidth) * WIDTH;
    const ratio = (svgX - PLOT.left) / plotWidth;
    setHoveredIndex(
      Math.max(0, Math.min(points.length - 1, Math.floor(ratio * points.length))),
    );
  }

  if (points.length === 0) {
    return (
      <div className="decibel-empty">
        Decibel data will appear after the Tier-1 scan completes.
      </div>
    );
  }

  const peakPath = points
    .map((point, index) => {
      const x = PLOT.left + (index + 0.5) * barWidth;
      return `${index === 0 ? 'M' : 'L'} ${x} ${yForDb(point.peakDbfs)}`;
    })
    .join(' ');

  return (
    <div className="decibel-chart">
      <div className="decibel-chart-legend">
        <span className="legend-rms">RMS loudness</span>
        <span className="legend-peak">Peak level</span>
        <small>dBFS: closer to 0 is louder</small>
      </div>
      <div className="decibel-chart-frame">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="Audio loudness in decibels across the full recording"
          onMouseLeave={() => setHoveredIndex(undefined)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            handlePointer(event.clientX, bounds.left, bounds.width);
          }}
          onTouchMove={(event) => {
            const touch = event.touches[0];
            if (!touch) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            handlePointer(touch.clientX, bounds.left, bounds.width);
          }}
        >
          {GRID_LEVELS.map((level) => {
            const y = yForDb(level);
            return (
              <g key={level}>
                <line
                  className="decibel-grid-line"
                  x1={PLOT.left}
                  x2={WIDTH - PLOT.right}
                  y1={y}
                  y2={y}
                />
                <text className="decibel-axis-label" x={PLOT.left - 10} y={y + 4}>
                  {level}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => {
            const x = PLOT.left + index * barWidth;
            const y = yForDb(point.rmsDbfs);
            return (
              <rect
                className="decibel-rms-bar"
                key={`${point.startMs}-${point.endMs}`}
                x={x}
                y={y}
                width={Math.max(1, barWidth - 0.7)}
                height={PLOT.top + plotHeight - y}
              />
            );
          })}

          <path className="decibel-peak-line" d={peakPath} />

          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const x = PLOT.left + ratio * plotWidth;
            return (
              <text
                className="decibel-time-label"
                key={ratio}
                x={x}
                y={HEIGHT - 10}
                textAnchor={
                  ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'
                }
              >
                {formatTimelineTime(durationMs * ratio)}
              </text>
            );
          })}

          {hovered && hoveredIndex !== undefined && (
            <line
              className="decibel-cursor"
              x1={PLOT.left + (hoveredIndex + 0.5) * barWidth}
              x2={PLOT.left + (hoveredIndex + 0.5) * barWidth}
              y1={PLOT.top}
              y2={PLOT.top + plotHeight}
            />
          )}
        </svg>

        {hovered && (
          <div
            className="decibel-tooltip"
            style={{
              left: `${Math.min(
                88,
                Math.max(
                  12,
                  ((hovered.startMs + hovered.endMs) / 2 / durationMs) * 100,
                ),
              )}%`,
            }}
          >
            <strong>
              {formatTimelineTime(hovered.startMs)}–
              {formatTimelineTime(hovered.endMs)}
            </strong>
            <span>RMS {hovered.rmsDbfs.toFixed(1)} dBFS</span>
            <span>Peak {hovered.peakDbfs.toFixed(1)} dBFS</span>
          </div>
        )}
      </div>
    </div>
  );
}
