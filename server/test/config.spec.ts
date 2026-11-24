// A konfigfájlok összhangja (implementációs terv WP2 7.; csomagterv WP32, WP33): a kiterjesztés-tábla, a kulcs-regexek
// és az apps.json-validálás a `@chromygabor/media-sdk`-é (a backend is onnan importál); a compose minden változója a
// .env.example-ben; rögzített image; a napló nem tartalmazhat tokent.

import { readFileSync } from 'node:fs';
import {
  CONTENT_FILE_TYPE,
  KEY_ID_RE,
  KEY_RE,
  MEDIA_CONTENT_TYPES,
  PUBLIC_KEY_RE,
  isValidKey,
  isValidKeyId,
  isValidPublicKey,
} from '@chromygabor/media-sdk';
import { generateKeyPair, validateAppsFile } from '@chromygabor/media-sdk/apps-config';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import media from '../njs/media.js';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const compose = read('compose.yaml');
const envExample = read('.env.example');
const nginxConf = read('nginx/nginx.conf');
const mediaConf = read('nginx/media.conf');

describe('kiterjesztés-tábla', () => {
  it('njs = media-sdk', () => {
    expect(media.MEDIA_CONTENT_TYPES).toEqual(MEDIA_CONTENT_TYPES);
  });

  it('az nginx types táblája pontosan ezeket és a .gz-t adja', () => {
    const block = /types\s*\{([^}]*)\}/.exec(nginxConf)?.[1] ?? '';
    const table = Object.fromEntries(
      block
        .split(';')
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length === 2)
        .map(([type, ext]) => [`.${ext}`, type]),
    );
    expect(table).toEqual({ ...MEDIA_CONTENT_TYPES, '.gz': CONTENT_FILE_TYPE });
  });
});

describe('kulcs-regexek: njs = media-sdk', () => {
  const njsSource = read('njs/media.js');
  /** Az njs `var <név> = /…/<flagek>;` sorának regex-literálja, betű szerint (az njs ezeket nem exportálja). */
  const njsRegexLiteral = (name: string): string => {
    const m = new RegExp(`^var ${name} = (/.+/[a-z]*);$`, 'm').exec(njsSource);
    expect(m, name).not.toBeNull();
    return m?.[1] as string;
  };

  it('a KEY_ID_RE az njs ID_RE-je, a KEY_RE az njs KEY_RE-je, a PUBLIC_KEY_RE az njs PUBLIC_KEY_RE-je, bájtra', () => {
    expect(njsRegexLiteral('ID_RE')).toBe(String(KEY_ID_RE));
    expect(njsRegexLiteral('KEY_RE')).toBe(String(KEY_RE));
    expect(njsRegexLiteral('PUBLIC_KEY_RE')).toBe(String(PUBLIC_KEY_RE));
    expect(njsRegexLiteral('PUBLIC_KEY_RE')).toBe('/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/');
  });

  it('property: validateApps nyilvánoskulcs-hibája = !isValidPublicKey (valódi kulcsok és egy jel átírásai)', () => {
    const real = Array.from({ length: 8 }, () => generateKeyPair().publicKey);
    const mutated = fc.tuple(fc.constantFrom(...real), fc.nat(86), fc.constantFrom(...'ABPQgw048_-=+/a'.split(''))).map(
      ([k, i, c]) => k.slice(0, i) + c + k.slice(i + 1),
    );
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...real), mutated, fc.string({ maxLength: 90 })), (pk) => {
        const errors = media.validateApps({ app: { dir: 'app', keys: {}, contentKeys: {}, publicKeys: { e: pk } } });
        return errors.some((e) => e.includes('nem 87 jeles')) === !isValidPublicKey(pk);
      }),
      { numRuns: 500 },
    );
  });

  // Viselkedési paritás az njs `validateApps`-én át: egy kulcsbejegyzés kid- és kulcshibája pontosan akkor jelenik
  // meg, amikor a csomag validátora elutasít.
  const keyChar = fc.constantFrom(...'abcXYZ019+/_-.=& \ná'.split(''));
  const text = (maxLength: number) => fc.array(keyChar, { maxLength }).map((cs) => cs.join(''));
  const errorsFor = (kid: string, key: string): string[] =>
    media.validateApps({ app: { dir: 'app', keys: { [kid]: key }, contentKeys: {} } });

  it('property: validateApps kid- és kulcshibája = !isValidKeyId / !isValidKey', () => {
    fc.assert(
      fc.property(fc.oneof(text(140), fc.constant('t2026a')), fc.oneof(text(60), fc.constant('a'.repeat(43))), (kid, key) => {
        const errors = errorsFor(kid, key);
        const kidError = errors.some((e) => e.includes('érvénytelen kid'));
        const keyError = errors.some((e) => e.includes('a kulcs nem legalább 43 jeles'));
        return kidError === !isValidKeyId(kid) && keyError === !isValidKey(key);
      }),
    );
  });
});

