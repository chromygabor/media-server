// Az URL-aláíró (csomagterv WP34): könyvtár-token, lejárat, `?v=`, a szűrés ok-kódjai, tartalom-token; minden kiadott
// URL átmegy a `verifySignedPath`-on. Rögzített óra, CSAK TESZT kulcsok.

import { describe, expect, it } from 'vitest';
import { CONTENT_TOKEN_TTL_SECONDS, MEDIA_URL_VERSION_LENGTH, type SignResult, type UrlSignerConfig, createUrlSigner } from './signer.js';
import { appLookupFrom, parseSignedPath, verifySignedPath } from './token.js';

const NOW = 1_795_435_200; // unix-másodperc
const MAX_TTL = 3_600;
const BASE = 'https://media.example.test';
const APP = 'demo';
const KID = 't2026a';
const KEY = 'browser-test-key-0123456789abcdefghijklmnopqrstuv';
const CKID = 'c2026a';
const CKEY = 'content-test-key-0123456789abcdefghijklmnopqrstuv';
const DIR = 't/lessons/ch-01-l01/';
const USER = '0b7d3c1e-5f2a-4c8e-9a61-2f4d8e7b1c90';
const SHA = 'ab'.repeat(32);
const lookup = appLookupFrom({ [APP]: { keys: { [KID]: KEY }, contentKeys: { [CKID]: CKEY } } });

function signer(over: Partial<UrlSignerConfig> = {}, now = NOW) {
  return createUrlSigner({
    baseUrl: BASE,
    app: APP,
    kid: KID,
    key: KEY,
    maxTtlSeconds: MAX_TTL,
    contentKid: CKID,
    contentKey: CKEY,
    now: () => now * 1000 + 999, // az ezredmásodperc-rész lefelé kerekül
    ...over,
  });
}

/** A nyers kérés-URI (útvonal + query), ahogy a szerver látja. */
function uri(r: SignResult | { url: string } | { error: string }): string {
  if (!('url' in r)) throw new Error(`nincs URL: ${JSON.stringify(r)}`);
  expect(r.url.startsWith(`${BASE}/bcdn_token=`)).toBe(true);
  return r.url.slice(BASE.length);
}

describe('createUrlSigner', () => {
  it('hibás app (nem egyetlen biztonságos szegmens) → bad-scope, illetve unsafe; nem dob', () => {
    for (const app of ['', 'a/b', '.x', 'a b', '..']) {
      const s = signer({ app });
      expect(s.signDirectory({ scopeDir: DIR, userId: USER, assets: [{ assetKey: `${DIR}a.mp4` }] }).results).toEqual([{ error: 'bad-scope' }]);
      expect(s.signContentFile('v1')).toEqual({ error: 'unsafe' });
    }
  });
});

