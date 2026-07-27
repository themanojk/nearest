import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

interface AudioPlayerProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  durationMs?: number;
  fileName: string;
  url: string;
}

function playerTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function AudioPlayer({
  audioRef,
  durationMs,
  fileName,
  url,
}: AudioPlayerProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(
    (durationMs ?? 0) / 1000,
  );
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [error, setError] = useState<string>();
  const [mainPlayerVisible, setMainPlayerVisible] = useState(true);
  const [playerActivated, setPlayerActivated] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const observer = new IntersectionObserver(
      ([entry]) => setMainPlayerVisible(entry.isIntersecting),
      { threshold: 0.2 },
    );
    observer.observe(player);
    return () => observer.disconnect();
  }, []);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    setError(undefined);
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      setError('Playback could not start. Try again after the audio loads.');
    }
  }

  function seek(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const maximum = mediaDuration || audio.duration || 0;
    audio.currentTime = Math.max(0, Math.min(seconds, maximum));
    setCurrentTime(audio.currentTime);
  }

  function updateVolume(nextVolume: number) {
    setVolume(nextVolume);
    if (audioRef.current) audioRef.current.volume = nextVolume;
  }

  function updateRate(nextRate: number) {
    setPlaybackRate(nextRate);
    if (audioRef.current) audioRef.current.playbackRate = nextRate;
  }

  return (
    <div className="audio-player" ref={playerRef}>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onDurationChange={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) {
            setMediaDuration(event.currentTarget.duration);
          }
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          setPlayerActivated(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError('The source audio could not be loaded.')}
      >
        Your browser does not support audio playback.
      </audio>

      <div className="audio-player-title">
        <div>
          <strong>{fileName}</strong>
          <span>Original recording</span>
        </div>
        <span className={playing ? 'audio-state playing' : 'audio-state'}>
          {playing ? 'Playing' : 'Paused'}
        </span>
      </div>

      <div className="audio-player-main">
        <button
          type="button"
          className="audio-skip"
          aria-label="Skip back 10 seconds"
          onClick={() => seek(currentTime - 10)}
        >
          ↶ <span>10</span>
        </button>
        <button
          type="button"
          className="audio-play"
          aria-label={playing ? 'Pause audio' : 'Play audio'}
          onClick={() => void togglePlayback()}
        >
          {playing ? 'Ⅱ' : '▶'}
        </button>
        <button
          type="button"
          className="audio-skip"
          aria-label="Skip forward 10 seconds"
          onClick={() => seek(currentTime + 10)}
        >
          ↷ <span>10</span>
        </button>

        <span className="audio-time">{playerTime(currentTime)}</span>
        <input
          className="audio-scrubber"
          type="range"
          min="0"
          max={Math.max(mediaDuration, 0)}
          step="0.1"
          value={Math.min(currentTime, mediaDuration || 0)}
          aria-label="Audio position"
          onChange={(event) => seek(Number(event.target.value))}
          style={{
            '--audio-progress': `${
              mediaDuration > 0 ? (currentTime / mediaDuration) * 100 : 0
            }%`,
          } as CSSProperties}
        />
        <span className="audio-time">{playerTime(mediaDuration)}</span>
      </div>

      <div className="audio-player-options">
        <label>
          <span>Volume</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            aria-label="Volume"
            onChange={(event) => updateVolume(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Speed</span>
          <select
            value={playbackRate}
            aria-label="Playback speed"
            onChange={(event) => updateRate(Number(event.target.value))}
          >
            <option value="0.75">0.75×</option>
            <option value="1">1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select>
        </label>
        <span>Use “Listen” on any event to jump to its timestamp.</span>
      </div>

      {error && (
        <p className="audio-error" role="alert">
          {error}
        </p>
      )}

      {playerActivated && !mainPlayerVisible && (
        <div
          className="audio-mini-player"
          role="region"
          aria-label="Floating audio controls"
        >
          <div className="audio-mini-title">
            <span>{playing ? 'Now playing' : 'Playback paused'}</span>
            <strong>{fileName}</strong>
          </div>
          <button
            type="button"
            className="audio-skip"
            aria-label="Skip back 10 seconds"
            onClick={() => seek(currentTime - 10)}
          >
            ↶ <span>10</span>
          </button>
          <button
            type="button"
            className="audio-play audio-play-mini"
            aria-label={playing ? 'Pause audio' : 'Resume audio'}
            onClick={() => void togglePlayback()}
          >
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <button
            type="button"
            className="audio-skip"
            aria-label="Skip forward 10 seconds"
            onClick={() => seek(currentTime + 10)}
          >
            ↷ <span>10</span>
          </button>
          <span className="audio-time">{playerTime(currentTime)}</span>
          <input
            className="audio-scrubber audio-mini-scrubber"
            type="range"
            min="0"
            max={Math.max(mediaDuration, 0)}
            step="0.1"
            value={Math.min(currentTime, mediaDuration || 0)}
            aria-label="Audio position"
            onChange={(event) => seek(Number(event.target.value))}
            style={{
              '--audio-progress': `${
                mediaDuration > 0 ? (currentTime / mediaDuration) * 100 : 0
              }%`,
            } as CSSProperties}
          />
          <span className="audio-time">{playerTime(mediaDuration)}</span>
          <button
            type="button"
            className="audio-open-player"
            onClick={() =>
              playerRef.current?.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              })
            }
          >
            Full controls
          </button>
        </div>
      )}
    </div>
  );
}
