import argparse
import json
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Phrase:
    text: str
    expected_terms: tuple[str, ...]
    expected_signals: tuple[str, ...]


@dataclass(frozen=True)
class Profile:
    name: str
    rate: int
    gain_db: int
    noise_db: int | None = None


PHRASES = [
    Phrase("Abe saale idhar aa", ("saale",), ("insult",)),
    Phrase("Tu saala bilkul pagal hai", ("saala",), ("insult",)),
    Phrase("Saali chup kar aur yahan baith", ("saali",), ("insult",)),
    Phrase("Tum bahut badtameez ho", ("badtameez",), ("insult",)),
    Phrase("Tu bilkul bewakoof hai", ("bewakoof",), ("insult",)),
    Phrase("Kameene meri baat sun", ("kameene",), ("insult",)),
    Phrase("Tu nikamma hai kuch nahi karta", ("nikamma",), ("insult",)),
    Phrase("Nalayak idhar wapas aao", ("nalayak",), ("insult",)),
    Phrase("Oye saley phone neeche rakh", ("saley",), ("insult",)),
    Phrase("Besharam tum phir jhoot bol rahe ho", ("besharam",), ("insult",)),
    Phrase("Saale bewakoof meri cheez mat le", ("saale", "bewakoof"), ("insult",)),
    Phrase("Tum badtamiz aur nalayak ho", ("badtamiz", "nalayak"), ("insult",)),
    Phrase("अबे साले इधर आ", ("साले",), ("insult",)),
    Phrase("तुम बहुत बदतमीज़ हो", ("बदतमीज़",), ("insult",)),
    Phrase("तू बिल्कुल बेवकूफ है", ("बेवकूफ",), ("insult",)),
    Phrase("कमीने मेरी बात सुन", ("कमीने",), ("insult",)),
    Phrase("निकम्मा कुछ काम नहीं करता", ("निकम्मा",), ("insult",)),
    Phrase("नालायक वापस इधर आओ", ("नालायक",), ("insult",)),
    Phrase("यह किताब आज सेल पर है", (), ()),
    Phrase("The shop has a sale today", (), ()),
    Phrase("What does the word saale mean", ("saale",), ()),
    Phrase("Teacher explained that badtameez is a rude word", ("badtameez",), ()),
    Phrase("Movie mein kisi ne saala bola tha", ("saala",), ()),
    Phrase("Saali meri dost ka naam nahi hai", ("saali",), ()),
    Phrase("तुम बहुत समझदार हो", (), ()),
    Phrase("Please sit down and finish your homework", (), ()),
    Phrase("Aaj school mein sabne milkar cricket khela", (), ()),
    Phrase("मुझे कहानी बहुत अच्छी लगी", (), ()),
    Phrase("Kal hum bazaar jaakar kitaab kharidenge", (), ()),
    Phrase("Phone neeche rakho aur khana kha lo", (), ()),
]

PROFILES = [
    Profile("clean", 165, 0),
    Profile("soft", 150, -20),
    Profile("fast", 220, -6),
    Profile("noisy", 175, -8, -30),
]
ROMAN_VOICES = ["Aman", "Rishi", "Tara"]
DEVANAGARI_VOICE = "Lekha"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a synthetic Hindi/Hinglish ASR regression corpus."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("evaluation"),
    )
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    _require_command("say")
    _require_command("ffmpeg")

    output_dir = args.output_dir.resolve()
    audio_dir = output_dir / "audio"
    reports_dir = output_dir / "reports"
    audio_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, object]] = []
    phrase_count = len(PHRASES) if args.limit is None else min(args.limit, len(PHRASES))

    with tempfile.TemporaryDirectory(prefix="nearnest-synthetic-") as temporary:
        temporary_dir = Path(temporary)
        for phrase_index, phrase in enumerate(PHRASES[:phrase_count]):
            for profile in PROFILES:
                case_id = f"synthetic-{phrase_index + 1:03d}-{profile.name}"
                voice = _voice_for(phrase.text, phrase_index)
                intermediate = temporary_dir / f"{case_id}.aiff"
                destination = audio_dir / f"{case_id}.wav"
                _synthesize(phrase.text, voice, profile.rate, intermediate)
                _render_profile(intermediate, destination, profile)
                duration_ms = _wave_duration_ms(destination)
                split = "heldout" if phrase_index % 5 == 0 else "development"
                cases.append(
                    {
                        "id": case_id,
                        "audioPath": str(destination.relative_to(output_dir)),
                        "startMs": 0,
                        "endMs": duration_ms,
                        "languageMode": "AUTO",
                        "referenceText": phrase.text,
                        "expectedTerms": list(phrase.expected_terms),
                        "expectedSignals": list(phrase.expected_signals),
                        "split": split,
                        "synthetic": True,
                        "voice": voice,
                        "profile": profile.name,
                    }
                )

    _write_manifest(output_dir / "cases.jsonl", cases)
    _write_manifest(
        output_dir / "development.jsonl",
        [case for case in cases if case["split"] == "development"],
    )
    _write_manifest(
        output_dir / "heldout.jsonl",
        [case for case in cases if case["split"] == "heldout"],
    )
    metadata = {
        "synthetic": True,
        "caseCount": len(cases),
        "phraseCount": phrase_count,
        "profiles": [profile.name for profile in PROFILES],
        "limitations": [
            "Adult synthetic voices only",
            "Not representative of spontaneous child speech",
            "Not suitable as sole evidence for production safety claims",
        ],
    }
    (output_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False))


def _voice_for(text: str, index: int) -> str:
    if any("\u0900" <= character <= "\u097f" for character in text):
        return DEVANAGARI_VOICE
    return ROMAN_VOICES[index % len(ROMAN_VOICES)]


def _synthesize(text: str, voice: str, rate: int, output_path: Path) -> None:
    subprocess.run(
        [
            "say",
            "-v",
            voice,
            "-r",
            str(rate),
            "-o",
            str(output_path),
            text,
        ],
        check=True,
        capture_output=True,
    )


def _render_profile(source: Path, destination: Path, profile: Profile) -> None:
    command = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(source)]
    if profile.noise_db is None:
        command.extend(["-af", f"volume={profile.gain_db}dB"])
    else:
        command.extend(
            [
                "-f",
                "lavfi",
                "-i",
                "anoisesrc=color=pink:sample_rate=16000",
                "-filter_complex",
                (
                    f"[0:a]volume={profile.gain_db}dB[speech];"
                    f"[1:a]volume={profile.noise_db}dB[noise];"
                    "[speech][noise]amix=inputs=2:duration=first:normalize=0[out]"
                ),
                "-map",
                "[out]",
            ]
        )
    command.extend(
        [
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(destination),
        ]
    )
    subprocess.run(command, check=True, capture_output=True)


def _wave_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as audio:
        duration_ms = round(
            audio.getnframes() * 1_000 / audio.getframerate()
        )
    if duration_ms <= 0:
        raise RuntimeError(f"Synthetic audio is empty: {path}")
    return duration_ms


def _write_manifest(path: Path, cases: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(
            json.dumps(case, ensure_ascii=False) + "\n"
            for case in cases
        ),
        encoding="utf-8",
    )


def _require_command(command: str) -> None:
    if shutil.which(command) is None:
        raise RuntimeError(f"Required command is not available: {command}")


if __name__ == "__main__":
    main()
