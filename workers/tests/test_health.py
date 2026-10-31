import asyncio
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from audio_workers.config import settings
from audio_workers.main import app, health


def test_health() -> None:
    response = asyncio.run(health())

    assert response.service == "audio-workers"
    assert response.status == "ok"


def test_readiness_reports_missing_runtime_dependencies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ffmpeg_path", sys.executable)
    monkeypatch.setattr(settings, "diarization_model_path", str(tmp_path / "missing"))
    monkeypatch.setattr(settings, "acoustic_model_path", str(tmp_path / "missing"))
    monkeypatch.setattr(settings, "acoustic_labels_path", str(tmp_path / "missing"))
    monkeypatch.setattr(settings, "asr_cache_dir", str(tmp_path / "cache"))

    response = TestClient(app).get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["checks"]["audio_cache"] is True


def test_inference_authentication_is_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "api_token", "test-secret")
    client = TestClient(app)
    payload = {
        "analysisId": "analysis-1",
        "sourceUrl": "http://localhost/audio.wav",
    }

    assert client.post("/v1/scan", json=payload).status_code == 401
    assert (
        client.post(
            "/v1/scan",
            json=payload,
            headers={"authorization": "Bearer wrong"},
        ).status_code
        == 401
    )
    assert client.get("/health").status_code == 200
