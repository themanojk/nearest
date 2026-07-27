export interface SpeakerTurnInput {
  confidence?: number;
  endMs: number;
  speakerId: string;
  startMs: number;
  text: string;
}

export interface ConversationSessionInput {
  endMs: number;
  sessionIndex: number;
  speakers: string[];
  startMs: number;
  utterances: SpeakerTurnInput[];
}

export function buildConversationSessions(
  turns: SpeakerTurnInput[],
  maxGapMs = 120_000,
): ConversationSessionInput[] {
  const ordered = [...turns].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  );
  const sessions: ConversationSessionInput[] = [];

  for (const turn of ordered) {
    const current = sessions.at(-1);
    if (!current || turn.startMs - current.endMs > maxGapMs) {
      sessions.push({
        sessionIndex: sessions.length,
        startMs: turn.startMs,
        endMs: turn.endMs,
        speakers: [turn.speakerId],
        utterances: [turn],
      });
      continue;
    }
    current.endMs = Math.max(current.endMs, turn.endMs);
    current.utterances.push(turn);
    if (!current.speakers.includes(turn.speakerId)) {
      current.speakers.push(turn.speakerId);
    }
  }
  return sessions;
}
