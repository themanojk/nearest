import React from 'react';
import { AppState } from 'react-native';
import Renderer, { act } from 'react-test-renderer';
import HomeInsights from './HomeInsights';
import { loadAnalyses } from '../services/insights';
import { authenticatedRequest } from '../services/auth';
jest.mock('../services/auth', () => ({ authenticatedRequest: jest.fn() }));
jest.mock('../services/insights', () => ({ ...jest.requireActual('../services/insights'), loadAnalyses: jest.fn() }));
let tree: Renderer.ReactTestRenderer;
beforeEach(() => { AppState.currentState = 'active'; });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
test('renders real daily and per-recording analysis with honest time labels', async () => {
  (authenticatedRequest as jest.Mock).mockResolvedValue({ data: [{ id: 'child', name: 'Asha' }] });
  (loadAnalyses as jest.Mock).mockResolvedValue([{ analysisId: '1', childId: 'child', fileName: 'actual.wav', createdAt: new Date().toISOString(), status: 'COMPLETED', progress: 100, riskStage: { status: 'COMPLETED' }, riskSummary: { incidentCount: 1, highSeverityCount: 1 } }]);
  await act(async () => { tree = Renderer.create(<HomeInsights refreshKey={1} paused={false} />); });
  expect(tree.root.findAll(node => node.props.children === 'actual.wav').length).toBeGreaterThan(0);
  expect(tree.root.findAll(node => node.props.label === 'Alert').length).toBeGreaterThan(0);
  expect(tree.root.findAll(node => typeof node.props.children === 'string' && node.props.children.includes('Recording dates are not available')).length).toBeGreaterThan(0);
});
test('failed requests show an error instead of sample insights', async () => {
  (loadAnalyses as jest.Mock).mockRejectedValue(new Error('Offline'));
  await act(async () => { tree = Renderer.create(<HomeInsights refreshKey={1} paused={false} />); });
  expect(tree.root.findAll(node => Array.isArray(node.props.children) && node.props.children.includes('Offline')).length).toBeGreaterThan(0);
  expect(tree.root.findAll(node => node.props.label === 'Normal')).toHaveLength(0);
});

test('opens an explained risk card with timestamped playback and real summary metrics', async () => {
  const fixture = { analysisId: 'risk', childId: 'child', fileName: 'voice.mp3', createdAt: new Date().toISOString(), status: 'COMPLETED', progress: 100, riskStage: { status: 'COMPLETED' }, riskSummary: { incidentCount: 1, highSeverityCount: 1 }, mediaMetadata: { durationMs: 60000 }, scanSummary: { speechDurationMs: 30000, decodedDurationMs: 60000 }, conversationSummary: { sessionCount: 2, utteranceCount: 10 } };
  (loadAnalyses as jest.Mock).mockResolvedValue([fixture]);
  (authenticatedRequest as jest.Mock).mockImplementation(async (path: string) => path === '/children' ? { data: [] } : { total: 1, items: [{ incidentId: 'i', incidentType: 'verbal_aggression', severity: 'HIGH', rationale: 'Raised voices with threatening language.', confidence: 0.8, startMs: 12000, endMs: 18000 }] });
  await act(async () => { tree = Renderer.create(<HomeInsights refreshKey={2} paused={false} />); });
  const button = tree.root.findAll(n => typeof n.props?.onPress === 'function' && n.findAll(c => typeof c.props.children === 'string' && c.props.children.startsWith('Review flagged moments')).length > 0)[0];
  await act(async () => { button.props.onPress(); });
  expect(tree.root.findAll(n => n.props.children === 'Aggressive language').length).toBeGreaterThan(0);
  expect(tree.root.findAll(n => n.props.children === 'Raised voices with threatening language.').length).toBeGreaterThan(0);
  const clips = tree.root.findAll(n => n.props.clip?.startMs === 12000);
  expect(clips.length).toBeGreaterThan(0);
  expect(clips[0].props.clip.endMs).toBe(18000);
});

test('history includes older uploads and can regenerate their insights', async () => {
  const older = { analysisId: 'old', childId: 'child', fileName: 'yesterday.mp3', createdAt: '2026-01-01T12:00:00Z', status: 'COMPLETED', progress: 100, conversationStage: { status: 'COMPLETED' }, riskStage: { status: 'COMPLETED' }, riskSummary: { incidentCount: 1, highSeverityCount: 0 } };
  const newer = { ...older, analysisId: 'new', fileName: 'today.mp3', createdAt: '2026-01-02T12:00:00Z' };
  (loadAnalyses as jest.Mock).mockResolvedValue([older, newer]);
  (authenticatedRequest as jest.Mock).mockImplementation(async (path: string) => path === '/children' ? { data: [] } : { ...older, status: 'PROCESSING', contextStage: { status: 'QUEUED' }, riskStage: { status: 'PENDING' }, riskSummary: undefined });
  await act(async () => { tree = Renderer.create(<HomeInsights refreshKey={1} paused={false} history />); });
  expect(tree.root.findAll(n => n.props.children === 'yesterday.mp3').length).toBeGreaterThan(0);
  expect(tree.root.findAll(n => n.props.children === 'today.mp3').length).toBeGreaterThan(0);
  const button = tree.root.findAll(n => n.props.accessibilityLabel === 'Regenerate insights for yesterday.mp3' && typeof n.props.onPress === 'function')[0];
  await act(async () => { button.props.onPress(); });
  expect(authenticatedRequest).toHaveBeenCalledWith('/audio-analysis/old/classify-context', expect.objectContaining({ method: 'POST', body: JSON.stringify({ force: true }) }));
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Regenerate insights for yesterday.mp3' && typeof n.props.onPress === 'function')[0].props.disabled).toBe(true);
});
