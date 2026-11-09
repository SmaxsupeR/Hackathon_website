import { useLocalSearchParams, useRouter } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { serializeWordList } from '../../core/importer';
import { getDb } from '../../db';
import { exportRows, getDictionary, listEntries, type Entry } from '../../db/repo';
import { shareTextFile } from '../../services/files';
import { speakKorean } from '../../services/speech';
import { useApp } from '../../state/store';
import { Btn, Card, Empty, Field, IconBtn, Row } from '../../ui/components';
import { useT } from '../../ui/i18n';
import { space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

export default function DictionaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const showRomanization = useApp((s) => s.settings.showRomanization);
  const [search, setSearch] = useState('');
  const { data } = useLoad(async (db) => ({ dictionary: await getDictionary(db, id), entries: await listEntries(db, { dictionaryId: id, search }) }), [id, search]);

  const speak = async (text: string) => {
    if (!(await speakKorean(text))) Alert.alert(tr('noVoiceTitle'), tr('noVoiceText'));
  };

  const doExport = async (delimiter: ',' | '\t') => {
    try {
      const rows = await exportRows(await getDb(), id);
      const base = (data?.dictionary?.name ?? 'namu').replace(/[\\/:*?"<>|\s.]+/g, '_').slice(0, 40) || 'namu';
      const csv = delimiter === ',';
      await shareTextFile(`${base}.${csv ? 'csv' : 'tsv'}`, '﻿' + serializeWordList(rows, delimiter), csv ? 'text/csv' : 'text/tab-separated-values');
    } catch (e) {
      Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));
    }
  };

  const askExport = () =>
    Alert.alert(tr('exportTitle'), tr('exportText'), [
      { text: tr('cancel'), style: 'cancel' },
      { text: 'TSV', onPress: () => doExport('\t') },
      { text: 'CSV', onPress: () => doExport(',') },
    ]);

  const masteryColor = { new: t.textDim, learning: t.info, stable: t.primary };
  const masteryLabel = { new: tr('masteryNew'), learning: tr('masteryLearning'), stable: tr('masteryStable') };

  const renderItem = ({ item }: { item: Entry }) => (
    <Card style={styles.item} onPress={() => router.push(`/entry?dictionaryId=${id}&id=${item.id}`)}>
      <Row>
        <View style={styles.flex}>
          <Text style={[styles.korean, { color: t.text }]}>{item.korean}</Text>
          {showRomanization && (item.transcription || item.romanization) ? <Text style={[styles.roman, { color: t.textDim }]}>{item.transcription || item.romanization}</Text> : null}
          <Text style={[styles.meaning, { color: t.text }]}>{item.meanings.join('; ')}</Text>
          <Row style={styles.masteryRow}>
            <View style={[styles.dot, { backgroundColor: masteryColor[item.mastery] }]} />
            <Text style={[styles.mastery, { color: masteryColor[item.mastery] }]}>{masteryLabel[item.mastery]}</Text>
          </Row>
        </View>
        <IconBtn name="volume-high" label={tr('listen')} color={t.primary} onPress={() => speak(item.korean)} />
      </Row>
    </Card>
  );

  const entries = data?.entries ?? [];
  const empty = data && entries.length === 0;
  return (
    <View style={[styles.flex, { backgroundColor: t.bg }]}>
      <Stack.Screen
        options={{
          title: data?.dictionary?.name ?? '',
          headerRight: () => <IconBtn name="pencil-outline" label={tr('editDictionary')} onPress={() => router.push(`/dictionary-edit?id=${id}`)} />,
        }}
      />
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xl }]}
        ListHeaderComponent={
          <View style={styles.header}>
            <Row>
              <Btn style={styles.flex} title={tr('study')} icon="play" disabled={!data || (entries.length === 0 && search === '')} onPress={() => router.push(`/study?mode=cards&dicts=${id}`)} />
              <Btn style={styles.flex} kind="soft" title={tr('add')} icon="plus" onPress={() => router.push(`/entry?dictionaryId=${id}`)} />
            </Row>
            <Row>
              <Btn style={styles.flex} small kind="ghost" title={tr('import')} icon="tray-arrow-down" onPress={() => router.push(`/import?dictionaryId=${id}`)} />
              <Btn style={styles.flex} small kind="ghost" title={tr('export')} icon="tray-arrow-up" disabled={entries.length === 0} onPress={askExport} />
            </Row>
            {!empty || search !== '' ? <Field value={search} onChangeText={setSearch} placeholder={tr('search')} autoCorrect={false} returnKeyType="search" /> : null}
          </View>
        }
        ListEmptyComponent={empty ? search !== '' ? <Empty icon="magnify" title={tr('nothingFound')} /> : <Empty icon="text-box-plus-outline" title={tr('noWords')} text={tr('noWordsText')} /> : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  header: { gap: space.sm, marginBottom: space.xs },
  item: { paddingVertical: space.md },
  korean: { fontSize: 22, fontWeight: '600' },
  roman: { fontSize: 13 },
  meaning: { fontSize: 15, marginTop: 2 },
  masteryRow: { gap: 6, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  mastery: { fontSize: 12, fontWeight: '600' },
});