describe('apps.json-validálás: njs validateApps = media-sdk validateAppsFile (P8)', () => {
  const fixture: unknown = JSON.parse(read('test/fixtures/apps.test.json'));
  /** Az njs és a csomag eredménye: elfogadás/elutasítás és a hibák száma (a szövegben a csomag kulcsot nem idéz). */
  const both = (apps: unknown) => {
    const njs = media.validateApps(apps);
    const sdk = validateAppsFile(apps);
    return { njs: njs.length, sdk: sdk.ok ? 0 : sdk.errors.length };
  };
  const same = (apps: unknown): boolean => {
    const r = both(apps);
    return r.njs === r.sdk;
  };

  it('a teszt-fixture mindkettőnek érvényes', () => {
    expect(both(fixture)).toEqual({ njs: 0, sdk: 0 });
  });

  const K = 'A'.repeat(43);
  const PK = generateKeyPair().publicKey;
  const PK2 = generateKeyPair().publicKey;
  const app = (patch: Record<string, unknown> = {}) => ({ dir: 'app1', keys: { a: K }, contentKeys: { c: K }, ...patch });
  const fx = fixture as Record<string, Record<string, unknown>>;
  const variants: [string, unknown][] = [
    ['nem objektum gyökér', []],
    ['null gyökér', null],
    ['szöveg gyökér', 'apps'],
    ['üres', {}],
    ['_-os app-név', { ...fx, _x: fx.masik }],
    ['.-os app-név', { '.x': app() }],
    ['/ az app-névben', { 'a/b': app() }],
    ['app null', { app1: null }],
    ['app tömb', { app1: [] }],
    ['dir ..', { app1: app({ dir: '../x' }) }],
    ['dir abszolút', { app1: app({ dir: '/srv' }) }],
    ['dir üres', { app1: app({ dir: '' }) }],
    ['dir hiányzik', { app1: app({ dir: undefined }) }],
    ['dir szám', { app1: app({ dir: 1 }) }],
    ['dir záró /', { app1: app({ dir: 'a/' }) }],
    ['dir .-os szegmens', { app1: app({ dir: 'a/.b' }) }],
    ['rövid kulcs', { app1: app({ keys: { a: 'rovid' } }) }],
    ['nem szöveg kulcs', { app1: app({ keys: { a: 42 } }) }],
    ['három =', { app1: app({ keys: { a: `${K}===` } }) }],
    ['kid-ütközés', { app1: app({ keys: { a: K }, contentKeys: { a: K } }) }],
    // P16 (javítási terv WP39): a `__proto__` kid saját mezőként (JSON.parse) mindkét térképben; az njs kid-halmaza
    // prototípus nélküli, különben a `kids['__proto__'] = true` a prototípust állítaná, és az ütközés elveszne.
    ['__proto__ kid-ütközés', JSON.parse(`{"app1":{"dir":"app1","keys":{"__proto__":"${K}"},"contentKeys":{"__proto__":"${K}"}}}`)],
    ['érvénytelen kid', { app1: app({ keys: { 'a&b': K } }) }],
    ['túl hosszú kid', { app1: app({ keys: { ['k'.repeat(129)]: K } }) }],
    ['hiányzó keys', { app1: app({ keys: undefined }) }],
    ['hiányzó contentKeys', { app1: app({ contentKeys: undefined }) }],
    ['keys tömb', { app1: app({ keys: [] }) }],
    ['origins nem tömb', { app1: app({ origins: 'https://a.b' }) }],
    ['origin *', { app1: app({ origins: ['*'] }) }],
    ['origin útvonallal', { app1: app({ origins: ['https://a.b/x'] }) }],
    ['origin záró /', { app1: app({ origins: ['https://a.b/'] }) }],
    ['origin szám', { app1: app({ origins: [1] }) }],
    ['origin hosszú port', { app1: app({ origins: ['http://a:123456'] }) }],
    ['corp', { app1: app({ corp: 'any' }) }],
    ['corp null', { app1: app({ corp: null }) }],
    ['több hiba egyszerre', { _a: app({ dir: '', keys: { 'x y': 'r' }, origins: ['*', 2], corp: 1 }), b: 3 }],
    ['a fixture egy appja elrontva', { ...fx, elearning: { ...fx.elearning, contentKeys: fx.elearning?.keys } }],
    // ES256 (aszimmetrikus terv 3.2): a két elhagyható térkép.
    ['publicKeys tömb', { app1: app({ publicKeys: [] }) }],
    ['contentPublicKeys null', { app1: app({ contentPublicKeys: null }) }],
    ['publicKeys szöveg', { app1: app({ publicKeys: 'x' }) }],
    ['nyilvános kulcs rossz alakú', { app1: app({ publicKeys: { e: PK.slice(1) } }) }],
    ['nyilvános kulcs szám', { app1: app({ publicKeys: { e: 7 } }) }],
    ['nyilvános kulcs HMAC-kulcs', { app1: app({ contentPublicKeys: { f: K } }) }],
    ['kid-ütközés keys és publicKeys', { app1: app({ publicKeys: { a: PK } }) }],
    ['kid-ütközés contentKeys és contentPublicKeys', { app1: app({ contentPublicKeys: { c: PK } }) }],
    ['kid-ütközés a két nyilvános térkép', { app1: app({ publicKeys: { e: PK }, contentPublicKeys: { e: PK2 } }) }],
    ['ugyanaz a nyilvános kulcs mindkét fajtában', { app1: app({ publicKeys: { e: PK }, contentPublicKeys: { f: PK } }) }],
    ['ismétlés és rossz kid egyszerre', { app1: app({ publicKeys: { e: PK, 'x y': 'r' }, contentPublicKeys: { e: PK, f: PK } }) }],
    ['__proto__ kid a keys-ben és a publicKeys-ben', JSON.parse(`{"app1":{"dir":"a","keys":{"__proto__":"${K}"},"contentKeys":{},"publicKeys":{"__proto__":"${PK}"}}}`)],
  ];

  it.each(variants)('%s → mindkettő elutasítja, ugyanannyi hibával', (_n, apps) => {
    const r = both(apps);
    expect(r.njs).toBeGreaterThan(0);
    expect(r.sdk).toBe(r.njs);
  });

  it('__proto__ kid a keys-ben és a contentKeys-ben: mindkettő pontosan egy hibát ad (P16)', () => {
    const apps: unknown = JSON.parse(`{"app1":{"dir":"app1","keys":{"__proto__":"${K}"},"contentKeys":{"__proto__":"${K}"}}}`);
    expect(both(apps)).toEqual({ njs: 1, sdk: 1 });
  });

  it('engedett változatok: dir "." és több szegmens, közös dir, üres kulcstérképek, origins / corp nélkül', () => {
    for (const apps of [
      { app1: app({ dir: '.' }) },
      { app1: app({ dir: 'a/b' }) },
      { app1: app(), app2: app() },
      { app1: app({ keys: {}, contentKeys: {}, origins: ['http://localhost:3000', 'https://a.b:8443'], corp: 'cross-origin' }) },
      { app1: app({ publicKeys: { e: PK }, contentPublicKeys: { f: PK2 } }) },
      { app1: app({ keys: {}, contentKeys: {}, publicKeys: {}, contentPublicKeys: {} }) },
      { app1: app({ publicKeys: undefined, contentPublicKeys: undefined }) },
    ]) {
      expect(both(apps)).toEqual({ njs: 0, sdk: 0 });
    }
  });

  it('property: véletlen apps.json-on ugyanaz az elfogadás és a hibák száma', () => {
    const pick = <T>(...xs: T[]) => fc.constantFrom(...xs);
    const name = fc.oneof(pick('app1', 'elearning-dev', 'a.b', '_x', '.x', 'a/b', '', 'x y'), fc.string({ maxLength: 6 }));
    const kid = fc.oneof(pick('a', '2026a', 't.1_-', 'a&b', '', 'k'.repeat(129), '__proto__x'), fc.string({ maxLength: 4 }));
    const key = fc.oneof(pick(K, `${K}==`, `${K}===`, 'rovid', `${'+/_-'.repeat(11)}`), fc.string({ maxLength: 50 }), fc.integer(), fc.constant(null));
    const keyMap = fc.oneof(fc.dictionary(kid, key, { maxKeys: 3 }), pick<unknown>(undefined, null, [], 'x'));
    const publicKey = fc.oneof(pick<unknown>(PK, PK2, PK.slice(1), `${PK.slice(0, -1)}B`, K, 7, null), fc.string({ maxLength: 4 }));
    const publicMap = fc.oneof(fc.dictionary(kid, publicKey, { maxKeys: 3 }), pick<unknown>(undefined, null, [], 'x'));
    const origin = fc.oneof(pick<unknown>('https://a.b', 'http://localhost:3000', 'https://a.b/', '*', 'ftp://a.b', 'http://a:123456', 1, null), fc.string({ maxLength: 8 }));
    const entry = fc.record(
      {
        dir: fc.oneof(pick<unknown>('.', 'app1', 'a/b', '', '..', '/srv', 'a/', '_c', 1), fc.string({ maxLength: 5 })),
        keys: keyMap,
        contentKeys: keyMap,
        publicKeys: publicMap,
        contentPublicKeys: publicMap,
        origins: fc.oneof(fc.array(origin, { maxLength: 3 }), pick<unknown>('https://a.b', null)),
        corp: fc.oneof(pick<unknown>('same-site', 'same-origin', 'cross-origin', 'any', null, 1)),
      },
      { requiredKeys: [] },
    );
    const shared = fc.dictionary(kid, fc.constant(K), { maxKeys: 2 });
    const apps = fc.oneof(
      fc.dictionary(name, fc.oneof(entry, pick<unknown>(null, [], 'x')), { maxKeys: 3 }),
      // Közös kid a két térképben (ütközés) és a jó eset gyakrabban.
      fc.tuple(name, shared).map(([n, m]) => ({ [n]: { dir: 'd', keys: m, contentKeys: m } })),
      pick<unknown>(fixture, [], null, 'x'),
    );
    fc.assert(fc.property(apps, same), { numRuns: 1000 });
  });
});

