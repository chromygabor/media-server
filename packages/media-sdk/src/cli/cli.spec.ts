// A media-keys és a media-sign CLI (csomagterv WP33; korábban server/test/cli.spec.ts). Az aláírt linket a
// csomag `verifySignedPath`-ja ellenőrzi (a szerver njs-ével a közös vektorok tartják összhangban).

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addKey, defaultKid, generateKey, validateAppsFile, type AppsFile } from '../apps-config.js';
import { bucketExpires } from '../expires.js';
import { appLookupFrom, verifySignedPath } from '../token.js';
import { readAppsFile, writeAppsFile } from './apps-file.js';
import { keysMain } from './keys.js';
import { CONTENT_TTL, signMain, signUrl } from './sign.js';

/** A médiaszerver `test/fixtures/apps.test.json`-jával azonos, CSAK TESZT kulcsok. */
const fixture: AppsFile = {
  elearning: {
    dir: 'elearning',
    keys: { t2026a: 'CSAK-TESZT-kulcs-elearning-bongeszos-NEM-ELES-0001' },
    contentKeys: { t2026c: 'CSAK-TESZT-kulcs-elearning-tartalom-NEM-ELES-00001' },
    origins: ['https://elearning.example.test', 'http://localhost:3000'],
    corp: 'same-site',
  },
  helyi: {
    dir: '.',
    keys: { t2026a: 'CSAK-TESZT-kulcs-helyi-bongeszos-NEM-ELES-0000000001' },
    contentKeys: {},
    origins: [],
    corp: 'cross-origin',
  },
  masik: {
    dir: 'masik',
    keys: { t2026a: 'CSAK-TESZT-kulcs-masik-bongeszos-NEM-ELES-0000000001' },
    contentKeys: {},
    origins: [],
    corp: 'same-site',
  },
};
const NOW = 1_795_431_700;
const verify = (path: string, now: number) => verifySignedPath(path, appLookupFrom(fixture), now);

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
const tmpFile = (name: string): string => {
  dir ||= mkdtempSync(join(tmpdir(), 'media-sdk-cli-'));
  return join(dir, name);
};

/** A CLI kimenete (stdout, stderr) egy futásból. */
function capture(main: () => void): { out: string; err: string; code: number | undefined } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  let thrown: unknown;
  try {
    main();
  } catch (e) {
    thrown = e;
  }
  vi.restoreAllMocks();
  if (thrown !== undefined) err.push((thrown as Error).message);
  const code = typeof process.exitCode === 'number' ? process.exitCode : undefined;
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

