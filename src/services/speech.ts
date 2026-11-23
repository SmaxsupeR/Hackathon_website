import * as Speech from 'expo-speech';

let koreanVoice: boolean | null = null;

/** Whether the device's text-to-speech engine has a Korean voice installed. */
export async function hasKoreanVoice(): Promise<boolean> {
  if (koreanVoice === true) return true;
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    koreanVoice = voices.some((v) => v.language?.toLowerCase().startsWith('ko'));
  } catch {
    koreanVoice = false;
  }
  return koreanVoice;
}

/**
 * Speaks Korean text. Returns false when there is no Korean voice, so the
 * caller can tell the user instead of playing a wrong-language voice.
 */
export async function speakKorean(text: string, rate = 0.9): Promise<boolean> {
  if (!(await hasKoreanVoice())) return false;
  await Speech.stop();
  Speech.speak(text, { language: 'ko-KR', rate });
  return true;
}
