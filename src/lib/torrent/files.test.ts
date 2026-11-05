import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  isTorrentBytes,
  isTorrentFile,
  listSubtitleFiles,
  listVideoFiles,
  pickVideoFile,
  readTorrentFile,
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

const bytes = (text: string) => new TextEncoder().encode(text);
const TORRENT =
  'd8:announce19:ws://127.0.0.1:800010:created byi-1e4:infod6:lengthi1024e4:name9:movie.mkv' +
  '12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaa5:filesld6:lengthi1e4:pathl1:aeeee' +
  '8:url-listl0:ee';

describe('isTorrentBytes', () => {
  it('accepts a bencoded dictionary with an info dictionary', () => {
    expect(isTorrentBytes(bytes(TORRENT))).toBe(true);
    expect(isTorrentBytes(bytes('d4:infodee'))).toBe(true);
    // Trailing bytes after the dictionary (a newline added by a download) don't matter.
    expect(isTorrentBytes(bytes(`${TORRENT}\n`))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTorrentBytes(bytes(''))).toBe(false);
    expect(isTorrentBytes(bytes('this is not bencoded'))).toBe(false);
    expect(isTorrentBytes(bytes('1\n00:00:01,000 --> 00:00:02,000\nHi\n'))).toBe(false);
    expect(isTorrentBytes(bytes('de'))).toBe(false);
    expect(isTorrentBytes(bytes('d4:infoi1ee'))).toBe(false);
    expect(isTorrentBytes(bytes('d4:infodee'.slice(0, -1)))).toBe(false);
    expect(isTorrentBytes(bytes('d4:infod3:key9:shortee'))).toBe(false);
    expect(isTorrentBytes(bytes('d4:infodei12ee'))).toBe(false);
    expect(isTorrentBytes(bytes('d4:infod1:ai1x2eee'))).toBe(false);
    expect(isTorrentBytes(bytes('li1ee'))).toBe(false);
    expect(isTorrentBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x64]))).toBe(false);
  });

  it('rejects nesting too deep to be a torrent without overflowing the stack', () => {
    const deep = `d4:infod1:a${'l'.repeat(100_000)}${'e'.repeat(100_000)}ee`;
    expect(isTorrentBytes(bytes(deep))).toBe(false);
  });
});

describe('readTorrentFile', () => {
  it('returns the bytes of a torrent, whatever its name', async () => {
    const file = new File([TORRENT], 'download', { type: '' });
    expect(await readTorrentFile(file)).toEqual(bytes(TORRENT));
  });

  it('returns null for other files', async () => {
    expect(await readTorrentFile(new File(['not bencoded'], 'x.torrent'))).toBeNull();
    expect(await readTorrentFile(new File(['d1:ai1ee'], 'x.torrent'))).toBeNull();
    expect(await readTorrentFile(new File([], 'empty.torrent'))).toBeNull();
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