describe('createUrlSigner – signDirectory', () => {
  it('egy könyvtár-token a hatókörre: token_path = /<app>/<scopeDir>, u, kid; a szerver elfogadja', () => {
    const { results } = signer().signDirectory({
      scopeDir: DIR,
      userId: USER,
      tokenExp: NOW + 600,
      assets: [{ assetKey: `${DIR}m01.720p.mp4` }, { assetKey: `${DIR}sub/m01.audio.m4a` }, { assetKey: `${DIR}p.jpg` }],
    });
    const tokens = results.map((r) => {
      const parsed = parseSignedPath(uri(r));
      expect(parsed).toMatchObject({ params: { kid: KID, token_path: `/${APP}/${DIR}`, u: USER } });
      expect(verifySignedPath(uri(r), lookup, NOW)).toMatchObject({ ok: true, app: APP, kid: KID, u: USER, kind: 'browser' });
      return (parsed as { token: string }).token;
    });
    expect(new Set(tokens).size).toBe(1);
  });

  it('expires = min(tokenExp, most + maxTtl); tokenExp nélkül a korlát; alsó korlát nincs', () => {
    const s = signer();
    const one = (tokenExp: number | null | undefined) => s.signDirectory({ scopeDir: DIR, userId: USER, tokenExp, assets: [{ assetKey: `${DIR}a.mp4` }] });
    for (const [tokenExp, expected] of [
      [NOW + 600, NOW + 600],
      [NOW + MAX_TTL + 1, NOW + MAX_TTL],
      [null, NOW + MAX_TTL],
      [undefined, NOW + MAX_TTL],
      [NOW + 5, NOW + 5],
    ] as const) {
      const out = one(tokenExp);
      expect(out.expiresAt).toEqual(new Date(expected * 1000));
      expect(parseSignedPath(uri(out.results[0]!))).toMatchObject({ expires: expected });
    }
    const out = one(NOW + 600);
    expect(verifySignedPath(uri(out.results[0]!), lookup, NOW + 600)).toMatchObject({ ok: true });
    expect(verifySignedPath(uri(out.results[0]!), lookup, NOW + 601)).toEqual({ ok: false, status: 410, reason: 'expired' });
  });

  it('?v=<sha256 első 12 jele>, ha van sha256; az aláírásnak nem része', () => {
    const { results } = signer().signDirectory({
      scopeDir: DIR,
      userId: USER,
      tokenExp: NOW + 600,
      assets: [{ assetKey: `${DIR}a.mp4`, sha256: SHA }, { assetKey: `${DIR}a.mp4` }],
    });
    const [withV, withoutV] = results.map((r) => uri(r));
    expect(MEDIA_URL_VERSION_LENGTH).toBe(12);
    expect(withV).toBe(`${withoutV}?v=${SHA.slice(0, 12)}`);
    expect(verifySignedPath(withV!, lookup, NOW)).toMatchObject({ ok: true });
    expect(withoutV).not.toContain('?');
  });

  it('azonos bemenet és óra → bájtra azonos kimenet; a tokenExp-ig az óra sem változtat rajta', () => {
    const input = { scopeDir: DIR, userId: USER, tokenExp: NOW + 600, assets: [{ assetKey: `${DIR}a.mp4`, sha256: SHA }] };
    const a = signer().signDirectory(input);
    expect(signer().signDirectory(input)).toEqual(a);
    expect(signer({}, NOW + 300).signDirectory(input)).toEqual(a);
  });

  it('az elutasítás oka stabil kód, sorrendben: reserved, out-of-scope, unsafe, unsupported-type', () => {
    const cases: [string, SignResult][] = [
      ['_content/2026.11.23-1.json.gz', { error: 'reserved' }],
      ['_x/t/lessons/ch-01-l01/a.mp4', { error: 'reserved' }],
      ['t/lessons/ch-01-l02/m01.720p.mp4', { error: 'out-of-scope' }],
      ['t/lessons/ch-01-l011/m01.720p.mp4', { error: 'out-of-scope' }],
      [`${DIR}../ch-01-l02/m01.720p.mp4`, { error: 'unsafe' }],
      [`${DIR}.m01.720p.mp4`, { error: 'unsafe' }],
      [`${DIR}a//b.mp4`, { error: 'unsafe' }],
      [`${DIR}a%2Fb.mp4`, { error: 'unsafe' }],
      [`${DIR}`, { error: 'unsafe' }],
      [`${DIR}m01.audio.mp3`, { error: 'unsupported-type' }],
      [`${DIR}m01.json`, { error: 'unsupported-type' }],
      [`${DIR}x.json.gz`, { error: 'unsupported-type' }],
      [`${DIR}noext`, { error: 'unsupported-type' }],
    ];
    const { results } = signer().signDirectory({ scopeDir: DIR, userId: USER, tokenExp: NOW + 600, assets: cases.map(([assetKey]) => ({ assetKey })) });
    expect(results).toEqual(cases.map(([, r]) => r));
  });

  it('hibás hatókör (nincs záró /, _-os, nem biztonságos, üres) → minden elem bad-scope', () => {
    for (const scopeDir of ['t/lessons/ch-01-l01', '_content/', 't/../x/', 't//x/', '', '/']) {
      const out = signer().signDirectory({ scopeDir, userId: USER, tokenExp: NOW + 600, assets: [{ assetKey: `${scopeDir}a.mp4` }, { assetKey: 'x.mp4' }] });
      expect(out.results).toEqual([{ error: 'bad-scope' }, { error: 'bad-scope' }]);
    }
    expect(signer().signDirectory({ scopeDir: 'x', userId: USER, assets: [] }).results).toEqual([]);
  });

  it('rejected: rendben lévő útvonal, de az aláíró elutasítja a kid-et, a kulcsot, a userId-t vagy a lejáratot', () => {
    const one = (over: Partial<UrlSignerConfig>, userId = USER, tokenExp: number | null = NOW + 600) =>
      signer(over).signDirectory({ scopeDir: DIR, userId, tokenExp, assets: [{ assetKey: `${DIR}a.mp4` }] }).results;
    expect(one({ kid: 'a b' })).toEqual([{ error: 'rejected' }]);
    expect(one({ kid: '' })).toEqual([{ error: 'rejected' }]);
    expect(one({ key: '' })).toEqual([{ error: 'rejected' }]);
    expect(one({}, 'a&b')).toEqual([{ error: 'rejected' }]);
    expect(one({}, USER, 1.5)).toEqual([{ error: 'rejected' }]);
    expect(one({}, USER, -1)).toEqual([{ error: 'rejected' }]);
  });

  it('böngészős kulcs nélkül a signDirectory TypeError (programhiba, nem ok-kód)', () => {
    for (const over of [{ kid: undefined }, { key: undefined }, { maxTtlSeconds: undefined }]) {
      expect(() => signer(over).signDirectory({ scopeDir: DIR, userId: USER, assets: [] })).toThrow(TypeError);
    }
  });
});

