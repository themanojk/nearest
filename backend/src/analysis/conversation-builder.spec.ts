import { buildConversationSessions } from './conversation-builder';

describe('buildConversationSessions', () => {
  it('groups contiguous speaker turns and splits long interruptions', () => {
    const sessions = buildConversationSessions(
      [
        {
          startMs: 1_000,
          endMs: 2_000,
          speakerId: 'SPEAKER_01',
          text: 'Hello',
        },
        {
          startMs: 2_400,
          endMs: 3_100,
          speakerId: 'SPEAKER_02',
          text: 'Hi',
        },
        {
          startMs: 130_000,
          endMs: 131_000,
          speakerId: 'SPEAKER_01',
          text: 'Later',
        },
      ],
      120_000,
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      startMs: 1_000,
      endMs: 3_100,
      speakers: ['SPEAKER_01', 'SPEAKER_02'],
    });
    expect(sessions[0].utterances).toHaveLength(2);
    expect(sessions[1]).toMatchObject({
      sessionIndex: 1,
      startMs: 130_000,
      endMs: 131_000,
    });
  });
});
