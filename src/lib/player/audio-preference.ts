/** The user's last chosen audio language, preferred when the next video opens (localStorage). */
const KEY = 'webtor:audio-lang';

export function preferredAudioLanguage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** `und` (unknown) says nothing about the user's preference, so it is not remembered. */
export function rememberAudioLanguage(language: string): void {
  if (!language || language === 'und') return;
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // Storage disabled (private mode, quota): the choice just isn't remembered.
  }
}
