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
