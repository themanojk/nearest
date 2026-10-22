import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Renderer, { act } from 'react-test-renderer';
import TodayScreen from './TodayScreen';
import { transport } from '../../services/transport';

const mockPatch = jest.fn();
const mockState = { syncStage: null as string | null };
jest.mock('../../state/store', () => ({
  useStore: () => ({ state: mockState, patch: mockPatch }),
  useAllowance: () => ({ used: 0, total: 5, remaining: 5, resets: '' }),
}));
jest.mock('../../services/transport', () => ({ transport: { getDeviceTelemetry: jest.fn() } }));
jest.mock('../../components/HomeInsights', () => () => null);
jest.mock('../../components/Glass', () => () => null);
jest.mock('../../components/ProgressBar', () => () => null);
let tree: Renderer.ReactTestRenderer;
let change: (state: AppStateStatus) => void;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  AppState.currentState = 'active';
  mockState.syncStage = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    change = listener;
    return { remove: jest.fn() };
  });
  (transport.getDeviceTelemetry as jest.Mock).mockResolvedValue({
    batteryPercent: 73, storageUsedBytes: 25, storageTotalBytes: 100,
  });
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('refreshes immediately and every ten seconds; stops after leaving home', async () => {
  await act(async () => { tree = Renderer.create(<TodayScreen />); });
  expect(mockPatch).toHaveBeenCalledWith({ deviceBattery: 73, deviceStorage: 25 });
  await act(async () => jest.advanceTimersByTime(9999));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(1));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
  await act(async () => jest.advanceTimersByTime(10000));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(2);
});
test('pauses in background and during sync, then refreshes on return', async () => {
  await act(async () => { tree = Renderer.create(<TodayScreen />); });
  await act(async () => { change('background'); jest.advanceTimersByTime(20000); });
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(1);
  await act(async () => change('active'));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(2);
  mockState.syncStage = 'transfer';
  await act(async () => tree.update(<TodayScreen />));
  await act(async () => jest.advanceTimersByTime(20000));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(2);
  mockState.syncStage = null;
  await act(async () => tree.update(<TodayScreen />));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(3);
});
test('does not overlap slow requests and retries failures', async () => {
  let reject!: (error: Error) => void;
  (transport.getDeviceTelemetry as jest.Mock).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => { tree = Renderer.create(<TodayScreen />); });
  await act(async () => jest.advanceTimersByTime(20000));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Disconnected')));
  expect(mockPatch).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(10000));
  expect(transport.getDeviceTelemetry).toHaveBeenCalledTimes(2);
  expect(mockPatch).toHaveBeenCalled();
});
