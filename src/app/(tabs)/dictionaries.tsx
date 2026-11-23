import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { listDictionaries, type DictionarySummary } from '../../db/repo';
import { Body, Btn, Card, Empty, Fab, Icon, IconBtn, Row, Screen, Title } from '../../ui/components';
import { useT } from '../../ui/i18n';
import { space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

export default function Dictionaries() {
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const [showArchive, setShowArchive] = useState(false);
  const { data } = useLoad(async (db) => {
    const now = Date.now();
    return { active: await listDictionaries(db, now), archived: await listDictionaries(db, now, true) };
  });

  const item = (d: DictionarySummary) => (
    <Card key={d.id} onPress={() => router.push(`/dictionary/${d.id}`)}>
      <Row>
        <View style={[styles.badge, { backgroundColor: d.color }]}>
          <Icon name={d.is_favorite ? 'star' : 'book-open-page-variant'} size={20} color="#FFFFFF" />
        </View>
        <View style={styles.flex}>
          <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>
            {d.name}
          </Text>
          <Body dim>
            {tr('words', { n: d.entry_count }) + (d.due_count > 0 ? ` · ${tr('due', { n: d.due_count })}` : '') + (d.is_paused ? ` · ${tr('paused')}` : '')}
          </Body>
        </View>
        <IconBtn name="pencil-outline" label={tr('editDictionary')} color={t.textDim} onPress={() => router.push(`/dictionary-edit?id=${d.id}`)} />
      </Row>
    </Card>
  );

  return (
    <View style={styles.flex}>
      <Screen top>
        <Title>{tr('tabDictionaries')}</Title>
        {data && data.active.length === 0 ? <Empty icon="book-plus-outline" title={tr('noDictionaries')} text={tr('noDictionariesText')} /> : null}
        {data?.active.map(item)}
        {data && data.archived.length > 0 ? (
          <Btn kind="ghost" small title={showArchive ? tr('hideArchive') : tr('showArchive', { n: data.archived.length })} onPress={() => setShowArchive((v) => !v)} />
        ) : null}
        {showArchive ? data?.archived.map(item) : null}
        <View style={styles.spacer} />
      </Screen>
      <Fab icon="plus" label={tr('createDictionary')} onPress={() => router.push('/dictionary-edit')} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  badge: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: space.xs },
  name: { fontSize: 17, fontWeight: '600' },
  spacer: { height: 72 },
});
