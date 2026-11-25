// A media-keys és a media-sign CLI (csomagterv WP33; korábban server/test/cli.spec.ts). Az aláírt linket a
// csomag `verifySignedPath`-ja ellenőrzi (a szerver njs-ével a közös vektorok tartják összhangban).

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addKey, checkPublicKeys, defaultKid, generateKey, generateKeyPair, publicKeyOf, validateAppsFile, type AppsFile } from '../apps-config.js';
import { bucketExpires } from '../expires.js';
import { isValidPrivateKey, isValidPublicKey } from '../keys.js';
import { startFakeMediaServer } from '../testing/fake-server.js';
import { testAppsFile, testKeys } from '../testing/test-keys.js';
import { appLookupFrom, verifySignedPath } from '../token.js';
import { readAppsFile, writeAppsFile } from './apps-file.js';
import { keysMain } from './keys.js';
import { CONTENT_TTL, signMain, signUrl, signingFromEnv } from './sign.js';

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

describe('media-keys --keypair (ES256, app oldal)', () => {
  /** A kimenet sorai `NÉV=érték` / `kulcs=érték` párokká (az env-sorok és az üzemeltetői sor). */
  const fields = (out: string) => Object.fromEntries([...out.matchAll(/([A-Za-z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));

  it('parse-olható kimenet: env-sorok (titok) és az üzemeltetői sor; a nyilvános kulcs a titkosból levezethető; fájlt nem ír', () => {
    const cwd = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), 'media-sdk-keypair-'));
    let r: ReturnType<typeof capture>;
    try {
      process.chdir(empty);
      r = capture(() => keysMain(['--keypair', 'elearning-dev']));
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      process.chdir(cwd);
      rmSync(empty, { recursive: true, force: true });
    }
    expect(r.err).toBe('');
    expect(r.code).toBeUndefined();
    const f = fields(r.out);
    const kid = defaultKid(false, new Date(), true);
    expect(kid).toMatch(/^\d{4}e$/);
    expect(f.MEDIA_SERVER_KEY_ID).toBe(kid);
    const privateKeys = JSON.parse(f.MEDIA_SERVER_PRIVATE_KEYS!) as Record<string, string>;
    expect(Object.keys(privateKeys)).toEqual([kid]);
    const privateKey = privateKeys[kid]!;
    expect(isValidPrivateKey(privateKey)).toBe(true);
    expect(f).toMatchObject({ app: 'elearning-dev', kid, fajta: 'böngészős' });
    expect(isValidPublicKey(f.publicKey)).toBe(true);
    expect(publicKeyOf(privateKey)).toBe(f.publicKey);
    // Az üzemeltetői blokk a titkos kulcsot nem tartalmazza.
    const operator = r.out.slice(r.out.indexOf('Az üzemeltetőnek küldendő'));
    expect(operator).not.toContain(privateKey);
    expect(operator).toContain(`media-keys --register elearning-dev --kid ${kid} --public-key ${f.publicKey} --write <apps.json>`);
    expect(operator).toContain(`${f.publicKey!.slice(0, 8)} … ${f.publicKey!.slice(-8)}`);
  });

  it('--content: tartalom-env-nevek, alap kid <év>f; --kid; kizárások', () => {
    const r = capture(() => keysMain(['--keypair', 'elearning', '--content']));
    const f = fields(r.out);
    expect(f.MEDIA_SERVER_CONTENT_KEY_ID).toBe(defaultKid(true, new Date(), true));
    expect(publicKeyOf(f.MEDIA_SERVER_CONTENT_PRIVATE_KEY!)).toBe(f.publicKey);
    expect(f.fajta).toBe('tartalom');
    expect(r.out).toContain(' --content --write <apps.json>');
    expect(fields(capture(() => keysMain(['--keypair', 'elearning', '--kid', 'k1'])).out).MEDIA_SERVER_KEY_ID).toBe('k1');
    expect(capture(() => keysMain(['--keypair', 'elearning', '--write', tmpFile('a.json')])).err).toMatch(/fájlt nem ír/);
    expect(capture(() => keysMain(['--keypair', '--register', 'elearning'])).err).toMatch(/kizárja/);
    expect(capture(() => keysMain(['--keypair', 'rossz/app'])).err).toMatch(/érvénytelen app-név/);
    expect(capture(() => keysMain(['elearning', '--public-key', 'x'])).err).toMatch(/csak a --register-rel/);
  });
});