describe('createUrlSigner – signContentFile', () => {
  it('tartalomkulccsal, fájlra szóló token_path, u nélkül, expires = most + 300; a szerver elfogadja', () => {
    const out = signer().signContentFile('2026.11.23-1');
    const path = `/${APP}/_content/2026.11.23-1.json.gz`;
    expect(CONTENT_TOKEN_TTL_SECONDS).toBe(300);
    expect(out).toMatchObject({ expiresAt: new Date((NOW + 300) * 1000) });
    const parsed = parseSignedPath(uri(out));
    expect(parsed).toMatchObject({ params: { kid: CKID, token_path: path }, expires: NOW + 300, path });
    expect((parsed as { params: { u?: string } }).params.u).toBeUndefined();
    expect(verifySignedPath(uri(out), lookup, NOW)).toMatchObject({ ok: true, kind: 'content', kid: CKID });
    expect(verifySignedPath(uri(out), lookup, NOW + 301)).toMatchObject({ ok: false, status: 410 });
    // A böngészős kulcs nem kell hozzá; az élettartam állítható.
    const own = createUrlSigner({ baseUrl: BASE, app: APP, contentKid: CKID, contentKey: CKEY, contentTtlSeconds: 60, now: () => NOW * 1000 });
    expect(parseSignedPath(uri(own.signContentFile('v1')))).toMatchObject({ expires: NOW + 60 });
  });

  it('az elutasítás oka stabil kód', () => {
    const s = signer();
    for (const v of ['', '.x', 'a/b', '../x', 'a b', 'a%2F']) expect(s.signContentFile(v)).toEqual({ error: 'unsafe' });
    expect(signer({ contentKid: 'a b' }).signContentFile('v1')).toEqual({ error: 'rejected' });
    expect(signer({ contentKey: '' }).signContentFile('v1')).toEqual({ error: 'rejected' });
  });

  it('tartalomkulcs nélkül TypeError', () => {
    expect(() => signer({ contentKid: undefined }).signContentFile('v1')).toThrow(TypeError);
    expect(() => signer({ contentKey: undefined }).signContentFile('v1')).toThrow(TypeError);
  });
});