describe('a kapu a konfigban (D112, D116; aszimmetrikus terv 4.)', () => {
  const block = (name: string): string => {
    const start = mediaConf.indexOf(`location ${name} {`);
    expect(start, name).toBeGreaterThan(-1);
    return mediaConf.slice(start, mediaConf.indexOf('\n    }', start));
  };

  it('a döntés js_var-okban; js_set csak a token nélküli útvonal', () => {
    for (const v of ['status', 'reason', 'file', 'app', 'kid', 'u', 'user_key', 'kind']) {
      expect(mediaConf).toMatch(new RegExp(`^js_var\\s+\\$media_${v};$`, 'm'));
    }
    expect([...mediaConf.matchAll(/^js_set\s+(\$\w+)\s+(\S+);$/gm)].map((m) => [m[1], m[2]])).toEqual([['$media_path', 'media.path']]);
  });

  it('a fő location: OPTIONS 204, 405, a kapu js_content-je; korlát és try_files csak a @serve-ben', () => {
    const main = block('/');
    expect(main).toMatch(/js_content\s+media\.gate;/);
    expect(main).toMatch(/js_header_filter\s+media\.headers;/);
    expect(main).not.toMatch(/limit_conn|limit_rate|try_files|limit_req/);
    const serve = block('@serve');
    for (const d of [/limit_conn\s+media_user\s+3;/, /limit_conn\s+media_app\s+40;/, /limit_rate_after\s+30m;/, /limit_rate\s+600k;/, /try_files\s+\$media_file\s+=404;/, /js_header_filter\s+media\.headers;/]) {
      expect(serve).toMatch(d);
    }
    expect(serve).not.toMatch(/limit_req/);
  });

  it('@toomany: 429 "too many requests", no-store, nosniff, a @denied mintájára; error_page 429', () => {
    expect(mediaConf).toMatch(/^\s+error_page\s+429\s+= @toomany;$/m);
    const t = block('@toomany');
    expect(t).toMatch(/return\s+429\s+"too many requests\\n";/);
    expect(t).toMatch(/add_header\s+X-Content-Type-Options\s+nosniff\s+always;/);
    expect(t).toMatch(/add_header\s+Cache-Control\s+no-store\s+always;/);
    expect(block('@denied')).toMatch(/limit_req\s+zone=media_denied\s+burst=20\s+nodelay;/);
  });

  it('a hibaszámláló zónája az nginx.conf-ban, a neve a media.js-é; a küszöb és az ablak njs-konstans', () => {
    expect(nginxConf).toMatch(/^\s+js_shared_dict_zone\s+zone=media_fails:1m\s+type=number\s+timeout=10s\s+evict;$/m);
    const njsSource = read('njs/media.js');
    expect(njsSource).toMatch(/^var FAILS_ZONE = 'media_fails';$/m);
    expect([media.FAILS_LIMIT, media.FAILS_WINDOW_MS]).toEqual([50, 10_000]);
    expect(njsSource).toContain('zone.incr(ip, 1, 0, FAILS_WINDOW_MS)');
    // A WebCryptót elfedő `import crypto from 'crypto'` (terv P4) nincs.
    expect(njsSource).not.toMatch(/^import crypto from/m);
    expect(njsSource).toMatch(/^import hmacCrypto from 'crypto';$/m);
  });
});

