import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import InsightAudio from './InsightAudio';
import { recordingDebug } from '../services/recordingDebug';
jest.mock('../services/recordingDebug', () => ({
  recordingDebug: {
    playback: jest.fn(async (id: string) => ({ url: `https://audio/${id}` })),
    play: jest.fn().mockResolvedValue(undefined),
    seek: jest.fn().mockResolvedValue(undefined),
    speed: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue({
      playing: true,
      loading: false,
      positionMs: 1000,
      durationMs: 10000,
    }),
  },
}));
test('plays the selected recording, stops the previous card, and releases on exit', async () => {
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <>
        <InsightAudio id="one" />
        <InsightAudio id="two" />
      </>,
    );
  });
  const buttons = () =>
    tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        node.props?.accessibilityRole === 'button' &&
        !node.props?.accessibilityLabel,
    );
  await act(async () => {
    buttons()[0].props.onPress();
  });
  expect(recordingDebug.play).toHaveBeenLastCalledWith('https://audio/one');
  await act(async () => {
    buttons()[1].props.onPress();
  });
  expect(recordingDebug.stop).toHaveBeenCalledTimes(1);
  expect(recordingDebug.play).toHaveBeenLastCalledWith('https://audio/two');
  await act(async () => tree.unmount());
  expect(recordingDebug.stop).toHaveBeenCalledTimes(2);
});

test('seeks with the progress bar and changes playback speed', async () => {
  jest.useFakeTimers();
  let tree!: Renderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = Renderer.create(<InsightAudio id="seek" />);
    });
    await act(async () => {
      tree.root
        .findAll(node => typeof node.props?.onPress === 'function')[0]
        .props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    const bar = tree.root.findAll(
      node => node.props?.accessibilityRole === 'adjustable',
    )[0];
    act(() => bar.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
    await act(async () => {
      bar.props.onResponderRelease({ nativeEvent: { locationX: 150 } });
    });
    expect(recordingDebug.seek).toHaveBeenLastCalledWith(7500);
    const speed = tree.root.findAll(
      node =>
        node.props?.accessibilityLabel === 'Playback speed 4x' &&
        typeof node.props.onPress === 'function',
    )[0];
    await act(async () => {
      await speed.props.onPress();
    });
    expect(recordingDebug.speed).toHaveBeenLastCalledWith(4);
  } finally {
    if (tree) await act(async () => tree.unmount());
    jest.useRealTimers();
  }
});

test('shows controls before playback metadata arrives and can cancel connecting', async () => {
  let resolveUrl!: (value: { url: string }) => void;
  (recordingDebug.playback as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveUrl = resolve;
      }),
  );
  let tree!: Renderer.ReactTestRenderer;
  const plays = (recordingDebug.play as jest.Mock).mock.calls.length;
  await act(async () => {
    tree = Renderer.create(<InsightAudio id="pending" durationMs={60000} />);
  });
  expect(
    tree.root.findAll(node => node.props?.accessibilityRole === 'adjustable')
      .length,
  ).toBeGreaterThan(0);
  const button = () =>
    tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        !node.props?.accessibilityLabel,
    )[0];
  await act(async () => {
    button().props.onPress();
  });
  await act(async () => {
    button().props.onPress();
  });
  await act(async () => {
    resolveUrl({ url: 'https://audio/cancelled' });
  });
  expect(recordingDebug.play).toHaveBeenCalledTimes(plays);
  await act(async () => tree.unmount());
});

test('plays only the selected moment and stops at its end', async () => {
  jest.useFakeTimers();
  const native = recordingDebug as typeof recordingDebug & { playClip: jest.Mock };
  native.playClip = jest.fn().mockResolvedValue(undefined);
  const fullPlays = (recordingDebug.play as jest.Mock).mock.calls.length;
  let tree!: Renderer.ReactTestRenderer;
  try {
    await act(async () => { tree = Renderer.create(<InsightAudio id="moment" clip={{ startMs: 2000, endMs: 4000 }} />); });
    await act(async () => { tree.root.findAll(n => typeof n.props?.onPress === 'function')[0].props.onPress(); });
    expect(native.playClip).toHaveBeenCalledWith('https://audio/moment', 2000, 4000);
    expect(recordingDebug.play).toHaveBeenCalledTimes(fullPlays);
    expect(tree.root.findAll(n => n.props?.accessibilityRole === 'adjustable')).toHaveLength(0);
    (recordingDebug.status as jest.Mock).mockResolvedValueOnce({ loading: false, playing: true, positionMs: 4000, durationMs: 10000 });
    const stops = (recordingDebug.stop as jest.Mock).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(recordingDebug.stop).toHaveBeenCalledTimes(stops + 1);
  } finally {
    if (tree) await act(async () => tree.unmount());
    jest.useRealTimers();
  }
});
