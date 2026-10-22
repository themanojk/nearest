import { NativeModules } from 'react-native';
import { authenticatedRequest } from './auth';

export type ImportedRecording = {
  analysisId: string;
  childId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  status: string;
  progress: number;
  audioDeletedAt?: string;
  mediaMetadata?: { durationMs: number };
  [key: string]: unknown;
};
export type RecordingPage = {
  items: ImportedRecording[];
  page: number;
  total: number;
};
export type AudioStatus = {
  loading: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  error?: string;
};
function player() {
  const module = NativeModules.NearNestLocalTransfer;
  if (!module?.playDebugAudio) {
    throw new Error('Rebuild the native app to enable the debug audio player.');
  }
  return module as {
    playDebugAudioClip?(url: string, startMs: number, endMs: number): Promise<void>;
    playDebugAudio(url: string): Promise<void>;
    seekDebugAudio(positionMs: number): Promise<void>;
    setDebugAudioSpeed(speed: number): Promise<void>;
    stopDebugAudio(): Promise<void>;
    getDebugAudioStatus(): Promise<AudioStatus>;
  };
}
let playbackGeneration = 0;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const recordingDebug = {
  list: (page = 1) =>
    authenticatedRequest<RecordingPage>(
      `/audio-analysis?page=${page}&limit=50`,
    ),
  playback: (id: string) =>
    authenticatedRequest<{ url: string; expiresAt?: string }>(
      `/audio-analysis/${encodeURIComponent(id)}/playback`,
    ),
  deleteAudio: (id: string) =>
    authenticatedRequest<ImportedRecording>(
      `/audio-analysis/${encodeURIComponent(id)}/audio`,
      { method: 'DELETE' },
    ),
  play: async (url: string) => { playbackGeneration++; return player().playDebugAudio(url); },
  playClip: async (url: string, startMs: number, endMs: number) => {
    const native = player();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs)
      throw new Error('This moment has invalid audio timestamps.');
    const generation = ++playbackGeneration;
    if (native.playDebugAudioClip) return native.playDebugAudioClip(url, startMs, endMs);
    // Compatibility for installed builds that already support full playback and
    // seeking, but predate the dedicated native clip method.
    if (!native.seekDebugAudio) throw new Error('Update the app to enable audio seeking.');
    await native.playDebugAudio(url);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (generation !== playbackGeneration) return;
      const status = await native.getDebugAudioStatus();
      if (generation !== playbackGeneration) return;
      if (status.error) throw new Error(status.error);
      if (!status.loading && status.durationMs > 0) {
        if (startMs >= status.durationMs) throw new Error('This moment is outside the available recording.');
        await native.seekDebugAudio(startMs);
        return;
      }
      await delay(100);
    }
    throw new Error('Audio took too long to load. Check your connection and try again.');
  },
  stop: async () => { playbackGeneration++; return player().stopDebugAudio(); },
  seek: async (positionMs: number) => {
    if (!player().seekDebugAudio)
      throw new Error('Rebuild the native app to enable seeking.');
    return player().seekDebugAudio(positionMs);
  },
  speed: async (speed: number) => {
    if (!player().setDebugAudioSpeed)
      throw new Error('Rebuild the native app to enable playback speed.');
    return player().setDebugAudioSpeed(speed);
  },
  status: async () => player().getDebugAudioStatus(),
};
