from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    service_name: str = "audio-workers"
    service_version: str = "0.1.0"
    allowed_audio_hosts: str = "localhost,127.0.0.1"
    ffmpeg_path: str = "ffmpeg"
    ffmpeg_timeout_seconds: int = 3600
    asr_model_size: str = "large-v3-turbo"
    asr_device: str = "cpu"
    asr_compute_type: str = "int8"
    asr_cpu_threads: int = 0
    asr_num_workers: int = 2
    asr_beam_size: int = 3
    asr_batch_size: int = 4
    asr_vad_filter: bool = True
    asr_vad_threshold: float = 0.25
    asr_vad_fallback_ratio: float = 0.15
    asr_vad_min_silence_ms: int = 300
    asr_vad_speech_pad_ms: int = 150
    asr_min_word_probability: float = 0.0
    asr_language_probability_threshold: float = 0.6
    asr_cache_dir: str = "/private/tmp/kid-audio-asr-cache"
    asr_cache_ttl_seconds: int = 21_600
    diarization_max_speakers: int = 8
    diarization_similarity_threshold: float = 0.5
    diarization_utterance_gap_ms: int = 900
    diarization_max_utterance_ms: int = 12_000
    diarization_min_anchor_ms: int = 1_200
    diarization_model_path: str = (
        "models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
    )
    acoustic_model_path: str = "models/audio-tagging/model.int8.onnx"
    acoustic_labels_path: str = (
        "models/audio-tagging/class_labels_indices.csv"
    )
    acoustic_window_ms: int = 10_000
    acoustic_min_probability: float = 0.35
    health_window_ms: int = 2_000
    health_hop_ms: int = 500
    health_cough_min_probability: float = 0.35
    health_wheeze_min_probability: float = 0.25
    health_gasp_min_probability: float = 0.25
    health_merge_gap_ms: int = 750

    @property
    def audio_host_allowlist(self) -> set[str]:
        return {
            host.strip().lower()
            for host in self.allowed_audio_hosts.split(",")
            if host.strip()
        }

    model_config = SettingsConfigDict(
        env_prefix="WORKER_",
        env_file=".env",
        extra="ignore",
    )


settings = Settings()
