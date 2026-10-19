import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackError } from '../player/errors';
import { fetchRelayTranscode } from './relay-client';

const missing = () =>
  Response.json({ error: 'torrent not added; fetch metainfo first' }, { status: 404 });
const stream = () => new Response(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]));

describe('fetchRelayTranscode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers the torrent again and retries once when the relay lost it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(missing()).mockResolvedValueOnce(stream());
    vi.stubGlobal('fetch', fetch);
    const register = vi.fn().mockResolvedValue(undefined);
    const body = await fetchRelayTranscode(
      'http://r/t/transcode/0?start=0',
      new AbortController().signal,
      register,
    );
    expect(body).toBeInstanceOf(ReadableStream);
    expect(register).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails with relay-error when the torrent is still missing after registering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => missing()),
    );
    const register = vi.fn().mockResolvedValue(undefined);
    const err = await fetchRelayTranscode(
      'http://r/x',
      new AbortController().signal,
      register,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaybackError);
    expect((err as PlaybackError).code).toBe('relay-error');
    expect(register).toHaveBeenCalledOnce();
  });

  it('does not register again for other failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'transcode-busy' }, { status: 429 })),
    );
    const register = vi.fn();
    const err = await fetchRelayTranscode(
      'http://r/x',
      new AbortController().signal,
      register,
    ).catch((e: unknown) => e);
    expect((err as PlaybackError).code).toBe('relay-transcode-busy');
    expect(register).not.toHaveBeenCalled();
  });
});