describe('media-keys --register (ES256, üzemeltető)', () => {
  it('hozzáad (publicKeys / contentPublicKeys), az eredmény érvényes; kid-ütközésre hiba, a fájl nem változik', () => {
    const file = tmpFile('apps.json');
    writeAppsFile(file, fixture);
    const browser = generateKeyPair();
    const content = generateKeyPair();
    const r = capture(() => keysMain(['--register', 'elearning', '--kid', '2026e', '--public-key', browser.publicKey, '--write', file]));
    expect(r.err).toBe('');
    expect(r.out).toBe(`Hozzáadva: ${file} → elearning.publicKeys.2026e (${browser.publicKey.slice(0, 8)} … ${browser.publicKey.slice(-8)})`);
    capture(() => keysMain(['--register', 'elearning', '--kid', '2026f', '--public-key', content.publicKey, '--content', '--write', file]));
    const apps = readAppsFile(file);
    expect(apps.elearning).toMatchObject({ publicKeys: { '2026e': browser.publicKey }, contentPublicKeys: { '2026f': content.publicKey } });
    expect(apps.elearning?.keys).toEqual(fixture.elearning?.keys);
    expect(validateAppsFile(apps).ok).toBe(true);
    expect(checkPublicKeys(apps)).toEqual([]);

    const before = readFileSync(file, 'utf8');
    for (const kid of ['2026e', '2026f', 't2026a', 't2026c']) {
      const again = capture(() => keysMain(['--register', 'elearning', '--kid', kid, '--public-key', generateKeyPair().publicKey, '--write', file]));
      expect(again.err).toMatch(/már létezik \(felülírás nincs/);
    }
    expect(capture(() => keysMain(['--register', 'elearning', '--kid', 'uj', '--public-key', browser.publicKey, '--write', file])).err).toMatch(
      /nyilvános kulcs már szerepel/,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('hibás kulcs → hiba a kulcs idézése nélkül; a --kid, a --public-key és a --write kötelező', () => {
    const file = tmpFile('apps.json');
    const bad = `${generateKeyPair().publicKey.slice(0, -1)}B`;
    const r = capture(() => keysMain(['--register', 'x', '--kid', 'k', '--public-key', bad, '--write', file]));
    expect(r.err).toMatch(/érvénytelen nyilvános kulcs/);
    expect(r.err).not.toContain(bad);
    const notOnCurve = `BA${'A'.repeat(84)}A`;
    expect(capture(() => keysMain(['--register', 'x', '--kid', 'k', '--public-key', notOnCurve, '--write', file])).err).toMatch(
      /érvénytelen nyilvános kulcs/,
    );
    const pk = generateKeyPair().publicKey;
    for (const args of [['--kid', 'k', '--public-key', pk], ['--public-key', pk, '--write', file], ['--kid', 'k', '--write', file]]) {
      expect(capture(() => keysMain(['--register', 'x', ...args])).err).toMatch(/kötelező/);
    }
    // Új fájl, új app: 0600, dir = --dir.
    capture(() => keysMain(['--register', 'x', '--kid', 'k', '--public-key', pk, '--dir', 'xd', '--write', file]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAppsFile(file).x).toMatchObject({ dir: 'xd', publicKeys: { k: pk } });
  });
});

describe('media-sign --env / --env-file (D117)', () => {
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
  const testLookup = appLookupFrom(testAppsFile());
  const es = testKeys.es256;
  const esEnv = {
    MEDIA_SERVER_APP: testKeys.app,
    MEDIA_SERVER_URL: 'https://media.example.test',
    MEDIA_SERVER_KEY_ID: es.kid,
    MEDIA_SERVER_PRIVATE_KEYS: JSON.stringify({ [es.kid]: es.privateKey }),
    MEDIA_SERVER_CONTENT_KEY_ID: es.contentKid,
    MEDIA_SERVER_CONTENT_PRIVATE_KEY: es.contentPrivateKey,
  };
  const hsEnv = {
    MEDIA_SERVER_APP: testKeys.app,
    MEDIA_SERVER_KEY_ID: testKeys.kid,
    MEDIA_SERVER_KEYS: JSON.stringify({ [testKeys.kid]: testKeys.key }),
    MEDIA_SERVER_CONTENT_KEY_ID: testKeys.contentKid,
    MEDIA_SERVER_CONTENT_KEY: testKeys.contentKey,
  };

  it('ES256: a link a verifySignedPath + testAppsFile ellen elfogadott (böngészős és tartalom); az alap-URL a MEDIA_SERVER_URL', () => {
    const r = capture(() => signMain(['--env', 'l/a.mp4', '--u', 'u1'], esEnv));
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^https:\/\/media\.example\.test\/bcdn_token=ES256-[A-Za-z0-9_-]{86}&kid=2026e&token_path=%2Ftest-app%2Fl%2F&u=u1&expires=\d+\/test-app\/l\/a\.mp4$/);
    expect(verifySignedPath(path(r.out), testLookup, Math.floor(Date.now() / 1000))).toMatchObject({ ok: true, kid: es.kid, u: 'u1' });
    const c = capture(() => signMain(['--env', '_content/v1.json.gz', '--content', '--base', 'http://x.test'], esEnv));
    expect(c.out.startsWith('http://x.test/bcdn_token=ES256-')).toBe(true);
    expect(verifySignedPath(path(c.out), testLookup, Math.floor(Date.now() / 1000))).toMatchObject({ ok: true, kind: 'content' });
    expect(r.out).not.toContain(es.privateKey);
  });

  it('HMAC: ugyanabból a bemenetből ugyanaz az URL, mint az --apps-módban', () => {
    const NOW_E = 1_795_431_700;
    const fromEnv = signingFromEnv(hsEnv, false);
    const { app, base: _base, ...signing } = fromEnv;
    expect(signUrl({ ...signing, app, assetKey: 'l/a.mp4', u: 'u1', now: NOW_E })).toBe(
      signUrl({ apps: testAppsFile(), app: testKeys.app, assetKey: 'l/a.mp4', u: 'u1', now: NOW_E }),
    );
    const c = signingFromEnv(hsEnv, true);
    expect(signUrl({ ...c, base: undefined, assetKey: '_content/v.json.gz', content: true, now: NOW_E })).toBe(
      signUrl({ apps: testAppsFile(), app: testKeys.app, assetKey: '_content/v.json.gz', content: true, now: NOW_E }),
    );
    const file = tmpFile('apps.json');
    writeAppsFile(file, testAppsFile());
    const viaApps = capture(() => signMain(['--apps', file, testKeys.app, 'l/a.mp4', '--ttl', '600']));
    const viaEnv = capture(() => signMain(['--env', 'l/a.mp4', '--ttl', '600'], hsEnv));
    // Az óra a két hívás között léphet: az expires-t kivéve azonos.
    expect(viaEnv.out.replace(/HS256-[^&]+|expires=\d+/g, '')).toBe(viaApps.out.replace(/HS256-[^&]+|expires=\d+/g, ''));
    expect(verifySignedPath(path(viaEnv.out), testLookup, Math.floor(Date.now() / 1000)).ok).toBe(true);
  });

  it('--env-file: dotenv-fájlból, a folyamat környezete nélkül', () => {
    const file = tmpFile('.env');
    writeFileSync(file, Object.entries(esEnv).map(([k, v]) => `${k}='${v}'`).join('\n'));
    const r = capture(() => signMain(['--env-file', file, 'l/a.mp4'], {}));
    expect(r.err).toBe('');
    expect(verifySignedPath(path(r.out), testLookup, Math.floor(Date.now() / 1000))).toMatchObject({ ok: true, kid: es.kid });
  });

  it('hibák a kulcs idézése nélkül: hiányzó változó, hibás titkos kulcs, hibás JSON, kid mindkét térképben; kizárások', () => {
    const err = (env: Record<string, string>, args: string[] = ['--env', 'l/a.mp4']) => capture(() => signMain(args, env)).err;
    const { MEDIA_SERVER_APP: _a, ...noApp } = esEnv;
    expect(err(noApp)).toMatch(/hiányzik a MEDIA_SERVER_APP/);
    const { MEDIA_SERVER_KEY_ID: _k, ...noKid } = esEnv;
    expect(err(noKid)).toMatch(/hiányzik a MEDIA_SERVER_KEY_ID/);
    const { MEDIA_SERVER_PRIVATE_KEYS: _p, ...noKeys } = esEnv;
    expect(err(noKeys)).toMatch(/hiányzik a MEDIA_SERVER_KEYS vagy a MEDIA_SERVER_PRIVATE_KEYS/);
    expect(err({ ...esEnv, MEDIA_SERVER_KEY_ID: 'nincs' })).toMatch(/nincs sem a MEDIA_SERVER_KEYS-ben/);
    const badKey = `${es.privateKey.slice(0, 40)}xx${es.privateKey.slice(42)}`;
    const bad = err({ ...esEnv, MEDIA_SERVER_PRIVATE_KEYS: JSON.stringify({ [es.kid]: badKey }) });
    expect(bad).toMatch(/érvénytelen titkos kulcs/);
    expect(bad).not.toContain(badKey.slice(0, 20));
    const badJson = err({ ...esEnv, MEDIA_SERVER_PRIVATE_KEYS: `{"${es.kid}": "${es.privateKey}"` });
    expect(badJson).toMatch(/nem érvényes JSON/);
    expect(badJson).not.toContain(es.privateKey.slice(0, 20));
    expect(err({ ...esEnv, MEDIA_SERVER_KEYS: JSON.stringify({ [es.kid]: testKeys.key }) })).toMatch(/is szerepel/);
    const both = err({ ...esEnv, MEDIA_SERVER_CONTENT_KEY: testKeys.contentKey }, ['--env', '_content/v.json.gz', '--content']);
    expect(both).toMatch(/csak az egyik/);
    expect(both).not.toContain(testKeys.contentKey);
    expect(err(esEnv, ['--env', '_content/v.json.gz', '--content', '--kid', 'mas'])).toMatch(/csak a MEDIA_SERVER_CONTENT_KEY_ID/);
    expect(err(esEnv, ['--env', '--apps', 'x.json', 'l/a.mp4'])).toMatch(/kizárja egymást/);
    expect(err(esEnv, ['--env', '--env-file', 'x', 'l/a.mp4'])).toMatch(/kizárja egymást/);
    const usage = capture(() => signMain(['--env', testKeys.app, 'l/a.mp4'], esEnv));
    expect([usage.code, usage.err.startsWith('Használat: media-sign')]).toEqual([2, true]);
  });

  it('App-regisztráció, próbalépés: a --env-file linkje a hamis szerveren 200 (HS256 és ES256, böngészős és tartalom)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'media-sdk-probe-'));
    mkdirSync(join(root, 'l'));
    mkdirSync(join(root, '_content'));
    writeFileSync(join(root, 'l', 'a.mp4'), 'mp4');
    writeFileSync(join(root, '_content', 'v1.json.gz'), 'gz');
    const fake = await startFakeMediaServer({ apps: testAppsFile(), root });
    try {
      for (const env of [hsEnv, esEnv]) {
        const file = tmpFile('.env');
        writeFileSync(file, Object.entries({ ...env, MEDIA_SERVER_URL: fake.url }).map(([k, v]) => `${k}='${v}'`).join('\n'));
        for (const args of [['l/a.mp4'], ['_content/v1.json.gz', '--content']]) {
          const r = capture(() => signMain(['--env-file', file, ...args], {}));
          expect(r.err).toBe('');
          expect(r.out.startsWith(`${fake.url}/bcdn_token=`)).toBe(true);
          expect((await fetch(r.out)).status).toBe(200);
        }
      }
      // Egy, az üzemeltetőnél nem regisztrált kid linkje nem megy át: a próba ezt mutatja meg.
      const other = generateKeyPair();
      const unregistered = { ...esEnv, MEDIA_SERVER_URL: fake.url, MEDIA_SERVER_PRIVATE_KEYS: JSON.stringify({ masik: other.privateKey }), MEDIA_SERVER_KEY_ID: 'masik' };
      const r = capture(() => signMain(['--env', 'l/a.mp4'], unregistered));
      expect((await fetch(r.out)).status).toBe(403);
      expect(fake.requests.at(-1)?.verify).toMatchObject({ ok: false, reason: 'unknown-kid' });
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kulcsforgatás az app oldalán: két kid az env-ben, a MEDIA_SERVER_KEY_ID választ; HS256 → ES256; a régi kid törlése után 403 unknown-kid', () => {
    const now = Math.floor(Date.now() / 1000);
    const oldKid = testKeys.kid;
    const newKey = generateKey();
    const apps = testAppsFile();
    apps[testKeys.app]!.keys['2027a'] = newKey;
    const sign = (env: Record<string, string>, args: string[] = []) => capture(() => signMain(['--env', 'l/a.mp4', ...args], env)).out;
    const check = (a: AppsFile, url: string) => verifySignedPath(path(url), appLookupFrom(a), now);

    // HS256 → HS256: a régi és az új kulcs együtt, az új az aktív; a régi --kid-del még aláírható.
    const hs = { ...hsEnv, MEDIA_SERVER_KEYS: JSON.stringify({ [oldKid]: testKeys.key, '2027a': newKey }), MEDIA_SERVER_KEY_ID: '2027a' };
    const fresh = sign(hs);
    const old = sign(hs, ['--kid', oldKid]);
    expect(fresh).toContain('&kid=2027a&');
    expect(check(apps, fresh)).toMatchObject({ ok: true, kid: '2027a' });
    expect(check(apps, old)).toMatchObject({ ok: true, kid: oldKid });

    // HS256 → ES256: a régi HMAC-kulcs a MEDIA_SERVER_KEYS-ben marad, az új ES256-kid a MEDIA_SERVER_PRIVATE_KEYS-ben.
    const mixed = { ...hsEnv, MEDIA_SERVER_PRIVATE_KEYS: JSON.stringify({ [es.kid]: es.privateKey }), MEDIA_SERVER_KEY_ID: es.kid };
    const esLink = sign(mixed);
    expect(esLink).toContain('bcdn_token=ES256-');
    expect(sign(mixed, ['--kid', oldKid])).toContain('bcdn_token=HS256-');
    expect(check(apps, esLink)).toMatchObject({ ok: true, kid: es.kid });

    // Az üzemeltető törli a régi kid-et: a vele aláírt link 403 unknown-kid, az újak maradnak.
    delete apps[testKeys.app]!.keys[oldKid];
    expect(check(apps, old)).toMatchObject({ ok: false, status: 403, reason: 'unknown-kid' });
    expect(check(apps, fresh).ok).toBe(true);
    expect(check(apps, esLink).ok).toBe(true);
  });

  it('--apps módban egy ES256 kid-re érthető hiba (az app írja alá, --env)', () => {
    const apps = testAppsFile();
    expect(() => signUrl({ apps, app: testKeys.app, assetKey: 'l/a.mp4', kid: es.kid })).toThrow(/aszimmetrikus kid \(2026e, publicKeys\): az app írja alá, --env/);
    expect(() => signUrl({ apps, app: testKeys.app, assetKey: '_content/v.json.gz', content: true, kid: es.contentKid })).toThrow(
      /aszimmetrikus kid \(2026f, contentPublicKeys\)/,
    );
    const onlyEs: AppsFile = { e: { dir: '.', keys: {}, contentKeys: {}, publicKeys: { [es.kid]: es.publicKey } } };
    expect(() => signUrl({ apps: onlyEs, app: 'e', assetKey: 'l/a.mp4' })).toThrow(/aszimmetrikus kid/);
  });
});