describe('compose.yaml és .env.example', () => {
  const composeVars = [...compose.matchAll(/\$\{([A-Z_]+)[:}?-]/g)].map((m) => m[1] as string);
  const envVars = new Map(
    envExample
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );

  it('a compose minden változója a .env.example-ben', () => {
    expect(composeVars.length).toBeGreaterThan(0);
    for (const v of new Set(composeVars)) expect(envVars.has(v), v).toBe(true);
  });

  it('a compose alapértékei = a .env.example értékei (BIND, PORT, NET_*)', () => {
    for (const v of ['BIND', 'PORT', 'NET_SUBNET', 'NET_GATEWAY', 'COMPOSE_PROJECT_NAME']) {
      const def = new RegExp(`\\$\\{${v}:-([^}]+)\\}`).exec(compose)?.[1];
      expect(def, v).toBe(envVars.get(v));
    }
    expect(envVars.get('BIND')).toBe('127.0.0.1');
    expect(envVars.get('PORT')).toBe('10090');
  });

  it('a .env.example-ben nincs kulcs', () => {
    expect(envExample).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
  });

  it('rögzített image tag + digest (WP0)', () => {
    expect(compose).toMatch(/image: nginx:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}\n/);
  });

  it('csak olvasható gyökér és kötetek', () => {
    expect(compose).toMatch(/read_only: true/);
    const block = /\n {4}volumes:\n((?: {6}- .*\n)+)/.exec(compose)?.[1] ?? '';
    const mounts = block.trimEnd().split('\n');
    expect(mounts.length).toBe(4);
    for (const mnt of mounts) expect(mnt.endsWith(':ro'), mnt).toBe(true);
  });

  it('a real_ip az átjárót bízza meg (envsubst-sablon)', () => {
    expect(read('nginx/templates/realip.conf.template')).toMatch(/^set_real_ip_from\s+\$\{NET_GATEWAY\};$/m);
    expect(nginxConf).toMatch(/real_ip_header\s+X-Forwarded-For;/);
    expect(nginxConf).toMatch(/real_ip_recursive\s+off;/);
  });
});

