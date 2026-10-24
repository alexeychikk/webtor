// Cold loopback web-seed throughput through unmodified WebTorrent in Chromium:
// tcp-seeder (TCP-only, so the browser alone has 0 peers) → webtor-relay → WebTorrent web seed.
//   node relay/scripts/bench-webtorrent.mjs [sizeMB=200]   (from the repo root, after pnpm install
//   and `pnpm exec playwright install chromium`; needs go; BENCH_RELAY_LOG=<file> keeps the relay log)
// Prints metadata time, a cold 4 MiB mid-file read, then the full download with a cold relay
// (fresh process, no data) and again with the data already on the relay.
// Knobs (env): BENCH_RTT_MS=<ms> puts a TCP proxy that adds that round-trip time between the page
// and the relay (and BENCH_SWARM_RTT_MS between the relay and the seeder); BENCH_PIECE=<bytes>
// (default 1 MiB); BENCH_WEB_CONNS=<n> is WebTorrent's maxWebConns (default 4); BENCH_URLS=<n> web
// seed URLs for the same relay (default 1); BENCH_RELAY_ARGS="-flag value …" extra relay flags.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from '@playwright/test';

const sizeMB = Number(process.argv[2] ?? 200);
const root = resolve(import.meta.dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'webtor-bench-'));
const children = [];
const cleanup = () => {
  for (const c of children) c.kill();
  rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);

for (const cmd of ['webtor-relay', 'tcp-seeder']) {
  execFileSync('go', ['build', '-o', join(tmp, cmd), `./cmd/${cmd}`], { cwd: join(root, 'relay') });
}
const file = join(tmp, 'bench.bin');
await new Promise((ok, fail) => {
  const out = createWriteStream(file).on('finish', ok).on('error', fail);
  for (let i = 0; i < sizeMB; i++) out.write(randomBytes(1 << 20));
  out.end();
});

const env = (k, d) => Number(process.env[k] ?? d);
const rttMs = env('BENCH_RTT_MS', 0);
const swarmRttMs = env('BENCH_SWARM_RTT_MS', 0);
const pieceLength = env('BENCH_PIECE', 1 << 20);
const webConns = env('BENCH_WEB_CONNS', 4);
const urls = env('BENCH_URLS', 1);

// A TCP proxy that delays every chunk by rtt/2 each way (same-delay timers keep the order).
const delayProxy = (targetPort, rtt) =>
  new Promise((ok) => {
    const oneWay = rtt / 2;
    const server = createServer((down) => {
      const up = connect(targetPort, '127.0.0.1');
      const pipe = (from, to) => {
        from.on('data', (b) => setTimeout(() => to.write(b), oneWay));
        from.on('end', () => setTimeout(() => to.end(), oneWay));
        from.on('error', () => to.destroy());
      };
      pipe(down, up);
      pipe(up, down);
    });
    server.listen(0, '127.0.0.1', () => ok(server.address().port));
  });

const firstLine = (child) =>
  new Promise((ok) => createInterface({ input: child.stdout }).once('line', ok));
const seeder = spawn(join(tmp, 'tcp-seeder'), ['-piece-length', String(pieceLength), file]);
children.push(seeder);
let magnet = await firstLine(seeder);
if (swarmRttMs > 0) {
  const pe = /x\.pe=([^&]+)/.exec(magnet);
  const seederPort = Number(decodeURIComponent(pe[1]).split(':').pop());
  const proxied = await delayProxy(seederPort, swarmRttMs);
  magnet = magnet.replace(pe[0], `x.pe=${encodeURIComponent(`127.0.0.1:${proxied}`)}`);
}
const query = magnet.slice('magnet:?'.length);
const infoHash = /btih:([0-9a-f]{40})/i.exec(magnet)[1].toLowerCase();

const token = 'bench-' + randomBytes(8).toString('hex');
const port = 7800 + Math.floor(Math.random() * 100);
const relay = spawn(join(tmp, 'webtor-relay'), [
  ...['-listen', `127.0.0.1:${port}`, '-token', token, '-data-dir', join(tmp, 'relay')],
  ...['-peer-port', '0', '-no-dht', '-no-default-trackers'],
  ...(process.env.BENCH_RELAY_LOG ? ['-debug'] : []),
  ...(process.env.BENCH_RELAY_ARGS?.split(' ').filter(Boolean) ?? []),
]);
children.push(relay);
// BENCH_RELAY_LOG=<file> keeps the relay's request log.
if (process.env.BENCH_RELAY_LOG) relay.stderr.pipe(createWriteStream(process.env.BENCH_RELAY_LOG));
else relay.stderr.resume();
await firstLine(relay);
const origin = `http://127.0.0.1:${rttMs > 0 ? await delayProxy(port, rttMs) : port}`;
const t = `${origin}/${token}/v1/torrents/${infoHash}`;

const browser = await chromium.launch();
const run = async (label) => {
  const page = await browser.newPage();
  await page.route(`${origin}/__webtorrent.js`, (route) =>
    route.fulfill({
      path: join(root, 'node_modules/webtorrent/dist/webtorrent.min.js'),
      contentType: 'text/javascript',
    }),
  );
  await page.goto(origin + '/'); // the relay's own app page: same-origin, like the Open link
  const r = await page.evaluate(
    async ({ t, query, webConns, urls }) => {
      const { default: WebTorrent } = await import('/__webtorrent.js');
      let start = performance.now();
      const res = await fetch(`${t}/metainfo?${query}`);
      const torrentFile = new Uint8Array(await res.arrayBuffer());
      const metadataMs = performance.now() - start;
      const len = (await (await fetch(`${t}/files`)).json())[0].length;
      start = performance.now();
      const mid = Math.floor(len / 2);
      const seek = await fetch(`${t}/webseed/`, {
        headers: { Range: `bytes=${mid}-${mid + (4 << 20) - 1}` },
      });
      await seek.arrayBuffer();
      const seekMs = performance.now() - start;
      const client = new WebTorrent();
      // The same relay under several URLs: WebTorrent opens one web seed wire per URL.
      const urlList = Array.from({ length: urls }, (_, i) => `${t}/webseed/${i ? `?c=${i}` : ''}`);
      start = performance.now();
      await new Promise((ok, fail) => {
        client.on('error', fail);
        client.add(torrentFile, { urlList, announce: [], maxWebConns: webConns }, (torrent) =>
          torrent.on('done', ok),
        );
      });
      const ms = performance.now() - start;
      client.destroy();
      return { status: res.status, metadataMs, seekMs, ms, bytes: len };
    },
    { t, query, webConns, urls },
  );
  await page.close();
  if (r.status !== 200) throw new Error(`metainfo: HTTP ${r.status}`);
  const mbs = r.bytes / 1e6 / (r.ms / 1000);
  console.log(
    `${label}: metadata ${r.metadataMs.toFixed(0)} ms, 4 MiB mid-file read ${r.seekMs.toFixed(0)} ms, ` +
      `${(r.bytes / 1e6).toFixed(0)} MB in ${(r.ms / 1000).toFixed(2)} s = ${mbs.toFixed(1)} MB/s`,
  );
};
console.log(
  `piece ${pieceLength} B, RTT page↔relay ${rttMs} ms, relay↔seeder ${swarmRttMs} ms, ` +
    `maxWebConns ${webConns}, ${urls} web seed URL(s)`,
);
await run('cold relay');
await run('warm relay');
await browser.close();
cleanup();
process.exit(0);
