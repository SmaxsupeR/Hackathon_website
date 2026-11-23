import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import { romanize } from '../core/hangul';
import { getDb } from '../db';
import { createEntry, deleteEntry, duplicateKey, findDuplicates, getEntry, updateEntry, type EntryInput } from '../db/repo';
import { speakKorean } from '../services/speech';
import { useApp } from '../state/store';
import { Btn, Card, Field, IconBtn, Row, Screen, type InputRef } from '../ui/components';
import { useT } from '../ui/i18n';
import { useTheme } from '../ui/theme';

const EMPTY = { korean: '', translation: '', transcription: '', example: '', exampleTranslation: '', partOfSpeech: '', tags: '', notes: '' };

export default function EntryScreen() {
  const { dictionaryId, id } = useLocalSearchParams<{ dictionaryId: string; id?: string }>();
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const touch = useApp((s) => s.touch);
  const [form, setForm] = useState(EMPTY);
  const [more, setMore] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(!id);
  const original = useRef('');
  const koreanRef = useRef<InputRef>(null);
  const translationRef = useRef<InputRef>(null);
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!id) return;
    getDb()
      .then((db) => getEntry(db, id))
      .then((e) => {
        if (!e) return;
        original.current = duplicateKey(e.korean);
        setForm({
          korean: e.korean,
          translation: e.meanings.join('; '),
          transcription: e.transcription ?? '',
          example: e.example ?? '',
          exampleTranslation: e.exampleTranslation ?? '',
          partOfSpeech: e.part_of_speech ?? '',
          tags: e.tags.join(', '),
          notes: e.notes ?? '',
        });
        setMore(!!(e.transcription || e.example || e.part_of_speech || e.tags.length || e.notes));
        setLoaded(true);
      });
  }, [id]);

  // Warn about a duplicate while typing; saving is still allowed.
  useEffect(() => {
    const key = duplicateKey(form.korean);
    if (key === '' || key === original.current) {
      setDuplicate(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      getDb()
        .then((db) => findDuplicates(db, dictionaryId, [form.korean]))
        .then((found) => alive && setDuplicate(found.has(key)))
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [form.korean, dictionaryId]);

  const valid = loaded && form.korean.trim() !== '' && form.translation.split(';').some((s) => s.trim() !== '');
  const fail = (e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));

  const input = (): EntryInput => ({
    korean: form.korean,
    meanings: [form.translation],
    transcription: form.transcription,
    example: form.example,
    exampleTranslation: form.exampleTranslation,
    partOfSpeech: form.partOfSpeech,
    tags: form.tags.split(','),
    notes: form.notes,
  });

  const save = async (another: boolean) => {
    if (!valid) return;
    try {
      const db = await getDb();
      if (id) await updateEntry(db, id, input());
      else await createEntry(db, dictionaryId, input());
      touch();
      if (another) {
        setNotice(tr('saved', { word: form.korean.trim() }));
        setForm(EMPTY);
        koreanRef.current?.focus();
      } else router.back();
    } catch (e) {
      fail(e);
    }
  };

  const remove = () => {
    if (!id) return;
    Alert.alert(tr('deleteWordTitle'), tr('deleteWordText', { word: form.korean }), [
      { text: tr('cancel'), style: 'cancel' },
      {
        text: tr('delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteEntry(await getDb(), id);
            touch();
            router.back();
          } catch (e) {
            fail(e);
          }
        },
      },
    ]);
  };

  // The clipboard is read only when the user taps the button.
  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (text === '') Alert.alert(tr('paste'), tr('clipboardEmpty'));
    else set({ korean: text.slice(0, 200) });
  };

  const speak = async () => {
    if (form.korean.trim() !== '' && !(await speakKorean(form.korean))) Alert.alert(tr('noVoiceTitle'), tr('noVoiceText'));
  };

  const auto = form.korean.trim() !== '' ? romanize(form.korean.trim()) : '';

  return (
    <Screen
      footer={
        <>
          {!id ? <Btn title={tr('saveAndNext')} icon="plus" disabled={!valid} onPress={() => save(true)} /> : null}
          <Btn kind={id ? 'primary' : 'soft'} title={tr('save')} disabled={!valid} onPress={() => save(false)} />
        </>
      }>
      <Stack.Screen options={{ title: id ? tr('editWord') : tr('newWord'), headerRight: id ? () => <IconBtn name="trash-can-outline" label={tr('delete')} color={t.danger} onPress={remove} /> : undefined }} />
      {notice ? (
        <Card style={{ backgroundColor: t.primarySoft, borderColor: t.primarySoft }}>
          <Text style={{ color: t.primary, fontWeight: '600' }} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        </Card>
      ) : null}
      <Field
        ref={koreanRef}
        label={tr('korean')}
        value={form.korean}
        onChangeText={(korean) => set({ korean })}
        placeholder="나무"
        autoFocus={!id}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => translationRef.current?.focus()}
        maxLength={200}
        style={styles.korean}
        hint={auto && auto !== form.korean.trim() ? tr('romanizationAuto', { r: auto }) : undefined}
        right={
          <Row style={styles.tight}>
            <IconBtn name="content-paste" label={tr('paste')} color={t.textDim} onPress={paste} />
            <IconBtn name="volume-high" label={tr('listen')} color={t.primary} onPress={speak} />
          </Row>
        }
      />
      {duplicate ? <Text style={{ color: t.warn, fontWeight: '600' }}>{tr('duplicateWarning')}</Text> : null}
      <Field
        ref={translationRef}
        label={tr('translation')}
        value={form.translation}
        onChangeText={(translation) => set({ translation })}
        hint={tr('translationHint')}
        returnKeyType="done"
        maxLength={300}
      />
      <Btn kind="ghost" small icon={more ? 'chevron-up' : 'chevron-down'} title={more ? tr('less') : tr('more')} onPress={() => setMore((v) => !v)} />
      {more ? (
        <>
          <Field label={tr('transcription')} value={form.transcription} onChangeText={(transcription) => set({ transcription })} placeholder={auto} hint={tr('transcriptionHint')} autoCapitalize="none" maxLength={200} />
          <Field label={tr('example')} value={form.example} onChangeText={(example) => set({ example })} autoCorrect={false} maxLength={400} />
          <Field label={tr('exampleTranslation')} value={form.exampleTranslation} onChangeText={(exampleTranslation) => set({ exampleTranslation })} maxLength={400} />
          <Field label={tr('partOfSpeech')} value={form.partOfSpeech} onChangeText={(partOfSpeech) => set({ partOfSpeech })} maxLength={60} />
          <Field label={tr('tags')} value={form.tags} onChangeText={(tags) => set({ tags })} hint={tr('tagsHint')} autoCapitalize="none" maxLength={200} />
          <Field label={tr('notes')} value={form.notes} onChangeText={(notes) => set({ notes })} multiline maxLength={2000} />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  korean: { fontSize: 22 },
  tight: { gap: 0 },
});
