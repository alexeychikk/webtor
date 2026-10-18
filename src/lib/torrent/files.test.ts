import { describe, expect, it } from 'vitest';
import { classifyFile, listSubtitleFiles, pickVideoFile } from './files';

const f = (name: string, length: number) => ({ name, path: `t/${name}`, length });

describe('classifyFile', () => {
  it('knows playable, unsupported and non-video files', () => {
    expect(classifyFile('Movie.MKV')).toBe('playable');
    expect(classifyFile('clip.mp4')).toBe('playable');
    expect(classifyFile('old.avi')).toBe('unsupported');
    expect(classifyFile('subs.srt')).toBe('other');
    expect(classifyFile('README')).toBe('other');
  });
});

describe('pickVideoFile', () => {
  it('picks the largest playable video', () => {
    const pick = pickVideoFile([f('sample.mkv', 10), f('movie.mkv', 900), f('huge.avi', 5000)]);
    expect(pick).toEqual({
      ok: true,
      file: { index: 1, name: 'movie.mkv', path: 't/movie.mkv', length: 900 },
    });
  });
  it('reports an unsupported container when only those exist', () => {
    expect(pickVideoFile([f('a.avi', 1), f('a.nfo', 1)])).toEqual({
      ok: false,
      code: 'unsupported-container',
    });
  });
  it('reports no playable file when there is no video', () => {
    expect(pickVideoFile([f('a.txt', 1)])).toEqual({ ok: false, code: 'no-playable-file' });
  });
});

describe('listSubtitleFiles', () => {
  const f = (path: string) => ({ path, name: path.split('/').pop()!, length: 100 });
  it('lists srt/vtt/ass/ssa with the video basename first', () => {
    const files = [
      f('t/Movie.mkv'),
      f('t/Subs/English.srt'),
      f('t/Movie.ru.ass'),
      f('t/Movie.en.srt'),
      f('t/notes.txt'),
      f('t/Other.vtt'),
    ];
    expect(listSubtitleFiles(files, 'Movie.mkv').map((e) => [e.index, e.format])).toEqual([
      [3, 'srt'],
      [2, 'ass'],
      [5, 'vtt'],
      [1, 'srt'],
    ]);
  });
});
