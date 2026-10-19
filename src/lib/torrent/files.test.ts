import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  isTorrentFile,
  listSubtitleFiles,
  listVideoFiles,
  pickVideoFile,
} from './files';

const f = (name: string, length: number) => ({ name, path: `t/${name}`, length });

describe('classifyFile', () => {
  it('knows playable, unsupported and non-video files', () => {
    expect(classifyFile('Movie.MKV')).toBe('playable');
    expect(classifyFile('clip.mp4')).toBe('playable');
    expect(classifyFile('old.avi')).toBe('playable');
    expect(classifyFile('old.wmv')).toBe('unsupported');
    expect(classifyFile('subs.srt')).toBe('other');
    expect(classifyFile('README')).toBe('other');
  });
});

describe('pickVideoFile', () => {
  it('picks the largest playable video', () => {
    const pick = pickVideoFile([f('sample.mkv', 10), f('movie.mkv', 900), f('huge.wmv', 5000)]);
    expect(pick).toEqual({
      ok: true,
      file: { index: 1, name: 'movie.mkv', path: 't/movie.mkv', length: 900 },
    });
  });
  it('honours a preferred playable file and ignores an unplayable or missing one', () => {
    const files = [f('e1.mkv', 900), f('e2.mp4', 10), f('x.wmv', 5000), f('n.txt', 1)];
    expect(pickVideoFile(files, 1)).toMatchObject({ ok: true, file: { index: 1 } });
    expect(pickVideoFile(files, 2)).toMatchObject({ ok: true, file: { index: 0 } });
    expect(pickVideoFile(files, 3)).toMatchObject({ ok: true, file: { index: 0 } });
    expect(pickVideoFile(files, 9)).toMatchObject({ ok: true, file: { index: 0 } });
  });
  it('reports an unsupported container when only those exist', () => {
    expect(pickVideoFile([f('a.wmv', 1), f('a.nfo', 1)])).toEqual({
      ok: false,
      code: 'unsupported-container',
    });
  });
  it('reports no playable file when there is no video', () => {
    expect(pickVideoFile([f('a.txt', 1)])).toEqual({ ok: false, code: 'no-playable-file' });
  });
});

describe('listVideoFiles', () => {
  it('lists playable and unsupported videos in natural path order, keeping torrent indexes', () => {
    const files = [f('E10.mkv', 3), f('notes.txt', 1), f('E2.mp4', 2), f('extra.wmv', 9)];
    expect(listVideoFiles(files).map((e) => [e.index, e.name, e.kind])).toEqual([
      [2, 'E2.mp4', 'playable'],
      [0, 'E10.mkv', 'playable'],
      [3, 'extra.wmv', 'unsupported'],
    ]);
  });
});

describe('isTorrentFile', () => {
  it('goes by extension or MIME type', () => {
    expect(isTorrentFile({ name: 'Movie.TORRENT', type: '' })).toBe(true);
    expect(isTorrentFile({ name: 'download', type: 'application/x-bittorrent' })).toBe(true);
    expect(isTorrentFile({ name: 'subs.srt', type: 'application/x-subrip' })).toBe(false);
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
