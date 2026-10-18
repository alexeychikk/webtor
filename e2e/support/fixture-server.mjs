// Peerless + local-WebRTC test infrastructure for e2e (started by playwright.config.ts).
//
//   http://127.0.0.1:9000/<name>            the fixture bytes, with CORS + Range → BEP-19 web seed
//   http://127.0.0.1:9000/<name>.torrent    a single-file .torrent for it      → magnet `xs=`
//   http://127.0.0.1:9000/magnet/<name>     a magnet with xs= + ws= + tr=      → play with zero peers
//   ws://127.0.0.1:8000                     WebSocket tracker for real WebRTC swarms between pages
//
// <name> is any file in e2e/fixtures, or any directory there: a directory becomes a multi-file
// torrent named after it, whose web seed is the server root (BEP-19: <ws>/<name>/<path>). Symlinks
// are followed, so a directory can reuse the top-level fixtures. Info hashes are deterministic
// (fixed piece length, no dates inside the info dict).
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import createTorrent from 'create-torrent';
import parseTorrent from 'parse-torrent';
// Import the server entry only: the package root pulls in node-datachannel (a native addon we don't build).
import TrackerServer from 'bittorrent-tracker/server';

export const HTTP_PORT = 9000;
export const TRACKER_PORT = 8000;
const HOST = '127.0.0.1';
const ROOT = resolve(import.meta.dirname, '../fixtures');
const BASE = `http://${HOST}:${HTTP_PORT}`;
const TRACKER = `ws://${HOST}:${TRACKER_PORT}`;

/** @type {Map<string, { torrent: Buffer, infoHash: string }>} */
const torrents = new Map();
for (const name of readdirSync(ROOT)) {
  const isDir = statSync(join(ROOT, name)).isDirectory();
  const torrent = await new Promise((res, rej) =>
    createTorrent(
      isDir ? join(ROOT, name) : readFileSync(join(ROOT, name)),
      {
        name,
        pieceLength: 16384,
        announceList: [[TRACKER]],
        urlList: [isDir ? `${BASE}/` : `${BASE}/${name}`],
        createdBy: 'webtor-e2e',
        creationDate: 0,
      },
      (err, buf) => (err ? rej(err) : res(buf)),
    ),
  );
  torrents.set(name, { torrent, infoHash: (await parseTorrent(torrent)).infoHash });
}

const magnetFor = (name) => {
  const t = torrents.get(name);
  if (!t) return null;
  const isDir = statSync(join(ROOT, name)).isDirectory();
  const q = new URLSearchParams({
    dn: name,
    xs: `${BASE}/${name}.torrent`,
    ws: isDir ? `${BASE}/` : `${BASE}/${name}`,
    tr: TRACKER,
  });
  return `magnet:?xt=urn:btih:${t.infoHash}&${q}`;
};

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // WebTorrent's web-seed fetch sends Cache-Control + Range; real web seeds must allow both too.
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ?? 'Range',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.end();

  const path = decodeURIComponent(new URL(req.url ?? '/', BASE).pathname).slice(1);
  if (path.startsWith('magnet/')) {
    const magnet = magnetFor(path.slice('magnet/'.length));
    res.writeHead(magnet ? 200 : 404, { 'Content-Type': 'text/plain' });
    return res.end(magnet ?? 'unknown fixture');
  }
  if (path.endsWith('.torrent') && torrents.has(path.slice(0, -'.torrent'.length))) {
    res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' });
    return res.end(torrents.get(path.slice(0, -'.torrent'.length))?.torrent);
  }
  const file = join(ROOT, path);
  if (!path || path.includes('..') || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  const size = statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  createReadStream(file).pipe(res);
}).listen(HTTP_PORT, HOST, () =>
  console.log(`fixtures on ${BASE} (${[...torrents.keys()].join(', ')})`),
);

new TrackerServer({ udp: false, http: false, ws: true, stats: false }).listen(
  TRACKER_PORT,
  HOST,
  () => console.log(`tracker on ${TRACKER}`),
);
