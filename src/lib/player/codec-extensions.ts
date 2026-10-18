/**
 * Lazy-loaded Mediabunny codec extensions (each is ~1–2 MB of wasm): imported and registered the
 * first time a track needs them, never up front (docs/decisions/0003).
 */
import type { AudioDecision } from './codecs';

const loaded = new Map<string, Promise<void>>();

function once(name: string, load: () => Promise<void>): Promise<void> {
  let p = loaded.get(name);
  if (!p) {
    p = load();
    // A failed download may succeed later (e.g. flaky network): don't cache the failure.
    p.catch(() => loaded.delete(name));
    loaded.set(name, p);
  }
  return p;
}

/** Registers the decoder and encoder `decision` needs; resolves at once for a copy. */
export async function loadCodecExtensions(decision: AudioDecision): Promise<void> {
  if (decision.playback !== 'transcode') return;
  const jobs: Promise<void>[] = [];
  if (decision.decoder === 'ac3') {
    jobs.push(once('ac3', async () => (await import('@mediabunny/ac3')).registerAc3Decoder()));
  } else if (decision.decoder === 'dts') {
    jobs.push(once('dts', async () => (await import('@mediabunny/dts')).registerDtsDecoder()));
  }
  if (decision.target.wasmEncoder) {
    jobs.push(
      once('aac-encoder', async () =>
        (await import('@mediabunny/aac-encoder')).registerAacEncoder(),
      ),
    );
  }
  await Promise.all(jobs);
}