describe('napló: token nélkül', () => {
  const logFormat = /log_format media_json[\s\S]*?';/.exec(mediaConf)?.[0] ?? '';
  it('a log_format létezik, és nem tartalmazza a nyers URI-t, a query-t vagy a kérés-sort', () => {
    expect(logFormat).toContain('$media_path');
    for (const v of ['$request_uri', '$request ', '$request"', '$args', '$query_string', '$uri', '$http_referer']) {
      expect(logFormat, v).not.toContain(v);
    }
  });
  it('a limit_* elutasítások a warn szint alatt naplóznak (a kérés-sorban token van)', () => {
    expect(nginxConf).toMatch(/error_log\s+\/dev\/stderr\s+warn;/);
    expect(mediaConf).toMatch(/limit_conn_log_level\s+info;/);
    expect(mediaConf).toMatch(/limit_req_log_level\s+info;/);
  });
});

describe('deploy: host-nginx blokk és deploy.sh (WP4)', () => {
  const host = read('deploy/host-nginx.conf.example');
  const deploy = read('deploy/deploy.sh');
  const port = /^PORT=(\d+)$/m.exec(envExample)?.[1];

  it('proxy_pass URI-rész nélkül, a .env.example portjára (különben a %2F dekódolódik)', () => {
    const passes = [...host.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1]);
    expect(passes).toEqual([`http://127.0.0.1:${port}`]);
  });

  it('a host nem naplóz tokent, nem tömörít, nem pufferel, nem cache-el', () => {
    expect(host).toMatch(/^\s*access_log off;/m);
    expect(host).toMatch(/^\s*error_log \S+ crit;/m);
    expect(host).toMatch(/^\s*gzip off;/m);
    expect(host).toMatch(/^\s*proxy_buffering off;/m);
    expect(host).toMatch(/^\s*proxy_cache off;/m);
    expect(host).toMatch(/^\s*proxy_set_header X-Forwarded-For \$remote_addr;/m);
    expect(host).toMatch(/^\s*server_name media\.example\.com;/m);
  });

  it('a deploy.sh csak a compose.yaml-t, az nginx/-t és az njs/-t szinkronizálja, sudo nélkül', () => {
    expect(deploy).toMatch(/^set -euo pipefail$/m);
    expect(deploy).toMatch(/for d in nginx njs; do/);
    expect(deploy).not.toMatch(/\bsudo\s+(?!install -d)/);
    const rsyncTargets = [...deploy.matchAll(/"\$TARGET:\$DEPLOY_DIR\/([^"]*)"/g)].map((m) => m[1]);
    expect(rsyncTargets).toEqual(['compose.yaml', '$d/']);
  });
});
