export const FIXTURE_BASE = 'http://127.0.0.1:9000';
export const TRACKER_URL = 'ws://127.0.0.1:8000';

/**
 * Magnet for a file in e2e/fixtures that plays with zero peers: metadata via `xs=` (.torrent URL),
 * data via `ws=` (web seed), plus `tr=` pointing at the local WebSocket tracker.
 */
export async function fixtureMagnet(name: string): Promise<string> {
  const res = await fetch(`${FIXTURE_BASE}/magnet/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`no fixture ${name}: ${res.status}`);
  return res.text();
}

export const RELAY_STACK_BASE = 'http://127.0.0.1:9100';

/**
 * The relay stack (e2e/support/relay-stack.mjs): a magnet only a TCP seeder on loopback has (no
 * `xs=`, no `ws=`, no WebRTC peers) and the URL of a webtor-relay that can reach it.
 */
export async function relayStack(): Promise<{ magnet: string; relayUrl: string }> {
  const get = async (path: string) => {
    const res = await fetch(`${RELAY_STACK_BASE}${path}`);
    if (!res.ok) throw new Error(`relay stack ${path}: ${res.status}`);
    return res.text();
  };
  return { magnet: await get('/magnet'), relayUrl: await get('/relay-url') };
}
