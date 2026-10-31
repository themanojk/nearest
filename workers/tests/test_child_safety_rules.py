import pytest

from audio_workers.context import classify_context
from audio_workers.contracts import (
    ContextClassificationRequest,
    ContextSessionResult,
)


def classify(text: str, confidence: float = 0.9) -> ContextSessionResult:
    request = ContextClassificationRequest.model_validate(
        {
            "analysisId": "test",
            "sessions": [
                {
                    "sessionId": "session",
                    "startMs": 12000,
                    "endMs": 18000,
                    "speakers": ["speaker"],
                    "utterances": [
                        {
                            "startMs": 12000,
                            "endMs": 18000,
                            "speakerId": "speaker",
                            "text": text,
                            "confidence": confidence,
                        }
                    ],
                }
            ],
        }
    )
    return classify_context(request).sessions[0]


@pytest.mark.parametrize(
    "text,label",
    [
        ("Tu badtameez hai", "insult"),
        ("तुम बदतमीज़ हो", "insult"),
        ("तुम बदतमीज हो", "insult"),
        ("Saale idhar aa", "insult"),
        ("Saley idhar aa", "insult"),
        ("Abe sale idhar aa", "insult"),
        ("साले इधर आ", "insult"),
        ("Tujhe maar dunga", "threat"),
        ("तुझे मार दूँगा", "threat"),
        ("He touched my private parts", "violence_disclosure"),
        ("Mujhe mat chuo", "distress"),
        ("मुझे मत छुओ", "distress"),
        ("Kisi ko mat batana", "secrecy_request"),
        ("Kapde utaro", "inappropriate_request"),
        ("Give me your money or I will hit you", "coercion"),
        ("Send me your password", "unsafe_contact"),
        ("Try this cigarette", "substance_pressure"),
        ("Saans nahi aa rahi", "medical_distress"),
        ("साँस नहीं आ रही", "medical_distress"),
        ("Main marna chahti hoon", "self_harm"),
        ("Koi mera peecha kar raha", "imminent_danger"),
    ],
)
def test_timestamped_review_signals(text: str, label: str) -> None:
    signals = classify(text).safety_signals
    matched = [signal for signal in signals if signal.signal_type == label]
    assert matched
    assert all(
        signal.start_ms == 12000 and signal.end_ms == 18000 for signal in matched
    )
    assert all(signal.speaker_id == "speaker" for signal in matched)


@pytest.mark.parametrize(
    "text",
    [
        "This book is on sale today",
        "The sale ends tomorrow",
        "We are learning about medicine at school",
        "Please send me your homework photo",
        "We will meet at school tomorrow",
    ],
)
def test_ordinary_phrases_do_not_create_risk(text: str) -> None:
    assert not classify(text).safety_signals


def test_education_is_review_not_high_risk_and_disclosure_survives() -> None:
    assert all(
        s.severity != "high"
        for s in classify("In the movie I will hurt you").safety_signals
    )
    assert any(
        s.severity == "high"
        for s in classify("He said I will hurt you if you tell anyone").safety_signals
    )


def test_repeated_hindi_profanity_and_zero_asr_confidence() -> None:
    result = classify("Saale kameene", 0.0)
    assert result.profanity.occurrence_count == 2
    assert result.profanity.notification_recommended
    assert all(o.confidence == 0 for o in result.profanity.occurrences)


@pytest.mark.parametrize(
    "text", ["I will not hurt you", "I won't kill you", "I would never kill myself"]
)
def test_explicit_negation_does_not_become_a_threat(text: str) -> None:
    assert not classify(text).safety_signals


@pytest.mark.parametrize(
    "text,label",
    [
        ("They keep calling me names", "bullying"),
        ("Mujhe khana nahi dete", "neglect_disclosure"),
    ],
)
def test_new_categories_have_consistent_conversation_labels(
    text: str,
    label: str,
) -> None:
    assert classify(text).conversation_type.label == label
