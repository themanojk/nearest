import asyncio

from audio_workers.main import health


def test_health() -> None:
    response = asyncio.run(health())

    assert response.service == "audio-workers"
    assert response.status == "ok"
