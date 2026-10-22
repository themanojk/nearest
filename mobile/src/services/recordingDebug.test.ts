import { NativeModules } from 'react-native';
import { recordingDebug } from './recordingDebug';
jest.mock('./auth', () => ({ authenticatedRequest: jest.fn() }));
const native = {
  playDebugAudio: jest.fn().mockResolvedValue(undefined),
  seekDebugAudio: jest.fn().mockResolvedValue(undefined),
  stopDebugAudio: jest.fn().mockResolvedValue(undefined),
  getDebugAudioStatus: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
  NativeModules.NearNestLocalTransfer = native;
  native.getDebugAudioStatus.mockResolvedValue({ loading: false, playing: true, durationMs: 60000, positionMs: 0 });
});
afterEach(() => jest.useRealTimers());
test('older native builds play clips using the existing seek method', async () => {
  await recordingDebug.playClip('https://example/audio', 12000, 18000);
  expect(native.playDebugAudio).toHaveBeenCalledWith('https://example/audio');
  expect(native.seekDebugAudio).toHaveBeenCalledWith(12000);
});
test('waits for metadata before seeking', async () => {
  jest.useFakeTimers();
  native.getDebugAudioStatus.mockResolvedValueOnce({ loading: true, durationMs: 0 });
  const pending = recordingDebug.playClip('url', 12000, 18000);
  await jest.advanceTimersByTimeAsync(100);
  await pending;
  expect(native.seekDebugAudio).toHaveBeenCalledWith(12000);
});
test('cancelled loading cannot seek the next recording', async () => {
  jest.useFakeTimers();
  native.getDebugAudioStatus.mockResolvedValueOnce({ loading: true, durationMs: 0 });
  const pending = recordingDebug.playClip('url', 12000, 18000);
  await jest.advanceTimersByTimeAsync(0);
  await recordingDebug.stop();
  await recordingDebug.play('next');
  await jest.advanceTimersByTimeAsync(100);
  await pending;
  expect(native.seekDebugAudio).not.toHaveBeenCalled();
});
test('surfaces unavailable audio and invalid offsets', async () => {
  await expect(recordingDebug.playClip('url', 60000, 65000)).rejects.toThrow('outside');
  native.getDebugAudioStatus.mockResolvedValueOnce({ error: 'Network failed' });
  await expect(recordingDebug.playClip('url', 0, 1000)).rejects.toThrow('Network failed');
  await expect(recordingDebug.playClip('url', 1000, 0)).rejects.toThrow('invalid');
});
