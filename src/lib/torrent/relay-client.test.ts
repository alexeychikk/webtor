import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackError } from '../player/errors';
import { fetchRelayDiagnostics, fetchRelayTranscode } from './relay-client';

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

describe('fetchRelayDiagnostics', () => {
  afterEach(() => vi.unstubAllGlobals());
  const info = (api: number) => Response.json({ name: 'webtor-relay', version: '0.9.0', api });
  const notFound = () => new Response('404 page not found', { status: 404 });

  it('returns the relay report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ api: 4, torrents: [] })));
    expect(await fetchRelayDiagnostics('http://r/t/v1/diagnostics', 'http://r/t/v1/info')).toEqual({
      kind: 'ok',
      report: { api: 4, torrents: [] },
    });
  });

  it('tells a relay without the endpoint from a wrong URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(info(3)),
    );
    expect(await fetchRelayDiagnostics('http://r/t/d', 'http://r/t/i')).toEqual({
      kind: 'too-old',
      version: '0.9.0',
      api: 3,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => notFound()),
    );
    expect(await fetchRelayDiagnostics('http://r/t/d', 'http://r/t/i')).toEqual({
      kind: 'failed',
      reason: 'HTTP 404 — wrong token or not a webtor-relay?',
    });
  });

  it('never rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await fetchRelayDiagnostics('http://r/t/d', 'http://r/t/i')).toEqual({
      kind: 'failed',
      reason: 'unreachable',
    });
  });
});
