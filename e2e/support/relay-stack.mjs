// A swarm the browser alone can't reach, plus the relay that reaches it (started by
// playwright.config.ts; docs/decisions/0006):
//
//   tcp-seeder   seeds a copy of e2e/fixtures/sample.mkv over TCP on 127.0.0.1 only (no DHT, no
//                trackers, no WebRTC); its magnet has just xt=, dn= and x.pe= (no xs=, no ws=)
//   webtor-relay http://127.0.0.1:7882/<RELAY_TOKEN>, no DHT, no default trackers
//   http://127.0.0.1:9100/magnet     the seeder's magnet
//   http://127.0.0.1:9100/relay-url  the relay URL
//
// Both Go commands are built once (`go build`, cached by Go) and run as direct children, so killing
// this process tree stops them.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const STACK_PORT = 9100;
export const RELAY_ADDR = '127.0.0.1:7882';
export const RELAY_TOKEN = 'e2e-relay-token';
const HOST = '127.0.0.1';
const RELAY_DIR = resolve(import.meta.dirname, '../../relay');
const FIXTURE = resolve(import.meta.dirname, '../fixtures/sample.mkv');

const work = mkdtempSync(join(tmpdir(), 'webtor-e2e-relay-'));
const children = [];
const cleanup = () => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

execFileSync(
  'go',
  ['build', '-o', join(work, 'bin') + '/', './cmd/webtor-relay', './cmd/tcp-seeder'],
  {
    cwd: RELAY_DIR,
    stdio: 'inherit',
  },
);

/** Starts a built command and resolves with the first stdout line matching `pattern`. */
function start(name, args, pattern) {
  const child = spawn(join(work, 'bin', name), args, { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((res, rej) => {
    child.on('exit', (code) => rej(new Error(`${name} exited with ${code}`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = pattern.exec(line);
      if (m) res(m[1]);
    });
  });
}

// Seed from a copy: anacrolix keeps its piece-completion db next to the data, and every file in
// e2e/fixtures is served by the fixture server.
mkdirSync(join(work, 'seed'));
copyFileSync(FIXTURE, join(work, 'seed', 'sample.mkv'));
const magnet = await start('tcp-seeder', [join(work, 'seed', 'sample.mkv')], /^(magnet:\?\S+)/);
const relayUrl = await start(
  'webtor-relay',
  [
    '-listen',
    RELAY_ADDR,
    '-token',
    RELAY_TOKEN,
    '-data-dir',
    join(work, 'relay'),
    '-peer-port',
    '0',
    '-no-dht',
    '-no-default-trackers',
  ],
  /^Relay URL:\s+(\S+)/,
);

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = { '/magnet': magnet, '/relay-url': relayUrl }[req.url ?? ''];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/plain' });
  res.end(body ?? 'not found');
}).listen(STACK_PORT, HOST, () => {
  console.log(`relay stack: ${magnet} via ${relayUrl}`);
});
