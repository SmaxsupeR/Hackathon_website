import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Writes text to a temporary file and opens the system share sheet so the user can save or send it. */
export async function shareTextFile(name: string, content: string, mimeType: string): Promise<void> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: name });
}

/** Lets the user pick a file and returns its name and text, or null if they cancelled. */
export async function pickTextFile(): Promise<{ name: string; text: string } | null> {
  const picked = await File.pickFileAsync({});
  if (picked.canceled) return null;
  return { name: picked.result.name, text: await picked.result.text() };
}

export function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
