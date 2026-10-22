import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Pressable, View } from 'react-native';
import Txt from '../../components/Txt';
import Glass from '../../components/Glass';
import { colors, radii, spacing } from '../../theme/theme';
import {
  recordingDebug,
  type AudioStatus,
  type ImportedRecording,
} from '../../services/recordingDebug';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(
    2,
    '0',
  )}`;

function Action({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 12,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Txt
        size={13}
        weight="semibold"
        color={destructive ? colors.destructive : colors.primaryGreenDark}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

export default function ImportedRecordingsScreen({
  onBack,
}: {
  onBack: () => void;
}) {
  const [items, setItems] = useState<ImportedRecording[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const generation = useRef(0);
  const listGeneration = useRef(0);

  const load = useCallback(async (next: number) => {
    const request = ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const result = await recordingDebug.list(next);
      if (request !== listGeneration.current) return;
      setItems(old =>
        next === 1
          ? result.items
          : [
              ...old,
              ...result.items.filter(
                item =>
                  !old.some(
                    existing => existing.analysisId === item.analysisId,
                  ),
              ),
            ],
      );
      setTotal(result.total);
      setPage(result.page);
    } catch (err) {
      if (request === listGeneration.current) setError(message(err));
    } finally {
      if (request === listGeneration.current) setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    generation.current++;
    setActive(null);
    setAudio(null);
    try {
      await recordingDebug.stop();
    } catch {
      /* Native player may not be installed yet. */
    }
  }, []);

  useEffect(() => {
    const requests = listGeneration;
    void load(1);
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void stop();
    });
    return () => {
      requests.current++;
      void stop();
      subscription.remove();
    };
  }, [load, stop]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const timer = setInterval(() => {
      recordingDebug
        .status()
        .then(status => {
          if (disposed) return;
          setAudio(status);
          if (status.error) {
            setError(status.error);
            void stop();
          }
        })
        .catch(err => {
          if (!disposed) {
            setError(message(err));
            void stop();
          }
        });
    }, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, stop]);

  const play = async (item: ImportedRecording) => {
    await stop();
    const request = ++generation.current;
    setError('');
    setActive(item.analysisId);
    setAudio({ loading: true, playing: false, positionMs: 0, durationMs: 0 });
    try {
      const result = await recordingDebug.playback(item.analysisId);
      if (request !== generation.current) return;
      await recordingDebug.play(result.url);
    } catch (err) {
      if (request === generation.current) {
        setError(message(err));
        void stop();
      }
    }
  };

  const remove = (item: ImportedRecording) =>
    Alert.alert(
      'Delete uploaded audio?',
      `${item.fileName}\n\nPermanently removes the server audio. Diagnostic details and reports stay. This does not delete files still on the wearable.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete audio',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setDeleting(item.analysisId);
              setError('');
              try {
                await stop();
                const updated = await recordingDebug.deleteAudio(
                  item.analysisId,
                );
                setItems(old =>
                  old.map(row =>
                    row.analysisId === item.analysisId ? updated : row,
                  ),
                );
              } catch (err) {
                setError(message(err));
              } finally {
                setDeleting(null);
              }
            })();
          },
        },
      ],
    );

  return (
    <FlatList
      data={items}
      keyExtractor={item => item.analysisId}
      contentContainerStyle={{
        padding: spacing.gutter,
        gap: 12,
        paddingBottom: 32,
      }}
      refreshing={loading}
      onRefresh={() => {
        void load(1);
      }}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Action label="‹ Back to profile" onPress={onBack} />
          <Txt weight="serif" size={22}>
            Imported recordings
          </Txt>
          <Txt size={12} color={colors.muted}>
            Temporary debug page · {items.length} of {total} imports
          </Txt>
          <Txt size={12} color={colors.body}>
            Server imports across all children, including pending and failed
            uploads. Internet is required. Delete audio keeps diagnostic
            details; active processing must finish first.
          </Txt>
          {!!error && (
            <Txt size={13} color={colors.destructive}>
              {error}
            </Txt>
          )}
          <Action
            label={loading ? 'Loading…' : 'Refresh'}
            disabled={loading}
            onPress={() => {
              void load(1);
            }}
          />
        </View>
      }
      ListEmptyComponent={
        !loading ? <Txt size={14}>No imported recordings found.</Txt> : null
      }
      ListFooterComponent={
        items.length < total ? (
          <Action
            label="Load more recordings"
            disabled={loading}
            onPress={() => {
              void load(page + 1);
            }}
          />
        ) : null
      }
      renderItem={({ item }) => {
        const selected = active === item.analysisId;
        const canPlay =
          !item.audioDeletedAt && item.status !== 'AWAITING_UPLOAD';
        const stagesBusy = Object.entries(item).some(
          ([key, value]) =>
            key.endsWith('Stage') &&
            value &&
            typeof value === 'object' &&
            'status' in value &&
            ['QUEUEING', 'QUEUED', 'RUNNING'].includes(String(value.status)),
        );
        const canDelete =
          !item.audioDeletedAt &&
          ['COMPLETED', 'FAILED'].includes(item.status) &&
          !stagesBusy;
        return (
          <Glass
            variant="soft"
            radius={radii.cardSm}
            style={{ padding: 14, gap: 7 }}
          >
            <Txt weight="semibold" size={14}>
              {item.fileName}
            </Txt>
            <Txt size={12} color={colors.body}>
              {item.audioDeletedAt ? 'Audio deleted · ' : ''}
              {item.status} · {item.progress}%
            </Txt>
            <Txt size={12} color={colors.muted}>
              {(item.sizeBytes / 1024).toFixed(1)} KiB · {item.contentType}
              {item.mediaMetadata
                ? ` · ${time(item.mediaMetadata.durationMs)}`
                : ''}
            </Txt>
            <Txt size={11} color={colors.muted}>
              Imported: {new Date(item.createdAt).toLocaleString()}
            </Txt>
            <Txt size={11} selectable>
              Analysis: {item.analysisId}
              {'\n'}Child: {item.childId}
            </Txt>
            {selected && audio && (
              <Txt size={12}>
                {audio.loading
                  ? 'Loading audio…'
                  : `${audio.playing ? 'Playing' : 'Finished'} · ${time(
                      audio.positionMs,
                    )} / ${time(audio.durationMs)}`}
              </Txt>
            )}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              <Action
                label={selected ? 'Stop' : 'Play'}
                disabled={!canPlay || deleting !== null}
                onPress={() => {
                  void (selected ? stop() : play(item));
                }}
              />
              <Action
                label={
                  expanded === item.analysisId ? 'Hide details' : 'All details'
                }
                onPress={() =>
                  setExpanded(
                    expanded === item.analysisId ? null : item.analysisId,
                  )
                }
              />
              <Action
                label={
                  deleting === item.analysisId ? 'Deleting…' : 'Delete audio'
                }
                destructive
                disabled={!canDelete || deleting !== null}
                onPress={() => remove(item)}
              />
            </View>
            {expanded === item.analysisId && (
              <Txt size={11} selectable color={colors.body}>
                {JSON.stringify(item, null, 2)}
              </Txt>
            )}
          </Glass>
        );
      }}
    />
  );
}
