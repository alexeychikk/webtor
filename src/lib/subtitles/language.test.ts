import { describe, expect, it } from 'vitest';
import {
  guessLanguageFromFilename,
  isForcedFilename,
  languageName,
  normalizeLanguage,
} from './language';

describe('normalizeLanguage', () => {
  it('maps ISO 639-2, BCP 47 and names to ISO 639-1', () => {
    expect(normalizeLanguage('eng')).toBe('en');
    expect(normalizeLanguage('ger')).toBe('de');
    expect(normalizeLanguage('deu')).toBe('de');
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('Russian')).toBe('ru');
    expect(normalizeLanguage('und')).toBe('');
    expect(normalizeLanguage(undefined)).toBe('');
    expect(normalizeLanguage('xyz')).toBe('xyz');
  });
  it('names known codes', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('xyz')).toBe('xyz');
  });
});

describe('guessLanguageFromFilename', () => {
  it.each([
    ['sidecar.en.srt', 'en'],
    ['Movie.2020.1080p.eng.srt', 'en'],
    ['Movie.ru.forced.srt', 'ru'],
    ['Movie_Russian.ass', 'ru'],
    ['Subs/2_English.srt', 'en'],
    ['Subs/English.srt', 'en'],
    ['Movie.pt-BR.srt', 'pt'],
    ['Movie.WEB-DL.srt', ''],
    ['It.Follows.2014.srt', ''],
    ['en.srt', ''],
    ['Movie.srt', ''],
  ])('%s → %s', (name, lang) => expect(guessLanguageFromFilename(name)).toBe(lang));
});

describe('isForcedFilename', () => {
  it('spots .forced.', () => {
    expect(isForcedFilename('Movie.en.forced.srt')).toBe(true);
    expect(isForcedFilename('Movie [Forced].srt')).toBe(true);
    expect(isForcedFilename('Unforced.Error.srt')).toBe(false);
  });
});
