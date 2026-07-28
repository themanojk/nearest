import { compareFirmwareStrings } from './transport';

describe('recording catalog ordering', () => {
  it('matches firmware byte ordering for punctuation and case', () => {
    const firmwareOrderedNames = [
      'REC_1.wav',
      'rec-1.wav',
      'rec_00000008.wav',
      'rec_0119.wav',
      'rec_1.wav',
    ];

    for (let index = 1; index < firmwareOrderedNames.length; index += 1) {
      expect(
        compareFirmwareStrings(
          firmwareOrderedNames[index],
          firmwareOrderedNames[index - 1],
        ),
      ).toBeGreaterThan(0);
    }
  });

  it('still rejects a repeated cursor item', () => {
    expect(compareFirmwareStrings('rec_1.wav', 'rec_1.wav')).toBe(0);
  });
});
