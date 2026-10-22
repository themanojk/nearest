import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { recordingDebug, type AudioStatus } from '../services/recordingDebug';
import Txt from './Txt';
import Icon from './Icon';
import { colors } from '../theme/theme';

let stopCurrent: (() => void) | undefined;
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(
    2,
    '0',
  )}`;
export default function InsightAudio({
  id,
  unavailable,
  durationMs = 0,
  clip,
}: {
  id: string;
  unavailable?: string;
  durationMs?: number;
  clip?: { startMs: number; endMs: number };
}) {
  const [loading, setLoading] = useState(false);
  const cachedPlayback = useRef<{ url: string; expiresAt?: string } | null>(
    null,
  );
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [speed, setSpeed] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const barWidth = useRef(1);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const nativeStarted = useRef(false);
  const owner = useRef<() => void>(() => {});
  const stableStop = useRef(() => owner.current());
  const release = () => {
    generation.current++;
    nativeStarted.current = false;
    setLoading(false);
    setScrub(null);
    setActive(false);
    setStatus(null);
    if (stopCurrent === stableStop.current) {
      stopCurrent = undefined;
      void recordingDebug.stop().catch(() => {});
    }
  };
  owner.current = release;
  useEffect(() => {
    const stopOwned = stableStop.current;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') stopOwned();
    });
    return () => {
      stopOwned();
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (unavailable) stableStop.current();
  }, [unavailable]);
  useEffect(() => { cachedPlayback.current = null; stableStop.current(); }, [id, clip?.startMs, clip?.endMs]);
  useEffect(() => {
    if (!active && !loading) return;
    let disposed = false;
    const began = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - began > 30000 && !active) {
        setError('Audio took too long to load. Please try again.');
        stableStop.current();
        return;
      }
      if (!nativeStarted.current) return;
      recordingDebug
        .status()
        .then(value => {
          if (disposed) return;
          setStatus(value);
          if (value.error) {
            setError(value.error);
            stableStop.current();
          } else if (active && clip && !value.loading && value.positionMs >= clip.endMs) {
            stableStop.current();
          } else if (
            !value.loading &&
            !value.playing &&
            value.durationMs > 0 &&
            value.positionMs >= value.durationMs - 250
          )
            stableStop.current();
        })
        .catch(err => {
          if (!disposed) {
            setError(String(err));
            stableStop.current();
          }
        });
    }, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, loading, clip?.endMs]);
  async function play() {
    stopCurrent?.();
    const request = ++generation.current;
    stopCurrent = stableStop.current;
    setError('');
    setStatus(null);
    setSpeed(1);
    setLoading(true);
    const started = Date.now();
    try {
      const cached = cachedPlayback.current;
      const result =
        cached?.expiresAt && Date.parse(cached.expiresAt) > Date.now() + 60000
          ? cached
          : await recordingDebug.playback(id);
      cachedPlayback.current = result;
      console.info(
        `[NearNest audio] ${new Date().toISOString()} playback_url_ms=${
          Date.now() - started
        }`,
      );
      if (request !== generation.current) return;
      nativeStarted.current = true;
      if (clip) await recordingDebug.playClip(result.url, clip.startMs, clip.endMs);
      else await recordingDebug.play(result.url);
      if (request !== generation.current) return;
      setActive(true);
      setLoading(false);
    } catch (err) {
      if (request === generation.current) {
        setError(err instanceof Error ? err.message : String(err));
        stableStop.current();
      }
    }
  }
  const duration = status?.durationMs || durationMs;
  const ready = active && !!status && !status.loading && status.durationMs > 0;
  const position = scrub ?? status?.positionMs ?? clip?.startMs ?? 0;
  const seek = async (ms: number) => {
    setScrub(null);
    if (!ready) return;
    try {
      await recordingDebug.seek(ms);
      setStatus(value => (value ? { ...value, positionMs: ms } : value));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const fromX = (x: number) =>
    Math.max(0, Math.min(1, x / barWidth.current)) * duration;
  return (
    <View style={{ gap: 5 }}>
      <Pressable
        accessibilityRole="button"
        disabled={!!unavailable}
        onPress={() => {
          if (active || loading) stableStop.current();
          else void play();
        }}
        style={{ paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <Icon name={active || loading ? 'stop' : 'play'} size={18} />
        <Txt weight="semibold" size={13} color={colors.primaryGreenDark}>
          {unavailable ||
            (loading ? 'Cancel loading' : active ? 'Stop audio' : clip ? 'Listen to this moment' : 'Play full recording')}
        </Txt>
      </Pressable>
      <Txt size={12}>
        {clip ? `${time(clip.startMs)}–${time(clip.endMs)} · ${Math.ceil((clip.endMs - clip.startMs) / 1000)} sec clip` : `${time(position)} / ${duration > 0 ? time(duration) : '—'}`}
        {loading ? ' · Connecting…' : active && !ready ? ' · Buffering…' : ''}
      </Txt>
      {!unavailable && !clip && (
        <View style={{ gap: 8 }}>
          <View
            accessibilityRole="adjustable"
            accessibilityLabel="Audio progress"
            accessibilityState={{ disabled: !ready }}
            accessibilityValue={{
              min: 0,
              max: duration,
              now: position,
              text: `${time(position)} of ${time(duration)}`,
            }}
            accessibilityActions={[
              { name: 'increment', label: 'Forward 10 seconds' },
              { name: 'decrement', label: 'Back 10 seconds' },
            ]}
            onAccessibilityAction={event =>
              void seek(
                Math.max(
                  0,
                  Math.min(
                    duration,
                    position +
                      (event.nativeEvent.actionName === 'increment'
                        ? 10000
                        : -10000),
                  ),
                ),
              )
            }
            onLayout={event => {
              barWidth.current = Math.max(1, event.nativeEvent.layout.width);
            }}
            onStartShouldSetResponder={() => ready}
            onMoveShouldSetResponder={() => ready}
            onResponderGrant={event =>
              setScrub(fromX(event.nativeEvent.locationX))
            }
            onResponderMove={event =>
              setScrub(fromX(event.nativeEvent.locationX))
            }
            onResponderRelease={event =>
              void seek(fromX(event.nativeEvent.locationX))
            }
            onResponderTerminationRequest={() => false}
            onResponderTerminate={() => setScrub(null)}
            style={{ height: 40, justifyContent: 'center' }}
          >
            <View
              pointerEvents="none"
              style={{ height: 6, borderRadius: 3, backgroundColor: '#d8e2dd' }}
            >
              <View
                style={{
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: colors.primaryGreenDark,
                  width: `${Math.min(
                    100,
                    (position / (duration || 1)) * 100,
                  )}%`,
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  top: -5,
                  left: `${Math.min(100, (position / (duration || 1)) * 100)}%`,
                  marginLeft: -8,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: colors.primaryGreenDark,
                }}
              />
            </View>
          </View>
          {scrub !== null && <Txt size={12}>Seek to {time(scrub)}</Txt>}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {[1, 1.5, 2, 3, 4].map(value => (
              <Pressable
                key={value}
                accessibilityRole="button"
                disabled={!ready}
                accessibilityLabel={`Playback speed ${value}x`}
                accessibilityState={{ selected: speed === value }}
                onPress={async () => {
                  try {
                    await recordingDebug.speed(value);
                    setSpeed(value);
                    setError('');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: speed === value ? '#d8e2dd' : 'transparent',
                }}
              >
                <Txt size={12} weight="semibold">
                  {value}×
                </Txt>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {!!error && (
        <Txt size={12} color={colors.destructive}>
          {error}
        </Txt>
      )}
    </View>
  );
}
