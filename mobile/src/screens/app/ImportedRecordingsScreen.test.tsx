import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import ImportedRecordingsScreen from './ImportedRecordingsScreen';
import { recordingDebug } from '../../services/recordingDebug';

jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: any) =>
    React.createElement(View, null, ListHeaderComponent,
      data.length ? data.map((item: any, index: number) => React.createElement(View,
        { key: item.analysisId }, renderItem({ item, index }))) : ListEmptyComponent,
      ListFooterComponent) };
});
jest.mock('../../services/recordingDebug', () => ({ recordingDebug: {
  list: jest.fn(), playback: jest.fn(), play: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined), status: jest.fn(), deleteAudio: jest.fn(),
} }));
const item = { analysisId: 'analysis-1', childId: 'child-1', fileName: 'rec.wav',
  sizeBytes: 16044, contentType: 'audio/wav', status: 'COMPLETED', progress: 100,
  createdAt: '2026-10-16T00:00:00Z' };
let tree: Renderer.ReactTestRenderer;
const button = (label: string) => tree.root.findAll(node => node.props.accessibilityRole === 'button').find(node =>
  node.findAll(child => child.props.children === label).length > 0)!;

beforeEach(() => {
  jest.clearAllMocks();
  (recordingDebug.list as jest.Mock).mockResolvedValue({ items: [item], page: 1, total: 1 });
  (recordingDebug.playback as jest.Mock).mockResolvedValue({ url: 'https://storage/audio' });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });

test('shows imports, plays on the same page, and stops on exit', async () => {
  await act(async () => { tree = Renderer.create(<ImportedRecordingsScreen onBack={jest.fn()} />); });
  expect(tree.root.findAll(node => node.props.children === 'rec.wav').length).toBeGreaterThan(0);
  await act(async () => { button('Play').props.onPress(); });
  expect(recordingDebug.playback).toHaveBeenCalledWith('analysis-1');
  expect(recordingDebug.play).toHaveBeenCalledWith('https://storage/audio');
  await act(async () => { button('Stop').props.onPress(); });
  expect(recordingDebug.stop).toHaveBeenCalled();
});

test('requires confirmation and updates deleted audio without discarding details', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (recordingDebug.deleteAudio as jest.Mock).mockResolvedValue({ ...item, audioDeletedAt: '2026-10-16T01:00:00Z' });
  await act(async () => { tree = Renderer.create(<ImportedRecordingsScreen onBack={jest.fn()} />); });
  await act(async () => { button('Delete audio').props.onPress(); });
  expect(recordingDebug.deleteAudio).not.toHaveBeenCalled();
  await act(async () => { alert.mock.calls[0][2]?.find(action => action.text === 'Delete audio')?.onPress?.(); });
  expect(recordingDebug.deleteAudio).toHaveBeenCalledWith('analysis-1');
  expect(tree.root.findAll(node => Array.isArray(node.props.children) && node.props.children.includes('Audio deleted · ')).length).toBeGreaterThan(0);
  expect(button('Play').props.disabled).toBe(true);
  alert.mockRestore();
});

test('shows a recoverable listing error', async () => {
  (recordingDebug.list as jest.Mock).mockRejectedValue(new Error('Server unavailable'));
  await act(async () => { tree = Renderer.create(<ImportedRecordingsScreen onBack={jest.fn()} />); });
  expect(tree.root.findAll(node => node.props.children === 'Server unavailable').length).toBeGreaterThan(0);
  expect(button('Refresh').props.disabled).toBe(false);
});