describe('media-keys', () => {
  it('32 véletlen bájt base64url-szövege (43 jel), a validátor elfogadja', () => {
    const k = generateKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k, 'base64url')).toHaveLength(32);
    expect(generateKey()).not.toBe(k);
    expect(validateAppsFile(addKey({}, { app: 'x', kid: '2026a', key: k, content: false })).ok).toBe(true);
  });

  it('alap kid: <év>a / <év>c', () => {
    const d = new Date(Date.UTC(2026, 10, 23));
    expect(defaultKid(false, d)).toBe('2026a');
    expect(defaultKid(true, d)).toBe('2026c');
  });

  it('új app: dir = app; csak hozzáad, a meglévő kid-et nem írja felül', () => {
    const a1 = addKey({}, { app: 'elearning', kid: '2026a', key: 'K1', content: false });
    expect(a1.elearning).toEqual({ dir: 'elearning', keys: { '2026a': 'K1' }, contentKeys: {}, origins: [], corp: 'same-site' });
    const a2 = addKey(a1, { app: 'elearning', kid: '2026c', key: 'K2', content: true });
    expect(a2.elearning?.contentKeys).toEqual({ '2026c': 'K2' });
    expect(a1.elearning?.contentKeys).toEqual({});
    expect(() => addKey(a2, { app: 'elearning', kid: '2026a', key: 'K3', content: false })).toThrow(/már létezik/);
    expect(() => addKey(a2, { app: 'elearning', kid: '2026a', key: 'K3', content: true })).toThrow(/már létezik/);
    expect(() => addKey({}, { app: '../x', kid: 'a', key: 'K', content: false })).toThrow(/app-név/);
    expect(() => addKey({}, { app: '_x', kid: 'a', key: 'K', content: false })).toThrow(/app-név/);
    expect(() => addKey({}, { app: 'x', kid: 'a&b', key: 'K', content: false })).toThrow(/érvénytelen kid/);
    expect(addKey({}, { app: 'helyi', kid: 'a', key: 'K', content: false, dir: '.' }).helyi?.dir).toBe('.');
  });

  describe('fájlírás', () => {
    it('új fájl 0600; meglévő 0400 marad 0400, ugyanaz az inode', () => {
      const file = tmpFile('apps.json');
      writeAppsFile(file, addKey({}, { app: 'a', kid: 'k1', key: 'K1', content: false }));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      chmodSync(file, 0o400);
      const ino = statSync(file).ino;
      writeAppsFile(file, addKey(readAppsFile(file), { app: 'a', kid: 'k2', key: 'K2', content: false }));
      expect(statSync(file).mode & 0o777).toBe(0o400);
      expect(statSync(file).ino).toBe(ino);
      expect(readAppsFile(file).a?.keys).toEqual({ k1: 'K1', k2: 'K2' });
    });
    it('nem objektum gyökér → hiba', () => {
      const file = tmpFile('apps.json');
      writeFileSync(file, '[]');
      expect(() => readAppsFile(file)).toThrow(/nem objektum/);
    });
    it('hibás JSON → hiba a fájl szövege nélkül (a kulcs nem szivárog), legfeljebb sor/oszlop', () => {
      const secret = 'TITKOS-kulcs-SOHA-NE-LATSZODJON-0123456789abcdef';
      for (const text of [`{"a":{"keys":{"k":${secret}}}}`, `{"a":{"keys":{"k":"${secret}"}},}`, `{"k":"${secret}"`]) {
        const file = tmpFile('apps.json');
        writeFileSync(file, text);
        let message = '';
        try {
          readAppsFile(file);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain('nem érvényes JSON');
        expect(message).not.toContain(secret.slice(0, 12));
        expect(message).not.toContain('{');
        for (const main of [() => signMain(['--apps', file, 'a', 'b.mp4']), () => keysMain(['a', '--write', file])]) {
          const r = capture(main);
          expect(r.err).toContain('nem érvényes JSON');
          expect(r.out + r.err).not.toContain(secret.slice(0, 12));
        }
      }
    });
  });

  describe('parancs', () => {
    it('--help: a súgó a stdout-on, kilépési kód 0; argumentum nélkül a használat a stderr-en, 2', () => {
      const help = capture(() => keysMain(['--help']));
      expect(help.out).toMatch(/^Használat: media-keys <app>/);
      expect(help.code).toBeUndefined();
      const bad = capture(() => keysMain([]));
      expect(bad.err).toMatch(/^Használat: media-keys/);
      expect(bad.code).toBe(2);
    });

    it('--write: hozzáad és kiírja a részletet + a backend env-sorait (a vezető -- elhagyva)', () => {
      const file = tmpFile('apps.json');
      const r = capture(() => keysMain(['--', 'elearning', '--kid', 'dev1', '--dir', '.', '--write', file]));
      const key = readAppsFile(file).elearning?.keys.dev1 as string;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.out).toBe(
        [
          `Hozzáadva: ${file} → elearning.keys.dev1`,
          '',
          'apps.json (elearning.keys):',
          `  {"dev1":"${key}"}`,
          '',
          'Backend (javasolt env-nevek, SPEC 9.):',
          '  MEDIA_SERVER_KEY_ID=dev1',
          `  MEDIA_SERVER_KEYS={"dev1":"${key}"}`,
          '',
          'A kulcs titok: ne kerüljön repóba, chatbe, naplóba.',
        ].join('\n'),
      );
      expect(r.err).toBe('');
      const c = capture(() => keysMain(['elearning', '--content', '--kid', 'dev1c', '--write', file]));
      const ckey = readAppsFile(file).elearning?.contentKeys.dev1c as string;
      expect(c.out).toContain(`  MEDIA_SERVER_CONTENT_KEY_ID=dev1c\n  MEDIA_SERVER_CONTENT_KEY=${ckey}`);
      expect(readAppsFile(file).elearning?.dir).toBe('.');
      expect(capture(() => keysMain(['elearning', '--kid', 'dev1', '--write', file])).err).toMatch(/már létezik/);
    });

    it('fájl nélkül csak kiír; tartalmilag hibás eredménynél figyelmeztet (kulcs nélkül)', () => {
      const r = capture(() => keysMain(['masik', '--kid', '2026a']));
      expect(r.out).toMatch(/^\napps\.json \(masik\.keys\):\n {2}\{"2026a":"[A-Za-z0-9_-]{43}"\}/);
      const file = tmpFile('apps.json');
      writeFileSync(file, JSON.stringify({ rossz: { dir: '../x', keys: {}, contentKeys: {} } }));
      const w = capture(() => keysMain(['uj', '--write', file]));
      expect(w.err).toContain('Figyelem');
      expect(w.err).toContain('apps["rossz"].dir: érvénytelen könyvtár');
      const key = readAppsFile(file).uj?.keys[defaultKid(false)] as string;
      expect(w.err).not.toContain(key);
    });
  });
});

