import { describe, expect, it } from 'vitest';
import {
  diagnosticsReport,
  MAX_WARNINGS,
  originsOnly,
  pushWarning,
  redactRelay,
  relayReportNote,
} from './diagnostics';

const base = 'https://203-0-113-7.sslip.io/s3cr3tT0ken';

describe('redactRelay', () => {
  it('removes the relay URL, its token and its host', () => {
    const text = `${base}/v1/torrents/ab/webseed/ failed; token s3cr3tT0ken at 203-0-113-7.sslip.io`;
    const out = redactRelay(text, base);
    expect(out).toBe('<relay>/v1/torrents/ab/webseed/ failed; token <token> at <relay-host>');
  });
  it('keeps the text without a relay', () => {
    expect(redactRelay('as is', null)).toBe('as is');
  });
});

describe('originsOnly', () => {
  it('cuts URLs to their origin', () => {
    expect(
      originsOnly('Web seed error: https://seed.example:8443/pk/abc/file.mkv?x=1 (500), ok'),
    ).toBe('Web seed error: https://seed.example:8443 (500), ok');
    expect(originsOnly('"wss://tracker.example/announce"')).toBe('"wss://tracker.example"');
  });
});

describe('pushWarning', () => {
  it('keeps the last warnings, clipped', () => {
    const list: string[] = [];
    for (let i = 0; i < 50; i++) pushWarning(list, i * 1000, new Error(`w${i} ${'x'.repeat(500)}`));
    expect(list).toHaveLength(MAX_WARNINGS);
    expect(list.at(-1)).toMatch(/^\+49\.0s w49 x+$/);
    expect(list.at(-1)!.length).toBeLessThan(320);
  });
});

describe('diagnosticsReport', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  it('holds both sides and no relay URL', () => {
    const text = diagnosticsReport(
      { phase: 'buffering', note: `${base}/v1/x` },
      { kind: 'ok', report: { api: 4, torrents: [{ infoHash: 'ab' }] } },
      base,
      now,
    );
    const json = JSON.parse(text);
    expect(json).toMatchObject({
      webtorDiagnostics: 1,
      createdAt: '2026-11-06T12:00:00.000Z',
      app: { phase: 'buffering', note: '<relay>/v1/x' },
      relay: { api: 4 },
    });
    expect(text).not.toContain('s3cr3tT0ken');
    expect(text).not.toContain('sslip.io');
  });
  it('says when the relay could not report', () => {
    const json = JSON.parse(
      diagnosticsReport({}, { kind: 'too-old', version: '0.9.0', api: 3 }, base, now),
    );
    expect(json.relay.unavailable).toMatch(/0\.9\.0 is too old/);
    expect(JSON.parse(diagnosticsReport({}, { kind: 'none' }, null, now)).relay).toBeNull();
  });
});

describe('relayReportNote', () => {
  it('names what the report holds', () => {
    expect(relayReportNote({ kind: 'ok', report: {} })).toMatch(/relay’s event log/);
    expect(relayReportNote({ kind: 'failed', reason: 'unreachable' })).toMatch(
      /did not send its side \(unreachable\)/,
    );
  });
});
