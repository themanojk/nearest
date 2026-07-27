import hashlib
import os
import subprocess
import threading
import time
import wave
from contextlib import suppress
from pathlib import Path

from audio_workers.config import settings

_locks_guard = threading.Lock()
_analysis_locks: dict[str, threading.Lock] = {}


class AudioCacheError(RuntimeError):
    """Raised when a normalized source cannot be cached."""


def ensure_normalized_audio(
    analysis_id: str,
    source_url: str,
    *,
    ffmpeg_path: str,
    timeout_seconds: int,
) -> Path:
    cache_dir = Path(settings.asr_cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha256(analysis_id.encode()).hexdigest()
    target = cache_dir / f"{cache_key}.wav"
    lock = _lock_for(cache_key)
    with lock:
        if _is_valid_wave(target):
            target.touch()
            return target
        _remove_if_present(target)
        _remove_expired(cache_dir, exclude=target)
        temporary = cache_dir / (
            f".{cache_key}.{os.getpid()}.{threading.get_ident()}.tmp.wav"
        )
        command = [
            ffmpeg_path,
            "-nostdin",
            "-v",
            "error",
            "-i",
            source_url,
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(temporary),
        ]
        process = subprocess.run(
            command,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        if process.returncode != 0 or not _is_valid_wave(temporary):
            _remove_if_present(temporary)
            raise AudioCacheError(
                "FFmpeg could not normalize the source audio for ASR"
            )
        temporary.replace(target)
        return target


def _lock_for(cache_key: str) -> threading.Lock:
    with _locks_guard:
        return _analysis_locks.setdefault(cache_key, threading.Lock())


def _is_valid_wave(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size <= 44:
        return False
    try:
        with wave.open(str(path), "rb") as audio:
            return (
                audio.getnchannels() == 1
                and audio.getsampwidth() == 2
                and audio.getframerate() == 16_000
                and audio.getnframes() > 0
            )
    except (EOFError, wave.Error):
        return False


def _remove_expired(cache_dir: Path, *, exclude: Path) -> None:
    cutoff = time.time() - settings.asr_cache_ttl_seconds
    for path in cache_dir.glob("*.wav"):
        if path != exclude and path.stat().st_mtime < cutoff:
            _remove_if_present(path)


def _remove_if_present(path: Path) -> None:
    with suppress(FileNotFoundError):
        path.unlink()