describe('media-sign', () => {
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

  it('böngészős: alap base, a fájl könyvtára a token_path, vödrözött lejárat; az ellenőrzés elfogadja', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: 't/lessons/ch-01-l01/m01.720p.mp4', u: 'u1', now: NOW });
    expect(url.startsWith('http://127.0.0.1:10090/bcdn_token=HS256-')).toBe(true);
    expect(url).toContain('&token_path=%2Felearning%2Ft%2Flessons%2Fch-01-l01%2F&u=u1&');
    expect(url).toContain(`&expires=${bucketExpires(NOW)}/elearning/t/lessons/ch-01-l01/m01.720p.mp4`);
    const r = verify(path(url), NOW);
    expect(r.ok && [r.app, r.kid, r.u]).toEqual(['elearning', 't2026a', 'u1']);
  });

  it('tartalom: tartalomkulcs, fájlra szóló token_path, 5 perc', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: '_content/v1.json.gz', content: true, now: NOW, base: 'https://m.example/' });
    expect(url.startsWith('https://m.example/bcdn_token=')).toBe(true);
    expect(url).toContain('kid=t2026c&token_path=%2Felearning%2F_content%2Fv1.json.gz&expires=');
    expect(url).toContain(`expires=${NOW + CONTENT_TTL}/`);
    expect(verify(path(url), NOW).ok).toBe(true);
    expect(verify(path(url), NOW + CONTENT_TTL + 1)).toMatchObject({ status: 410 });
  });

  it('--ttl, --prefix, --kid', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: 't/lessons/ch-01-l01/m.jpg', ttl: 60, prefix: '/elearning/t/', kid: 't2026a', now: NOW });
    expect(url).toContain('token_path=%2Felearning%2Ft%2F&expires=' + String(NOW + 60));
    expect(verify(path(url).replace('ch-01-l01/m.jpg', 'ch-02-l01/m.jpg'), NOW).ok).toBe(true);
    expect(verify(path(url).replace('/elearning/t/lessons/', '/elearning/v/lessons/'), NOW)).toMatchObject({
      status: 403,
      reason: 'outside-token-path',
    });
  });

  it('hibák: ismeretlen app / kid, nincs kulcs, tartalom u-val, rossz útvonal', () => {
    expect(() => signUrl({ apps: fixture, app: 'nincs', assetKey: 'a.mp4' })).toThrow(/nincs ilyen app/);
    expect(() => signUrl({ apps: fixture, app: 'elearning', assetKey: 't/a.mp4', kid: 'x' })).toThrow(/nincs ilyen keys kid/);
    expect(() => signUrl({ apps: fixture, app: 'masik', assetKey: '_content/a.json.gz', content: true })).toThrow(/nincs tartalom kulcsa/);
    expect(() => signUrl({ apps: fixture, app: 'elearning', assetKey: '_content/a.json.gz', content: true, u: 'x' })).toThrow(/nincs u/);
    expect(() => signUrl({ apps: fixture, app: 'elearning', assetKey: 't/../a.mp4' })).toThrow(RangeError);
  });

  it('parancs: --apps kötelező, az utolsó számít; a kimenet az URL', () => {
    const file = tmpFile('apps.json');
    writeFileSync(file, JSON.stringify(fixture));
    expect(capture(() => signMain(['elearning', 't/a.mp4'])).code).toBe(2);
    expect(capture(() => signMain(['--help'])).out).toMatch(/^Használat: media-sign --apps <apps.json>/);
    const r = capture(() => signMain(['--apps', join(dir, 'nincs.json'), '--', 'elearning', 't/a.mp4', '--apps', file, '--u', 'u1']));
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^http:\/\/127\.0\.0\.1:10090\/bcdn_token=HS256-[A-Za-z0-9_-]{43}&kid=t2026a&token_path=%2Felearning%2Ft%2F&u=u1&expires=\d+\/elearning\/t\/a\.mp4$/);
    expect(verify(path(r.out), Math.floor(Date.now() / 1000)).ok).toBe(true);
    expect(capture(() => signMain(['--apps', file, 'elearning', 't/a.mp4', '--ttl', 'x'])).err).toMatch(/érvénytelen --ttl/);
  });
});
