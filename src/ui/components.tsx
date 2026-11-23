import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps, ComponentRef, ReactNode, Ref } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useTheme } from './theme';

export type InputRef = ComponentRef<typeof TextInput>;
export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const t = useTheme();
  return <MaterialCommunityIcons name={name} size={size} color={color ?? t.text} />;
}

export function Screen({ children, scroll = true, footer, top = false }: { children: ReactNode; scroll?: boolean; footer?: ReactNode; top?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const padTop = top ? insets.top + space.lg : space.lg;
  return (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: t.bg }]} behavior="padding">
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, { paddingTop: padTop, paddingBottom: footer ? space.lg : insets.bottom + space.xl }]}
          keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, styles.content, { paddingTop: padTop }]}>{children}</View>
      )}
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + space.md, backgroundColor: t.bg, borderTopColor: t.border }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

export function Card({ children, style, onPress, onLongPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; onLongPress?: () => void }) {
  const t = useTheme();
  const base = [styles.card, { backgroundColor: t.surface, borderColor: t.border }, style];
  if (!onPress && !onLongPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} android_ripple={{ color: t.surfaceAlt }} style={base} accessibilityRole="button">
      {children}
    </Pressable>
  );
}

type BtnKind = 'primary' | 'soft' | 'ghost' | 'danger';

export function Btn({
  title,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  small,
  style,
  hint,
}: {
  title: string;
  onPress: () => void;
  kind?: BtnKind;
  icon?: IconName;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  hint?: string;
}) {
  const t = useTheme();
  const bg = { primary: t.primary, soft: t.primarySoft, ghost: 'transparent', danger: t.dangerSoft }[kind];
  const fg = { primary: t.onPrimary, soft: t.primary, ghost: t.primary, danger: t.danger }[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      android_ripple={{ color: '#00000022' }}
      style={[styles.btn, small && styles.btnSmall, { backgroundColor: bg, opacity: disabled ? 0.45 : 1 }, style]}>
      {icon ? <MaterialCommunityIcons name={icon} size={small ? 18 : 20} color={fg} /> : null}
      <View style={styles.center}>
        <Text style={[styles.btnText, small && styles.btnTextSmall, { color: fg }]} numberOfLines={1}>
          {title}
        </Text>
        {hint ? <Text style={[styles.btnHint, { color: fg }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function IconBtn({ name, onPress, label, color, size = 24 }: { name: IconName; onPress: () => void; label: string; color?: string; size?: number }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} android_ripple={{ color: t.surfaceAlt, borderless: true, radius: 22 }} style={styles.iconBtn}>
      <MaterialCommunityIcons name={name} size={size} color={color ?? t.text} />
    </Pressable>
  );
}

export function Field({ label, hint, right, style, ref, ...input }: TextInputProps & { label?: string; hint?: string; right?: ReactNode; ref?: Ref<InputRef> }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.label, { color: t.textDim }]}>{label}</Text> : null}
      <View style={[styles.inputRow, { backgroundColor: t.surface, borderColor: t.border }]}>
        <TextInput
          ref={ref}
          placeholderTextColor={t.textDim + '99'}
          accessibilityLabel={label}
          {...input}
          style={[styles.input, { color: t.text }, input.multiline && styles.inputMultiline, style]}
        />
        {right}
      </View>
      {hint ? <Text style={[styles.hint, { color: t.textDim }]}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({ label, active, onPress, icon }: { label: string; active?: boolean; onPress?: () => void; icon?: IconName }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[styles.chip, { backgroundColor: active ? t.primary : t.surface, borderColor: active ? t.primary : t.border }]}>
      {icon ? <MaterialCommunityIcons name={icon} size={16} color={active ? t.onPrimary : t.textDim} /> : null}
      <Text style={[styles.chipText, { color: active ? t.onPrimary : t.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Section({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text style={[styles.section, { color: t.textDim }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, dim, style }: { children: ReactNode; dim?: boolean; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: dim ? t.textDim : t.text }, style]}>{children}</Text>;
}

export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: t.primarySoft }]}>
        <MaterialCommunityIcons name={icon} size={36} color={t.primary} />
      </View>
      <Text style={[styles.emptyTitle, { color: t.text }]}>{title}</Text>
      {text ? <Text style={[styles.emptyText, { color: t.textDim }]}>{text}</Text> : null}
      {action}
    </View>
  );
}

export function Bar({ value, color }: { value: number; color?: string }) {
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={[styles.bar, { backgroundColor: t.surfaceAlt }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: color ?? t.primary }]} />
    </View>
  );
}

export function Fab({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: '#00000022' }}
      style={[styles.fab, { backgroundColor: t.primary, bottom: insets.bottom + space.lg }]}>
      <MaterialCommunityIcons name={icon} size={22} color={t.onPrimary} />
      <Text style={[styles.btnText, { color: t.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', flexShrink: 1 },
  content: { paddingHorizontal: space.lg, gap: space.md },
  footer: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.sm, overflow: 'hidden' },
  btn: { minHeight: 52, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, overflow: 'hidden' },
  btnSmall: { minHeight: 40, borderRadius: radius.sm, paddingHorizontal: space.md },
  btnText: { fontSize: 16, fontWeight: '600' },
  btnTextSmall: { fontSize: 14 },
  btnHint: { fontSize: 12, opacity: 0.8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.sm, borderWidth: 1 },
  input: { flex: 1, minWidth: 0, fontSize: 17, paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 50 },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, minHeight: 38, borderRadius: radius.pill, borderWidth: 1, maxWidth: 240 },
  chipText: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: space.sm },
  body: { fontSize: 15, lineHeight: 21 },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xxl, paddingHorizontal: space.lg },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  fab: { position: 'absolute', right: space.lg, minHeight: 54, borderRadius: 27, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.sm, elevation: 4, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
