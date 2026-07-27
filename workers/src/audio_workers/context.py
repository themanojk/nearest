import re
import time
import unicodedata
from dataclasses import dataclass

from audio_workers.contracts import (
    ClassificationLabel,
    ContextClassificationRequest,
    ContextClassificationResponse,
    ContextSession,
    ContextSessionResult,
    ContextUtterance,
    ProfanityAssessment,
    ProfanityOccurrence,
    QualityAssessment,
    SafetySignal,
)

MODEL_NAME = "rules-context-en-hi/1.3.0"
CONTEXT_WINDOW_MS = 15_000

_NAVIGATION_PATTERN = re.compile(
    r"\b(?:\d+(?:\.\d+)?)\s*(?:km|kilomet(?:er|re)s?|meters?|miles?)\b"
    r"|\b(?:turn left|turn right|take the exit|recalculating|destination)\b",
    re.IGNORECASE,
)
_TOKEN_PATTERN = re.compile(r"[\w']+", re.UNICODE)


@dataclass(frozen=True)
class _SignalRule:
    signal_type: str
    severity: str
    confidence: float
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class _ProfanityRule:
    canonical_term: str
    severity: str
    confidence: float
    pattern: re.Pattern[str]


_SIGNAL_RULES = [
    _SignalRule(
        "imminent_danger",
        "high",
        0.94,
        re.compile(
            r"\b(?:i(?:'m| am) in danger|my life is in danger"
            r"|someone (?:is )?(?:following|chasing) me"
            r"|(?:he|she|they) (?:is|are|keeps?) following me"
            r"|call (?:the )?(?:police|cops|911|112|100))\b"
            r"|(?:खतरे|ख़तरे)\s+में"
            r"|(?:पीछा|पीशा)\s+कर"
            r"|कोई\s+(?:मेरा|मेरे)\s+(?:पीछा|पीशा)"
            r"|पुलिस\s+को\s+(?:फोन|कॉल)",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "self_harm",
        "high",
        0.95,
        re.compile(
            r"\b(?:i want to die|i don't want to live"
            r"|i(?:'m| am) going to kill myself|kill myself"
            r"|suicide|end my life|hurt myself)\b"
            r"|मैं\s+मरना\s+चाह"
            r"|जीना\s+नहीं\s+चाह"
            r"|खुदकुशी|आत्महत्या",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "threat",
        "high",
        0.9,
        re.compile(
            r"\b(?:i(?:'ll| will) (?:hit|hurt|kill|beat) you"
            r"|kill you|beat you up|hurt you|jaan se maar)\b"
            r"|जान\s+से\s+मार"
            r"|(?:मार\s+दूँगा|मार\s+दूंगा|मारूँगा|मारूंगा)",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "violence_disclosure",
        "high",
        0.9,
        re.compile(
            r"\b(?:(?:he|she|they) (?:hit|hits|hurt|hurts|beat|beats) me"
            r"|i was (?:hit|hurt|beaten)|someone (?:hit|hurt) me)\b"
            r"|(?:मुझे|मेरेको)\s+(?:मार|पीट)"
            r"|(?:मारता|मारती|पीटता|पीटती)\s+है",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "help_request",
        "medium",
        0.88,
        re.compile(
            r"\b(?:help me|please help|call for help"
            r"|call (?:my )?(?:mom|dad|parents?)"
            r"|bachao|madad karo)\b"
            r"|बचाओ|मदद\s+कर",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "distress",
        "medium",
        0.82,
        re.compile(
            r"\b(?:leave me alone|stop it|don't touch me|do not touch me"
            r"|i(?:'m| am) scared|mujhe dar lag raha)\b"
            r"|मुझे\s+डर\s+लग",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "secrecy_request",
        "high",
        0.86,
        re.compile(
            r"\b(?:don't|do not) tell (?:anyone|your (?:mom|dad|parents?))\b"
            r"|\bkeep (?:this|it) (?:a )?secret\b",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "insult",
        "medium",
        0.75,
        re.compile(
            r"\b(?:nobody likes you|you(?:'re| are) useless"
            r"|loser|idiot|stupid|shut up|bewakoof)\b",
            re.IGNORECASE,
        ),
    ),
    _SignalRule(
        "inappropriate_request",
        "high",
        0.9,
        re.compile(
            r"\b(?:take off your clothes|remove your clothes"
            r"|show me your private parts?|send me (?:a )?"
            r"(?:private |naked )?(?:photo|picture|video)"
            r"|don't wear clothes)\b"
            r"|कपड़े\s+(?:उतार|निकाल)"
            r"|अपनी\s+(?:फोटो|तस्वीर)\s+भेज",
            re.IGNORECASE,
        ),
    ),
]

_AMBIGUOUS_DANGER_PATTERN = re.compile(
    r"\b(?:(?:i think|think) )?i(?:'m| am) "
    r"(?:going to|gonna) die\b",
    re.IGNORECASE,
)
_DANGER_CONTEXT_PATTERN = re.compile(
    r"\b(?:help me|please help|save me|i(?:'m| am) scared"
    r"|i(?:'m| am) trapped|i(?:'m| am) hurt|i(?:'m| am) bleeding"
    r"|i can(?:not|'t) breathe|call (?:the )?(?:police|cops|911|112|100)"
    r"|someone (?:is )?(?:following|chasing) me"
    r"|(?:he|she|they) (?:is|are|keeps?) following me"
    r"|emergency)\b"
    r"|(?:बचाओ|मदद\s+कर|डर\s+लग|खतरे|ख़तरे|पीछा|पीशा"
    r"|पुलिस\s+को\s+(?:फोन|कॉल))",
    re.IGNORECASE,
)
_FIGURATIVE_CONTEXT_PATTERN = re.compile(
    r"\b(?:lol|lmao|haha+|joking|just kidding|kidding"
    r"|so funny|from laughing|video game|in the game"
    r"|this homework|this exam|of embarrassment"
    r"|figure of speech|not literally)\b",
    re.IGNORECASE,
)

_PROFANITY = {
    "mild": {
        "damn",
        "hell",
        "crap",
    },
    "moderate": {
        "bastard",
        "bitch",
        "asshole",
        "saala",
        "kameena",
    },
    "severe": {
        "fuck",
        "fucking",
        "motherfucker",
        "madarchod",
        "behenchod",
    },
}

_PROFANITY_ALIASES = [
    _ProfanityRule(
        "motherfucker",
        "severe",
        0.72,
        re.compile(
            r"\bmother[\s-]+(?:jude|fucker|f[^\s]{1,8})\b",
            re.IGNORECASE,
        ),
    ),
]

_INSTRUCTION_PATTERN = re.compile(
    r"\b(?:please|listen|sit down|stand up|you need to|you have to"
    r"|do your|finish your|dhyan se|baitho|suno)\b",
    re.IGNORECASE,
)


def classify_context(
    request: ContextClassificationRequest,
) -> ContextClassificationResponse:
    started_at = time.monotonic()
    results = [_classify_session(session) for session in request.sessions]
    return ContextClassificationResponse(
        analysis_id=request.analysis_id,
        model=MODEL_NAME,
        processing_seconds=round(time.monotonic() - started_at, 3),
        sessions=results,
    )


def _classify_session(session: ContextSession) -> ContextSessionResult:
    original_text = " ".join(
        utterance.text.strip()
        for utterance in session.utterances
        if utterance.text.strip()
    )
    quality = assess_quality(original_text)
    # High-precision safety evidence must survive a low aggregate quality
    # score. A noisy session can still contain one clear danger statement.
    signals = _detect_signals(session.utterances)
    profanity = _detect_profanity(session.utterances)
    signals.extend(_profanity_signals(profanity))
    conversation_type = _conversation_type(
        session,
        quality,
        signals,
    )
    return ContextSessionResult(
        session_id=session.session_id,
        quality=quality,
        conversation_type=conversation_type,
        profanity=profanity,
        safety_signals=signals,
    )


def assess_quality(text: str) -> QualityAssessment:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    tokens = _TOKEN_PATTERN.findall(normalized.casefold())
    flags: list[str] = []
    score = 1.0

    if len(tokens) < 3:
        flags.append("too_short")
        score -= 0.45
    if normalized:
        alphanumeric = sum(character.isalnum() for character in normalized)
        visible = sum(not character.isspace() for character in normalized)
        if visible and alphanumeric / visible < 0.55:
            flags.append("low_text_signal")
            score -= 0.35
    else:
        flags.append("empty")
        score = 0

    repeated_ratio = _repeated_token_ratio(tokens)
    if repeated_ratio >= 0.45:
        flags.append("repetitive")
        score -= 0.4
    if _NAVIGATION_PATTERN.search(normalized):
        flags.append("navigation_or_device_audio")
        score -= 0.6

    cleaned_tokens: list[str] = []
    for token in normalized.split():
        if (
            len(cleaned_tokens) >= 2
            and token.casefold() == cleaned_tokens[-1].casefold()
            and token.casefold() == cleaned_tokens[-2].casefold()
        ):
            continue
        cleaned_tokens.append(token)
    cleaned_text = " ".join(cleaned_tokens)
    score = max(0.0, min(1.0, score))
    return QualityAssessment(
        score=round(score, 3),
        usable=score >= 0.45,
        flags=flags,
        cleaned_text=cleaned_text,
    )


def _repeated_token_ratio(tokens: list[str]) -> float:
    if len(tokens) < 2:
        return 0.0
    repeated = sum(
        left == right
        for left, right in zip(tokens, tokens[1:], strict=False)
    )
    return repeated / (len(tokens) - 1)


def _detect_signals(
    utterances: list[ContextUtterance],
) -> list[SafetySignal]:
    signals: list[SafetySignal] = []
    seen: set[tuple[str, int, str]] = set()
    for utterance in utterances:
        for rule in _SIGNAL_RULES:
            match = rule.pattern.search(utterance.text)
            if not match:
                continue
            key = (
                rule.signal_type,
                utterance.start_ms,
                match.group(0).casefold(),
            )
            if key in seen:
                continue
            seen.add(key)
            signals.append(
                SafetySignal(
                    signal_type=rule.signal_type,
                    severity=rule.severity,
                    confidence=rule.confidence,
                    start_ms=utterance.start_ms,
                    end_ms=utterance.end_ms,
                    speaker_id=utterance.speaker_id,
                    evidence=_evidence_excerpt(utterance.text, match),
                )
            )
    signals.extend(_detect_contextual_danger(utterances))
    return signals


def _detect_contextual_danger(
    utterances: list[ContextUtterance],
) -> list[SafetySignal]:
    signals: list[SafetySignal] = []
    for utterance in utterances:
        match = _AMBIGUOUS_DANGER_PATTERN.search(utterance.text)
        if not match:
            continue
        context = " ".join(
            candidate.text
            for candidate in utterances
            if (
                candidate.start_ms <= utterance.end_ms + CONTEXT_WINDOW_MS
                and candidate.end_ms >= utterance.start_ms - CONTEXT_WINDOW_MS
            )
        )
        if (
            _FIGURATIVE_CONTEXT_PATTERN.search(context)
            or not _DANGER_CONTEXT_PATTERN.search(context)
        ):
            continue
        signals.append(
            SafetySignal(
                signal_type="imminent_danger",
                severity="medium",
                confidence=0.82,
                start_ms=utterance.start_ms,
                end_ms=utterance.end_ms,
                speaker_id=utterance.speaker_id,
                evidence=_evidence_excerpt(utterance.text, match),
            )
        )
    return signals


def _evidence_excerpt(text: str, match: re.Match[str]) -> str:
    start = max(0, match.start() - 55)
    end = min(len(text), match.end() + 55)
    return text[start:end].strip()[:160]


def _detect_profanity(
    utterances: list[ContextUtterance],
) -> ProfanityAssessment:
    rules = [
        _ProfanityRule(
            canonical_term=term,
            severity=severity,
            confidence=0.94,
            pattern=re.compile(
                rf"(?<!\w){re.escape(term)}(?!\w)",
                re.IGNORECASE,
            ),
        )
        for severity, terms in _PROFANITY.items()
        for term in terms
    ]
    rules.extend(_PROFANITY_ALIASES)
    occurrences: list[ProfanityOccurrence] = []
    seen: set[tuple[int, int, str]] = set()
    for utterance in utterances:
        for rule in rules:
            for match in rule.pattern.finditer(utterance.text):
                key = (
                    utterance.start_ms,
                    match.start(),
                    rule.canonical_term,
                )
                if key in seen:
                    continue
                seen.add(key)
                utterance_confidence = utterance.confidence or 1.0
                occurrences.append(
                    ProfanityOccurrence(
                        canonical_term=rule.canonical_term,
                        confidence=round(
                            min(rule.confidence, utterance_confidence),
                            3,
                        ),
                        start_ms=utterance.start_ms,
                        end_ms=utterance.end_ms,
                        speaker_id=utterance.speaker_id,
                        term=match.group(0),
                        severity=rule.severity,
                        evidence=_evidence_excerpt(
                            utterance.text,
                            match,
                        ),
                    )
                )
    matched: dict[str, list[str]] = {
        severity: sorted(
            {
                occurrence.canonical_term
                for occurrence in occurrences
                if occurrence.severity == severity
            }
        )
        for severity in _PROFANITY
    }
    severity = next(
        (
            item
            for item in ("severe", "moderate", "mild")
            if matched[item]
        ),
        "none",
    )
    terms = sorted(
        term
        for severity_terms in matched.values()
        for term in severity_terms
    )
    severe_count = sum(
        occurrence.severity == "severe" for occurrence in occurrences
    )
    moderate_count = sum(
        occurrence.severity == "moderate" for occurrence in occurrences
    )
    occurrence_count = len(occurrences)
    notification_recommended = bool(
        severe_count >= 1
        or moderate_count >= 2
        or occurrence_count >= 3
    )
    if occurrence_count >= 5:
        exposure_level = "high_density"
    elif occurrence_count >= 3 or moderate_count >= 2:
        exposure_level = "repeated"
    elif occurrence_count:
        exposure_level = "isolated"
    else:
        exposure_level = "none"
    notification_reason = None
    if severe_count:
        notification_reason = (
            f"{severe_count} severe curse-word occurrence"
            f"{'s' if severe_count != 1 else ''} detected"
        )
    elif notification_recommended:
        notification_reason = (
            f"{occurrence_count} curse-word occurrences detected"
        )
    return ProfanityAssessment(
        severity=severity,
        terms=terms,
        occurrences=occurrences,
        occurrence_count=occurrence_count,
        exposure_level=exposure_level,
        notification_recommended=notification_recommended,
        notification_reason=notification_reason,
    )


def _profanity_signals(
    profanity: ProfanityAssessment,
) -> list[SafetySignal]:
    if not profanity.notification_recommended or not profanity.occurrences:
        return []
    first = min(
        profanity.occurrences,
        key=lambda occurrence: occurrence.start_ms,
    )
    last = max(
        profanity.occurrences,
        key=lambda occurrence: occurrence.end_ms,
    )
    return [
        SafetySignal(
            signal_type="profanity_exposure",
            severity="medium",
            confidence=max(
                occurrence.confidence
                for occurrence in profanity.occurrences
            ),
            start_ms=first.start_ms,
            end_ms=last.end_ms,
            speaker_id=first.speaker_id,
            evidence=(
                profanity.notification_reason
                or "Repeated curse-word exposure detected"
            ),
        )
    ]


def _conversation_type(
    session: ContextSession,
    quality: QualityAssessment,
    signals: list[SafetySignal],
) -> ClassificationLabel:
    if not quality.usable and not signals:
        return ClassificationLabel(label="unknown", confidence=0.9)
    signal_types = {signal.signal_type for signal in signals}
    if "self_harm" in signal_types:
        return ClassificationLabel(label="self_harm", confidence=0.95)
    if "imminent_danger" in signal_types:
        confidence = max(
            signal.confidence
            for signal in signals
            if signal.signal_type == "imminent_danger"
        )
        return ClassificationLabel(
            label="imminent_danger",
            confidence=confidence,
        )
    if signal_types & {
        "threat",
        "violence_disclosure",
        "inappropriate_request",
    }:
        return ClassificationLabel(label="threat", confidence=0.9)
    if "help_request" in signal_types:
        return ClassificationLabel(label="help_request", confidence=0.86)
    if "insult" in signal_types:
        return ClassificationLabel(label="bullying_or_insult", confidence=0.74)
    if "profanity_exposure" in signal_types:
        return ClassificationLabel(
            label="harmful_language_exposure",
            confidence=0.8,
        )
    if "distress" in signal_types:
        return ClassificationLabel(label="argument_or_distress", confidence=0.76)
    if _INSTRUCTION_PATTERN.search(quality.cleaned_text):
        return ClassificationLabel(label="instruction", confidence=0.68)
    if "navigation_or_device_audio" in quality.flags:
        return ClassificationLabel(label="unknown", confidence=0.85)
    if len(session.speakers) >= 2:
        return ClassificationLabel(label="casual", confidence=0.55)
    return ClassificationLabel(label="unknown", confidence=0.5)
