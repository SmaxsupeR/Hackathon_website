import { useLocalSearchParams, useRouter } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { getDb } from '../db';
import { createDictionary, deleteDictionary, DICTIONARY_COLORS, duplicateDictionary, getDictionary, updateDictionary } from '../db/repo';
import { useApp } from '../state/store';
import { Btn, Card, Field, Icon, Row, Screen } from '../ui/components';
import { useT } from '../ui/i18n';
import { space, useTheme } from '../ui/theme';

export default function DictionaryEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const touch = useApp((s) => s.touch);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(DICTIONARY_COLORS[0]);
  const [favorite, setFavorite] = useState(false);
  const [paused, setPaused] = useState(false);
  const [archived, setArchived] = useState(false);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    if (!id) return;
    getDb()
      .then((db) => getDictionary(db, id))
      .then((d) => {
        if (!d) return;
        setName(d.name);
        setDescription(d.description ?? '');
        setColor(d.color);
        setFavorite(!!d.is_favorite);
        setPaused(!!d.is_paused);
        setArchived(!!d.is_archived);
        setLoaded(true);
      });
  }, [id]);

  const fail = (e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));

  const save = async () => {
    try {
      const db = await getDb();
      if (id) {
        await updateDictionary(db, id, { name: name.trim(), description: description.trim() || null, color, is_favorite: favorite ? 1 : 0, is_paused: paused ? 1 : 0, is_archived: archived ? 1 : 0 });
        touch();
        router.back();
      } else {
        const newId = await createDictionary(db, { name, description, color });
        touch();
        router.replace(`/dictionary/${newId}`);
      }
    } catch (e) {
      fail(e);
    }
  };

  const copy = async () => {
    if (!id) return;
    try {
      await duplicateDictionary(await getDb(), id, tr('copyOf', { name: name.trim() }));
      touch();
      router.back();
    } catch (e) {
      fail(e);
    }
  };

  const remove = () => {
    if (!id) return;
    Alert.alert(tr('deleteDictionaryTitle'), tr('deleteDictionaryText', { name }), [
      { text: tr('cancel'), style: 'cancel' },
      {
        text: tr('delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteDictionary(await getDb(), id);
            touch();
            router.dismissTo('/dictionaries');
          } catch (e) {
            fail(e);
          }
        },
      },
    ]);
  };

  const toggle = (label: string, value: boolean, set: (v: boolean) => void) => (
    <Row style={styles.between}>
      <Text style={[styles.toggleLabel, { color: t.text }]}>{label}</Text>
      <Switch value={value} onValueChange={set} trackColor={{ true: t.primary }} accessibilityLabel={label} />
    </Row>
  );

  return (
    <Screen footer={<Btn title={id ? tr('save') : tr('create')} disabled={!loaded || name.trim() === ''} onPress={save} />}>
      <Stack.Screen options={{ title: id ? tr('editDictionary') : tr('newDictionary') }} />
      <Field label={tr('name')} value={name} onChangeText={setName} placeholder={tr('namePlaceholder')} autoFocus={!id} maxLength={80} returnKeyType="done" />
      <Field label={`${tr('description')} (${tr('optional')})`} value={description} onChangeText={setDescription} maxLength={200} />
      <Text style={[styles.label, { color: t.textDim }]}>{tr('color')}</Text>
      <View style={styles.colors}>
        {DICTIONARY_COLORS.map((c) => (
          <Pressable key={c} onPress={() => setColor(c)} accessibilityRole="button" accessibilityLabel={`${tr('color')} ${c}`} accessibilityState={{ selected: c === color }} style={[styles.swatch, { backgroundColor: c }]}>
            {c === color ? <Icon name="check" size={22} color="#FFFFFF" /> : null}
          </Pressable>
        ))}
      </View>
      {id ? (
        <>
          <Card>
            {toggle(tr('favorite'), favorite, setFavorite)}
            {toggle(tr('pauseDictionary'), paused, setPaused)}
            {toggle(tr('archived'), archived, setArchived)}
          </Card>
          <Btn kind="soft" icon="content-copy" title={tr('duplicate')} onPress={copy} />
          <Btn kind="danger" icon="trash-can-outline" title={tr('delete')} onPress={remove} />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between', minHeight: 44 },
  toggleLabel: { fontSize: 16, flex: 1 },
  label: { fontSize: 13, fontWeight: '600' },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  swatch: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
