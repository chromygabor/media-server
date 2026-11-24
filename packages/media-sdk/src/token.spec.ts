import { createHmac, createPublicKey, generateKeyPairSync, verify as nodeVerify, type KeyObject } from 'node:crypto';
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

describe('signToken (SPEC 2.)', () => {
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

describe('verifySignedPath (SPEC 4. sorrend)', () => {
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

describe('kulcsforgatás: több kid egyidejűleg (SPEC 7.)', () => {
  const NEW = 'CSAK-TESZT-kulcs-elearning-2026b';
  const oldLink = buildSignedPath({ key: KEY, kid: '2026a', u: U, tokenPath: DIR, expires: E, path: FILE });
  const newLink = buildSignedPath({ key: NEW, kid: '2026b', u: U, tokenPath: DIR, expires: E, path: FILE });
  it('két böngészős kid: mindkettővel aláírt link érvényes', () => {
    const both = appLookupFrom({ elearning: { keys: { '2026a': KEY, '2026b': NEW }, contentKeys: {} } });
    expect(verifySignedPath(oldLink, both, E)).toMatchObject({ ok: true, kid: '2026a' });
    expect(verifySignedPath(newLink, both, E)).toMatchObject({ ok: true, kid: '2026b' });
  });
  it('a régi kid törlése után a vele aláírt link 403 unknown-kid, az új marad', () => {
    const rotated = appLookupFrom({ elearning: { keys: { '2026b': NEW }, contentKeys: {} } });
    expect(verifySignedPath(oldLink, rotated, E)).toEqual({ ok: false, status: 403, reason: 'unknown-kid' });
    expect(verifySignedPath(newLink, rotated, E)).toMatchObject({ ok: true, kid: '2026b' });
  });
});

describe('ES256 séma (SPEC 2., 4. 6a/6b)', () => {
  // CSAK TESZT kulcspárok, futáskor generálva.
  const newPair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
    return { privateKey, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), publicKey: raw.toString('base64url') };
  };
  const B = newPair();
  const C = newPair();
  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const sOf = (token: string): bigint => BigInt(`0x${Buffer.from(token.slice(6), 'base64url').subarray(32).toString('hex')}`);
  const withS = (token: string, s: bigint): string => {
    const sig = Buffer.from(token.slice(6), 'base64url');
    Buffer.from(s.toString(16).padStart(64, '0'), 'hex').copy(sig, 32);
    return `ES256-${sig.toString('base64url')}`;
  };
  const mixed = appLookupFrom({
    elearning: {
      keys: { '2026a': KEY },
      contentKeys: { '2026c': CKEY },
      publicKeys: { '2026e': B.publicKey },
      contentPublicKeys: { '2026f': C.publicKey },
    },
  });
  const link = (over: Partial<{ privateKey: string | KeyObject; kid: string; u: string }> = {}) =>
    buildSignedPath({ privateKey: B.pkcs8, kid: '2026e', u: U, tokenPath: DIR, expires: E, path: FILE, ...over });

  it('aláír → elfogad (szöveges és KeyObject titkos kulccsal), a token ES256- + 86 jel, a séma a kid-ből', () => {
    for (const privateKey of [B.pkcs8, B.privateKey]) {
      const uri = link({ privateKey });
      expect(parseSignedPath(uri)).toMatchObject({ token: expect.stringMatching(/^ES256-[A-Za-z0-9_-]{85}[AQgw]$/) });
      expect(verifySignedPath(uri, mixed, E)).toMatchObject({ ok: true, kid: '2026e', u: U, kind: 'browser' });
    }
    const c = buildSignedPath({ privateKey: C.pkcs8, kid: '2026f', tokenPath: CFILE, expires: E, path: CFILE });
    expect(verifySignedPath(c, mixed, E)).toMatchObject({ ok: true, kid: '2026f', kind: 'content' });
    expect(verifySignedPath(link(), mixed, E + 1)).toEqual({ ok: false, status: 410, reason: 'expired' });
  });

  it('az aláírás véletlenszerű: két aláírás különbözik, mindkettő érvényes', () => {
    const a = link();
    const b = link();
    expect(a).not.toBe(b);
    expect(verifySignedPath(a, mixed, E).ok && verifySignedPath(b, mixed, E).ok).toBe(true);
  });

  it('az M ugyanaz, mint a HMAC-é: a token a Node-dal közvetlenül ellenőrizhető', () => {
    const t = signToken({ privateKey: B.pkcs8, tokenPath: DIR, expires: E, params: { kid: '2026e', u: U } });
    const m = Buffer.from(`${DIR}${E}kid=2026e&token_path=${DIR}&u=${U}`);
    const key = createPublicKey(B.privateKey);
    expect(nodeVerify('sha256', m, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(t.slice(6), 'base64url'))).toBe(true);
  });

  it('low-S: az aláíró mindig normalizál; a magas-S változat bad-signature (a Node maga elfogadná)', () => {
    for (let i = 0; i < 40; i++) {
      const t = signToken({ privateKey: B.pkcs8, tokenPath: DIR, expires: E, params: { kid: '2026e', u: U } });
      expect(sOf(t) <= N / 2n).toBe(true);
    }
    const uri = link();
    const t = parseSignedPath(uri) as { token: string };
    const high = withS(t.token, N - sOf(t.token));
    const m = Buffer.from(`${DIR}${E}kid=2026e&token_path=${DIR}&u=${U}`);
    const key = createPublicKey(B.privateKey);
    expect(nodeVerify('sha256', m, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(high.slice(6), 'base64url'))).toBe(true);
    expect(verifySignedPath(uri.replace(t.token, high), mixed, E)).toEqual({ ok: false, status: 403, reason: 'bad-signature' });
  });

  it.each([
    ['s = 0', 0n],
    ['s = n', N],
  ])('%s → bad-signature', (_n, s) => {
    const uri = link();
    const t = (parseSignedPath(uri) as { token: string }).token;
    expect(verifySignedPath(uri.replace(t, withS(t, s)), mixed, E)).toMatchObject({ status: 403, reason: 'bad-signature' });
  });

  it('wrong-scheme: ES256 token HMAC-kid-del és HS256 token publicKeys-kid-del; a séma a kid-ből jön', () => {
    const esOnHmac = buildSignedPath({ privateKey: B.pkcs8, kid: '2026a', u: U, tokenPath: DIR, expires: E, path: FILE });
    expect(verifySignedPath(esOnHmac, mixed, E)).toEqual({ ok: false, status: 403, reason: 'wrong-scheme' });
    const hsOnPublic = buildSignedPath({ key: KEY, kid: '2026e', u: U, tokenPath: DIR, expires: E, path: FILE });
    expect(verifySignedPath(hsOnPublic, mixed, E)).toEqual({ ok: false, status: 403, reason: 'wrong-scheme' });
  });

  it('wrong-key-kind és unknown-kid a négy térképpel', () => {
    const browserKidOnContent = buildSignedPath({ privateKey: B.pkcs8, kid: '2026e', tokenPath: CFILE, expires: E, path: CFILE });
    expect(verifySignedPath(browserKidOnContent, mixed, E)).toMatchObject({ reason: 'wrong-key-kind' });
    expect(verifySignedPath(link({ privateKey: C.pkcs8, kid: '2026f' }), mixed, E)).toMatchObject({ reason: 'wrong-key-kind' });
    expect(verifySignedPath(link({ kid: '2026x' }), mixed, E)).toMatchObject({ reason: 'unknown-kid' });
    expect(verifySignedPath(link({ kid: 'toString' }), mixed, E)).toMatchObject({ reason: 'unknown-kid' });
  });

  it('másik kulcspárral aláírva, illetve görbén kívüli nyilvános kulccsal → bad-signature', () => {
    expect(verifySignedPath(link({ privateKey: C.pkcs8 }), mixed, E)).toMatchObject({ reason: 'bad-signature' });
    const bytes = Buffer.from(B.publicKey, 'base64url');
    bytes[64] = (bytes[64] as number) ^ 1;
    const off = appLookupFrom({ elearning: { keys: {}, contentKeys: {}, publicKeys: { '2026e': bytes.toString('base64url') } } });
    expect(verifySignedPath(link(), off, E)).toMatchObject({ reason: 'bad-signature' });
  });

  it('a token alakja: nem kanonikus utolsó jel és 85 jel → malformed-token', () => {
    const uri = link();
    const t = (parseSignedPath(uri) as { token: string }).token;
    const nonCanonical = t.slice(0, -1) + String.fromCharCode(t.charCodeAt(t.length - 1) + 1);
    expect(verifySignedPath(uri.replace(t, nonCanonical), mixed, E)).toMatchObject({ reason: 'malformed-token' });
    expect(verifySignedPath(uri.replace(t, t.slice(0, -1)), mixed, E)).toMatchObject({ reason: 'malformed-token' });
    expect(parseSignedPath(uri.replace(t, `ES384-${t.slice(6)}`))).toEqual({ error: 'malformed-token' });
  });

  it('key és privateKey együtt: TypeError; hibás titkos kulcs: RangeError a kulcs idézése nélkül', () => {
    const both = { key: KEY, privateKey: B.pkcs8, tokenPath: DIR, expires: E, params: { kid: 'a' } };
    expect(() => signToken(both as unknown as Parameters<typeof signToken>[0])).toThrow(TypeError);
    const secret = 'CSAKTESZThibasTitkosKulcs0123456789abcdefghij';
    expect(() => signToken({ privateKey: secret, tokenPath: DIR, expires: E, params: { kid: 'a' } })).toThrow(RangeError);
    try {
      link({ privateKey: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret.slice(0, 12));
    }
    const ed = generateKeyPairSync('ed25519').privateKey;
    expect(() => link({ privateKey: ed })).toThrow(RangeError);
  });
});
