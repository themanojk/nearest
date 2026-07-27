from audio_workers.context import assess_quality, classify_context
from audio_workers.contracts import ContextClassificationRequest


def test_quality_gate_rejects_navigation_repetition() -> None:
    quality = assess_quality("5.5 km 5.5 km 5.5 km")

    assert quality.usable is False
    assert "navigation_or_device_audio" in quality.flags
    assert "repetitive" not in quality.flags


def test_classifier_returns_timestamped_threat_evidence() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 1_000,
                        "endMs": 4_000,
                        "speakers": ["SPEAKER_01", "SPEAKER_02"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 2_000,
                                "speakerId": "SPEAKER_01",
                                "text": "You should leave now.",
                            },
                            {
                                "startMs": 2_100,
                                "endMs": 4_000,
                                "speakerId": "SPEAKER_02",
                                "text": "I will hurt you if you come back.",
                            },
                        ],
                    }
                ],
            }
        )
    )

    session = result.sessions[0]
    assert session.quality.usable is True
    assert session.conversation_type.label == "threat"
    assert session.safety_signals[0].signal_type == "threat"
    assert session.safety_signals[0].start_ms == 2_100
    assert session.safety_signals[0].speaker_id == "SPEAKER_02"


def test_classifier_marks_child_direction_unknown() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 1_000,
                        "endMs": 5_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 5_000,
                                "speakerId": "SPEAKER_01",
                                "text": "This is damn difficult but we can do it.",
                            }
                        ],
                    }
                ],
            }
        )
    )

    assert result.sessions[0].profanity.severity == "mild"
    assert result.sessions[0].profanity.directed_at_child == "unknown"


def test_classifier_detects_english_and_hindi_imminent_danger() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 130_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 40_870,
                                "endMs": 41_950,
                                "speakerId": "SPEAKER_01",
                                "text": "think I'm gonna die tonight",
                            },
                            {
                                "startMs": 62_060,
                                "endMs": 67_360,
                                "speakerId": "SPEAKER_01",
                                "text": (
                                    "इसको मैं कई बार देख चुका हूँ यही मेरो "
                                    "पीशा कर रहा है"
                                ),
                            },
                            {
                                "startMs": 120_700,
                                "endMs": 122_420,
                                "speakerId": "SPEAKER_01",
                                "text": "I think I am in danger",
                            },
                        ],
                    }
                ],
            }
        )
    )

    session = result.sessions[0]
    assert session.conversation_type.label == "imminent_danger"
    assert [
        signal.signal_type for signal in session.safety_signals
    ] == [
        "imminent_danger",
        "imminent_danger",
    ]
    assert session.safety_signals[0].evidence == (
        "इसको मैं कई बार देख चुका हूँ यही मेरो पीशा कर रहा है"
    )


def test_standalone_going_to_die_expression_is_not_a_safety_signal() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 5_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 2_000,
                                "speakerId": "SPEAKER_01",
                                "text": "I'm gonna die tonight.",
                            }
                        ],
                    }
                ],
            }
        )
    )

    assert result.sessions[0].safety_signals == []
    assert result.sessions[0].conversation_type.label == "unknown"


def test_going_to_die_expression_uses_nearby_danger_context() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 10_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 2_000,
                                "speakerId": "SPEAKER_01",
                                "text": "I think I'm going to die.",
                            },
                            {
                                "startMs": 3_000,
                                "endMs": 5_000,
                                "speakerId": "SPEAKER_01",
                                "text": "I can't breathe, please help me.",
                            },
                        ],
                    }
                ],
            }
        )
    )

    session = result.sessions[0]
    danger = next(
        signal
        for signal in session.safety_signals
        if signal.signal_type == "imminent_danger"
    )
    assert danger.severity == "medium"
    assert danger.confidence == 0.82
    assert session.conversation_type.label == "imminent_danger"
    assert session.conversation_type.confidence == 0.82


def test_figurative_cue_suppresses_ambiguous_danger_expression() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 5_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 3_000,
                                "speakerId": "SPEAKER_01",
                                "text": (
                                    "I'm gonna die from laughing, haha. "
                                    "Please help me stop laughing."
                                ),
                            }
                        ],
                    }
                ],
            }
        )
    )

    assert all(
        signal.signal_type != "imminent_danger"
        for signal in result.sessions[0].safety_signals
    )


def test_explicit_self_harm_language_remains_high_priority() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 5_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 2_000,
                                "speakerId": "SPEAKER_01",
                                "text": "I want to die.",
                            }
                        ],
                    }
                ],
            }
        )
    )

    signal = result.sessions[0].safety_signals[0]
    assert signal.signal_type == "self_harm"
    assert signal.severity == "high"
    assert result.sessions[0].conversation_type.label == "self_harm"


def test_safety_signal_survives_low_session_quality() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 5_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 0,
                                "endMs": 5_000,
                                "speakerId": "SPEAKER_01",
                                "text": "5.5 km 5.5 km help me",
                            }
                        ],
                    }
                ],
            }
        )
    )

    session = result.sessions[0]
    assert session.quality.usable is False
    assert session.safety_signals[0].signal_type == "help_request"


def test_asr_variant_of_severe_curse_creates_exposure_notification() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 10_000,
                        "endMs": 20_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 13_780,
                                "endMs": 14_760,
                                "speakerId": "SPEAKER_01",
                                "text": "Mother jude.",
                                "confidence": 0.5046,
                            }
                        ],
                    }
                ],
            }
        )
    )

    profanity = result.sessions[0].profanity
    assert profanity.severity == "severe"
    assert profanity.occurrence_count == 1
    assert profanity.notification_recommended
    assert profanity.occurrences[0].canonical_term == "motherfucker"
    assert profanity.occurrences[0].confidence == 0.505
    assert (
        result.sessions[0].safety_signals[0].signal_type
        == "profanity_exposure"
    )


def test_repeated_moderate_profanity_creates_exposure_notification() -> None:
    result = classify_context(
        ContextClassificationRequest.model_validate(
            {
                "analysisId": "analysis-1",
                "sessions": [
                    {
                        "sessionId": "session-1",
                        "startMs": 0,
                        "endMs": 10_000,
                        "speakers": ["SPEAKER_01"],
                        "utterances": [
                            {
                                "startMs": 1_000,
                                "endMs": 2_000,
                                "speakerId": "SPEAKER_01",
                                "text": "You bastard.",
                            },
                            {
                                "startMs": 5_000,
                                "endMs": 6_000,
                                "speakerId": "SPEAKER_01",
                                "text": "Bastard.",
                            },
                        ],
                    }
                ],
            }
        )
    )

    profanity = result.sessions[0].profanity
    assert profanity.occurrence_count == 2
    assert profanity.exposure_level == "repeated"
    assert profanity.notification_recommended
