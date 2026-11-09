import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { getDb } from '../db';
import { exportBackup, parseBackup, restoreBackup, savePreference } from '../db/repo';
import { pickTextFile, shareTextFile, stamp } from '../services/files';
import { useApp, type Settings } from '../state/store';
import { Body, Btn, Card, Chip, IconBtn, Row, Screen, Section } from '../ui/components';
import { useT } from '../ui/i18n';
import { space, useTheme } from '../ui/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const tr = useT();
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const touch = useApp((s) => s.touch);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    patchSettings({ [key]: value } as Partial<Settings>);
    getDb()
      .then((db) => savePreference(db, key, JSON.stringify(value)))
      .catch((e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e)));
  };

  const backup = async () => {
    try {
      const data = await exportBackup(await getDb());
      await shareTextFile(`namu-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
    } catch (e) {
      Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async () => {
    let text: string;
    try {
      const file = await pickTextFile();
      if (!file) return;
      text = file.text;
    } catch {
      Alert.alert(tr('error'), tr('fileError'));
      return;
    }
    try {
      const n = await restoreBackup(await getDb(), parseBackup(text));
      touch();
      Alert.alert(tr('restore'), tr('restored', { n }));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      Alert.alert(tr('error'), code === 'not_json' || code === 'not_backup' ? tr('restoreErrorFormat') : code === 'unsupported_version' ? tr('restoreErrorVersion') : tr('restoreError'));
    }
  };

  const stepper = (label: string, key: 'newPerDay' | 'maxReviews', step: number, min: number, max: number) => (
    <Row style={styles.between}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <Row>
        <IconBtn name="minus-circle-outline" label={`${label} −`} color={t.primary} onPress={() => update(key, Math.max(min, settings[key] - step))} />
        <Text style={[styles.value, { color: t.text }]}>{settings[key]}</Text>
        <IconBtn name="plus-circle-outline" label={`${label} +`} color={t.primary} onPress={() => update(key, Math.min(max, settings[key] + step))} />
      </Row>
    </Row>
  );

  const toggle = (label: string, key: 'showRomanization' | 'strictSpacing' | 'detailedGrading', hint?: string) => (
    <View>
      <Row style={styles.between}>
        <Text style={[styles.label, { color: t.text }]}>{label}</Text>
        <Switch value={settings[key]} onValueChange={(v) => update(key, v)} trackColor={{ true: t.primary }} accessibilityLabel={label} />
      </Row>
      {hint ? <Body dim>{hint}</Body> : null}
    </View>
  );

  return (
    <Screen>
      <Section>{tr('language')}</Section>
      <View style={styles.chips}>
        <Chip label="Русский" active={settings.language === 'ru'} onPress={() => update('language', 'ru')} />
        <Chip label="English" active={settings.language === 'en'} onPress={() => update('language', 'en')} />
      </View>

      <Section>{tr('learning')}</Section>
      <Card>
        {stepper(tr('newPerDay'), 'newPerDay', 5, 0, 100)}
        {stepper(tr('maxReviews'), 'maxReviews', 10, 10, 500)}
        <Text style={[styles.label, { color: t.text }]}>{tr('retention')}</Text>
        <View style={styles.chips}>
          {[0.8, 0.85, 0.9, 0.95].map((r) => (
            <Chip key={r} label={`${Math.round(r * 100)}%`} active={settings.retention === r} onPress={() => update('retention', r)} />
          ))}
        </View>
        <Body dim>{tr('retentionHint')}</Body>
      </Card>
      <Card>
        {toggle(tr('showRomanization'), 'showRomanization', tr('showRomanizationHint'))}
        {toggle(tr('strictSpacing'), 'strictSpacing')}
        {toggle(tr('detailedGrading'), 'detailedGrading', tr('detailedGradingHint'))}
      </Card>

      <Section>{tr('data')}</Section>
      <Card>
        <Btn kind="soft" icon="content-save-outline" title={tr('backup')} onPress={backup} />
        <Body dim>{tr('backupHint')}</Body>
        <Btn kind="soft" icon="backup-restore" title={tr('restore')} onPress={restore} />
        <Body dim>{tr('restoreHint')}</Body>
      </Card>
      <Body dim>{tr('dataNote')}</Body>

      <Section>{tr('about')}</Section>
      <Body dim>{tr('aboutText')}</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between', minHeight: 44 },
  label: { fontSize: 16, flex: 1 },
  value: { fontSize: 17, fontWeight: '700', minWidth: 36, textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
