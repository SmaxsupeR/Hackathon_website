import { useLocalSearchParams, useRouter } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { getDb } from '../db';
import { getDifficultWords, listDictionaries, listEntries, savePreference, type Entry } from '../db/repo';
import { useApp } from '../state/store';
import { Body, Btn, Card, Chip, Icon, IconBtn, Row, Screen, Section } from '../ui/components';
import { useT } from '../ui/i18n';
import { radius, space, useTheme } from '../ui/theme';
import { useLoad } from '../ui/useLoad';

type Source = 'dicts' | 'entries' | 'hard';
type Dirs = 'both' | 'ko_ru' | 'ru_ko';
type Method = 'keyboard' | 'self_grade' | 'choice';

const COUNTS = [10, 20, 50];

export default function FreePractice() {
  const params = useLocalSearchParams<{ source?: string }>();
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const attempts = useApp((s) => s.settings.practiceAttempts);
  const patchSettings = useApp((s) => s.patchSettings);
  const [source, setSource] = useState<Source>(params.source === 'hard' ? 'hard' : 'dicts');
  const [dicts, setDicts] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickFrom, setPickFrom] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Dirs>('ko_ru');
  const [method, setMethod] = useState<Method>('keyboard');
  const [limit, setLimit] = useState(20);
  const [countAsReview, setCountAsReview] = useState(false);

  const { data } = useLoad(async (db) => {
    const now = Date.now();
    const dictionaries = await listDictionaries(db, now);
    const hard = await getDifficultWords(db, { dictionaryIds: dicts, limit: 200, now });
    const from = pickFrom ?? dictionaries[0]?.id ?? null;
    const words: Entry[] = from ? await listEntries(db, { dictionaryId: from }) : [];
    return { dictionaries, hard, words, from };
  }, [dicts.join(','), pickFrom]);

  const setAttempts = (n: number) => {
    const v = Math.max(1, Math.min(10, n));
    patchSettings({ practiceAttempts: v });
    getDb().then((db) => savePreference(db, 'practiceAttempts', JSON.stringify(v))).catch(() => {});
  };

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const available = source === 'entries' ? picked.length : source === 'hard' ? (data?.hard.length ?? 0) : 1;
  const start = () => {
    const q = new URLSearchParams({
      kind: 'free',
      source,
      dicts: dicts.join(','),
      ids: picked.join(','),
      dirs,
      method,
      limit: String(source === 'entries' ? picked.length : limit),
      fails: String(attempts),
      count: countAsReview && method !== 'choice' ? '1' : '0',
    });
    router.push(`/study?${q.toString()}`);
  };

  const option = <T extends string>(value: T, current: T, set: (v: T) => void, title: string, hint: string) => {
    const active = value === current;
    return (
      <Pressable
        key={value}
        onPress={() => set(value)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={hint}
        accessibilityState={{ selected: active }}
        style={[styles.option, { backgroundColor: active ? t.primarySoft : t.surface, borderColor: active ? t.primary : t.border }]}>
        <View style={styles.flex}>
          <Text style={[styles.optionTitle, { color: t.text }]}>{title}</Text>
          <Text style={[styles.optionHint, { color: t.textDim }]}>{hint}</Text>
        </View>
        {active ? <Icon name="check-circle" color={t.primary} /> : null}
      </Pressable>
    );
  };

  return (
    <Screen footer={<Btn title={tr('start')} icon="play" disabled={available === 0} onPress={start} />}>
      <Stack.Screen options={{ title: tr('freeTitle') }} />
      <Body dim>{tr('freeHint')}</Body>

      <Section>{tr('freeSource')}</Section>
      <View style={styles.chips}>
        <Chip label={tr('sourceDicts')} active={source === 'dicts'} onPress={() => setSource('dicts')} />
        <Chip label={tr('sourceWords')} active={source === 'entries'} onPress={() => setSource('entries')} />
        <Chip label={tr('sourceHard')} active={source === 'hard'} onPress={() => setSource('hard')} />
      </View>

      {source !== 'entries' ? (
        <View style={styles.chips}>
          <Chip label={tr('allDictionaries')} active={dicts.length === 0} onPress={() => setDicts([])} />
          {data?.dictionaries.map((d) => (
            <Chip key={d.id} label={d.name} active={dicts.includes(d.id)} onPress={() => setDicts((cur) => toggle(cur, d.id))} />
          ))}
        </View>
      ) : null}

      {source === 'hard' ? (
        <Card>
          {data && data.hard.length === 0 ? <Body dim>{tr('hardNone')}</Body> : null}
          {data && data.hard.length > 0 ? <Text style={[styles.strong, { color: t.text }]}>{tr('hardCount', { n: data.hard.length })}</Text> : null}
          {data?.hard.slice(0, 8).map((w) => (
            <Row key={w.id} style={styles.between}>
              <Text style={[styles.word, { color: t.text }]}>{w.korean}</Text>
              <Text style={{ color: t.textDim, flexShrink: 1 }} numberOfLines={1}>
                {w.meaning ?? ''}
              </Text>
            </Row>
          ))}
        </Card>
      ) : null}

      {source === 'entries' ? (
        <>
          <View style={styles.chips}>
            {data?.dictionaries.map((d) => (
              <Chip key={d.id} label={d.name} active={data.from === d.id} onPress={() => setPickFrom(d.id)} />
            ))}
          </View>
          <Body dim>{tr('pickedCount', { n: picked.length })}</Body>
          <Card style={styles.list}>
            {data?.words.map((w) => {
              const on = picked.includes(w.id);
              return (
                <Pressable key={w.id} onPress={() => setPicked((cur) => toggle(cur, w.id))} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={styles.wordRow}>
                  <Icon name={on ? 'checkbox-marked' : 'checkbox-blank-outline'} color={on ? t.primary : t.textDim} />
                  <Text style={[styles.word, { color: t.text }]}>{w.korean}</Text>
                  <Text style={[styles.flex, { color: t.textDim }]} numberOfLines={1}>
                    {w.meanings.join('; ')}
                  </Text>
                </Pressable>
              );
            })}
          </Card>
        </>
      ) : (
        <>
          <Section>{tr('freeCount')}</Section>
          <View style={styles.chips}>
            {COUNTS.map((n) => (
              <Chip key={n} label={String(n)} active={limit === n} onPress={() => setLimit(n)} />
            ))}
          </View>
        </>
      )}

      <Section>{tr('freeDirection')}</Section>
      <View style={styles.chips}>
        <Chip label={tr('dirKoRu')} active={dirs === 'ko_ru'} onPress={() => setDirs('ko_ru')} />
        <Chip label={tr('dirRuKo')} active={dirs === 'ru_ko'} onPress={() => setDirs('ru_ko')} />
        <Chip label={tr('dirBoth')} active={dirs === 'both'} onPress={() => setDirs('both')} />
      </View>

      <Section>{tr('answerMethod')}</Section>
      {option('keyboard', method, setMethod, tr('methodKeyboard'), tr('methodKeyboardHint'))}
      {option('self_grade', method, setMethod, tr('methodSelf'), tr('methodSelfHint'))}
      {option('choice', method, setMethod, tr('methodChoice'), tr('methodChoiceHint'))}

      <Section>{tr('freeAttempts')}</Section>
      <Card>
        <Row style={styles.between}>
          <IconBtn name="minus-circle-outline" label={`${tr('freeAttempts')} −`} color={t.primary} onPress={() => setAttempts(attempts - 1)} />
          <Text style={[styles.value, { color: t.text }]}>{attempts}</Text>
          <IconBtn name="plus-circle-outline" label={`${tr('freeAttempts')} +`} color={t.primary} onPress={() => setAttempts(attempts + 1)} />
        </Row>
        <Body dim>{tr('freeAttemptsHint')}</Body>
      </Card>

      <Card>
        <Row style={styles.between}>
          <Text style={[styles.flex, { color: method === 'choice' ? t.textDim : t.text, fontSize: 16 }]}>{tr('countAsReview')}</Text>
          <Switch value={countAsReview && method !== 'choice'} disabled={method === 'choice'} onValueChange={setCountAsReview} trackColor={{ true: t.primary }} accessibilityLabel={tr('countAsReview')} />
        </Row>
        <Body dim>{tr('countAsReviewHint')}</Body>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, minHeight: 60 },
  optionTitle: { fontSize: 16, fontWeight: '600' },
  optionHint: { fontSize: 13 },
  strong: { fontSize: 16, fontWeight: '700' },
  between: { justifyContent: 'space-between' },
  word: { fontSize: 18, fontWeight: '600' },
  list: { paddingVertical: space.xs, gap: 0 },
  wordRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 },
  value: { fontSize: 20, fontWeight: '700' },
});
