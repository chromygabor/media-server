import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appLookupFrom,
  base64url,
  buildSignedPath,
  parseSignedPath,
  signToken,
  timingSafeEqualStr,
  verifySignedPath,
} from './token.js';

// CSAK TESZT kulcsok.
const KEY = 'CSAK-TESZT-kulcs-elearning-2026a';
const CKEY = 'CSAK-TESZT-kulcs-elearning-2026c';
const E = 1795435200;
const U = '0b7d3c1e-5f2a-4c8e-9a61-2f4d8e7b1c90';
const DIR = '/elearning/t/lessons/ch-01-l01/';
const FILE = `${DIR}m01.720p.mp4`;
const CFILE = '/elearning/_content/2026.11.23-1.json.gz';
const apps = appLookupFrom({ elearning: { keys: { '2026a': KEY }, contentKeys: { '2026c': CKEY } } });

describe('base64url, timingSafeEqualStr', () => {
  it('base64url: +/ → -_, kitöltés nélkül', () => {
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(base64url(new Uint8Array(0))).toBe('');
  });
  it('timingSafeEqualStr', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'ab')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('signToken (terv 4.1)', () => {
  it('üzenet = token_path + expires + rendezett, kódolatlan signing_data (a token_path-szal)', () => {
    const expected = createHmac('sha256', KEY)
      .update(`${DIR}${E}kid=2026a&token_path=${DIR}&u=${U}`)
      .digest('base64url');
    expect(signToken({ key: KEY, tokenPath: DIR, expires: E, params: { kid: '2026a', u: U } })).toBe(`HS256-${expected}`);
  });
  it('u nélkül nincs u= a signing_data-ban', () => {
    const expected = createHmac('sha256', CKEY).update(`${CFILE}${E}kid=2026c&token_path=${CFILE}`).digest('base64url');
    expect(signToken({ key: CKEY, tokenPath: CFILE, expires: E, params: { kid: '2026c' } })).toBe(`HS256-${expected}`);
  });
  it.each([
    ['üres kulcs', { key: '', tokenPath: DIR, expires: E, params: { kid: 'a' } }],
    ['üres token_path', { key: KEY, tokenPath: '', expires: E, params: { kid: 'a' } }],
    ['tört expires', { key: KEY, tokenPath: DIR, expires: 1.5, params: { kid: 'a' } }],
    ['negatív expires', { key: KEY, tokenPath: DIR, expires: -1, params: { kid: 'a' } }],
    ['kid &-tel', { key: KEY, tokenPath: DIR, expires: E, params: { kid: 'a&u=x' } }],
    ['u =-vel', { key: KEY, tokenPath: DIR, expires: E, params: { kid: 'a', u: 'x=y' } }],
    ['üres kid', { key: KEY, tokenPath: DIR, expires: E, params: { kid: '' } }],
  ])('elutasít: %s', (_n, input) => expect(() => signToken(input)).toThrow(RangeError));
});

describe('buildSignedPath', () => {
  it('Bunny directory-alak: kódolt értékek, expires a szegmens végén, utána az útvonal', () => {
    const p = buildSignedPath({ key: KEY, kid: '2026a', u: U, tokenPath: DIR, expires: E, path: FILE });
    const t = signToken({ key: KEY, tokenPath: DIR, expires: E, params: { kid: '2026a', u: U } });
    expect(p).toBe(
      `/bcdn_token=${t}&kid=2026a&token_path=%2Felearning%2Ft%2Flessons%2Fch-01-l01%2F&u=${U}&expires=${E}${FILE}`,
    );
  });
  it.each([
    ['nem kiszolgálható útvonal', { tokenPath: DIR, path: `${FILE}.build.json` }],
    ['nem biztonságos útvonal', { tokenPath: DIR, path: `${DIR}../x.mp4` }],
    ['böngészős token_path nem könyvtár', { tokenPath: FILE, path: FILE }],
    ['token_path kívül', { tokenPath: '/elearning/t/lessons/ch-01-l02/', path: FILE }],
    ['token_path másik appé', { tokenPath: '/masik/', path: FILE }],
    ['tartalom: könyvtár-token_path', { tokenPath: '/elearning/_content/', path: CFILE, kid: '2026c', u: undefined }],
    ['tartalom: u-val', { tokenPath: CFILE, path: CFILE, kid: '2026c' }],
  ])('elutasít: %s', (_n, over) => {
    expect(() => buildSignedPath({ key: KEY, kid: '2026a', u: U, expires: E, ...over })).toThrow(RangeError);
  });
});

describe('parseSignedPath', () => {
  const good = buildSignedPath({ key: KEY, kid: '2026a', u: U, tokenPath: DIR, expires: E, path: FILE });
  it('szétszedi és dekódolja', () => {
    expect(parseSignedPath(good)).toEqual({
      token: signToken({ key: KEY, tokenPath: DIR, expires: E, params: { kid: '2026a', u: U } }),
      params: { kid: '2026a', token_path: DIR, u: U },
      expires: E,
      path: FILE,
    });
  });
  it('a query-t levágja', () => {
    expect(parseSignedPath(`${good}?a=b/c`)).toMatchObject({ path: FILE });
  });
  it('a paraméterek sorrendje nem kötött (az aláírás rendez)', () => {
    const swapped = good.replace(/&kid=2026a(&token_path=[^&]*)/, '$1&kid=2026a');
    expect(verifySignedPath(swapped, apps, E).ok).toBe(true);
  });
  it.each([
    ['/elearning/x.mp4', 'missing-token'],
    ['/bcdn_token=HS256-x', 'malformed'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}/e/x.mp4`, 'malformed'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a&token_path=%2Fe%2F&expires=1&x/e/x.mp4`, 'malformed-expires'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a&token_path=%2Fe%2F&expires=/e/x.mp4`, 'malformed-expires'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'malformed'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'malformed-param'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a&token_path=%E0%A4%A&expires=1/e/x.mp4`, 'malformed-param'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a%20b&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'malformed-param'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a&expires=1/e/x.mp4`, 'missing-param'],
    [`/bcdn_token=HS256-${'a'.repeat(44)}&kid=a&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'malformed-token'],
    [`/bcdn_token=HS512-${'a'.repeat(43)}&kid=a&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'malformed-token'],
    [`/bcdn_token=HS256-${'a'.repeat(43)}&kid=a&token_ignore_params=true&token_path=%2Fe%2F&expires=1/e/x.mp4`, 'unknown-param'],
  ])('%s → %s', (uri, error) => expect(parseSignedPath(uri)).toEqual({ error }));
});

describe('verifySignedPath (terv 4.4 sorrend)', () => {
  const good = buildSignedPath({ key: KEY, kid: '2026a', u: U, tokenPath: DIR, expires: E, path: FILE });
  it('elfogad, és visszaadja a naplózandó mezőket', () => {
    expect(verifySignedPath(good, apps, E - 10)).toEqual({
      ok: true,
      app: 'elearning',
      kid: '2026a',
      u: U,
      path: FILE,
      assetKey: 't/lessons/ch-01-l01/m01.720p.mp4',
      kind: 'browser',
      contentType: 'video/mp4',
    });
  });
  it('tartalomtoken', () => {
    const c = buildSignedPath({ key: CKEY, kid: '2026c', tokenPath: CFILE, expires: E, path: CFILE });
    expect(verifySignedPath(c, apps, E)).toMatchObject({ ok: true, kind: 'content', contentType: 'application/gzip', u: undefined });
  });
  it('410 csak hiteles tokenre; a lejárat után is 403 a hamisra', () => {
    expect(verifySignedPath(good, apps, E + 1)).toEqual({ ok: false, status: 410, reason: 'expired' });
    const forged = good.replace(U, U.replace('0', '1'));
    expect(verifySignedPath(forged, apps, E + 1)).toEqual({ ok: false, status: 403, reason: 'bad-signature' });
  });
  it('a kulcskereső saját mezőt néz (prototípus nem kulcs)', () => {
    const proto = buildSignedPath({ key: KEY, kid: 'toString', u: U, tokenPath: DIR, expires: E, path: FILE });
    expect(verifySignedPath(proto, apps, E)).toMatchObject({ status: 403, reason: 'unknown-kid' });
  });
  it('üres kulcs az apps-ban nem kulcs', () => {
    const empty = appLookupFrom({ elearning: { keys: { '2026a': '' }, contentKeys: {} } });
    expect(verifySignedPath(good, empty, E)).toMatchObject({ status: 403, reason: 'unknown-kid' });
  });
});
