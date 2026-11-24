// A közös vektorok (../test-vectors.json) a TS-megvalósításon; ugyanezt a fájlt olvassa a médiaszerver
// njs-tesztje (implementációs terv WP1, WP2). Az `es256` blokk (aszimmetrikus terv WP50): rögzített ES256-tokenek és
// verify-vektorok; bájtos sign-vektor nincs (az ECDSA véletlenszerű), az aláírást oda-vissza próba fedi.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publicKeyOf } from './apps-config.js';
import {
  appLookupFrom,
  buildSignedPath,
  isValidPrivateKey,
  parseSignedPath,
  PUBLIC_KEY_RE,
  signToken,
  verifySignedPath,
  type AppKeys,
  type TokenParams,
} from './index.js';

interface SignVector {
  name: string;
  key: string;
  tokenPath: string;
  expires: number;
  params: TokenParams;
  path: string;
  expectedToken: string;
  expectedUrlPath: string;
  source?: string;
}
interface VerifyVector {
  name: string;
  requestUri: string;
  keys: Record<string, AppKeys>;
  now: number;
  expected: { status: number; reason?: string; app?: string; kid?: string; u?: string; kind?: string; contentType?: string };
}
interface Es256Token {
  name: string;
  tokenPath: string;
  expires: number;
  params: TokenParams;
  path: string;
  token: string;
  urlPath: string;
}
interface Es256Block {
  kid: string;
  privateKey: string;
  publicKey: string;
  contentKid: string;
  contentPrivateKey: string;
  contentPublicKey: string;
  tokens: Es256Token[];
  verify: VerifyVector[];
}
interface Vectors {
  version: number;
  es256: Es256Block;
  sign: SignVector[];
  verify: VerifyVector[];
}

function checkVerify(v: VerifyVector): void {
  const r = verifySignedPath(v.requestUri, appLookupFrom(v.keys), v.now);
  if (r.ok) {
    expect({ status: 200, app: r.app, kid: r.kid, ...(r.u ? { u: r.u } : {}), kind: r.kind, contentType: r.contentType }).toEqual(
      v.expected,
    );
  } else {
    expect({ status: r.status, reason: r.reason }).toEqual(v.expected);
  }
}

const vectors = JSON.parse(readFileSync(new URL('../test-vectors.json', import.meta.url), 'utf8')) as Vectors;

describe('test-vectors.json', () => {
  it('1-es verzió, van Bunny-forrású vektor', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.sign.some((v) => v.source?.startsWith('bunny-official-nodejs@'))).toBe(true);
  });

  describe.each(vectors.sign.map((v) => [v.name, v] as const))('sign: %s', (_name, v) => {
    it('a token és az URL-útvonal bájtra egyezik', () => {
      expect(signToken({ key: v.key, tokenPath: v.tokenPath, expires: v.expires, params: v.params })).toBe(v.expectedToken);
      expect(
        buildSignedPath({ key: v.key, kid: v.params.kid, u: v.params.u, tokenPath: v.tokenPath, expires: v.expires, path: v.path }),
      ).toBe(v.expectedUrlPath);
    });
    it('a kiadott útvonal a lejáratig érvényes', () => {
      const app = v.path.split('/')[1] as string;
      const appKeys: AppKeys = { keys: { [v.params.kid]: v.key }, contentKeys: { [v.params.kid]: v.key } };
      const r = verifySignedPath(v.expectedUrlPath, appLookupFrom({ [app]: appKeys }), v.expires);
      expect(r.ok).toBe(true);
    });
  });

  describe.each(vectors.verify.map((v) => [v.name, v] as const))('verify: %s', (_name, v) => {
    it(`→ ${v.expected.status}${v.expected.reason ? ` (${v.expected.reason})` : ''}`, () => checkVerify(v));
  });

  describe('es256', () => {
    const es = vectors.es256;

    it('CSAK TESZT kulcspárok: a nyilvános kulcs a titkosból levezethető, az alakok a regexeknek felelnek meg', () => {
      expect(publicKeyOf(es.privateKey)).toBe(es.publicKey);
      expect(publicKeyOf(es.contentPrivateKey)).toBe(es.contentPublicKey);
      for (const k of [es.publicKey, es.contentPublicKey]) expect(k).toMatch(PUBLIC_KEY_RE);
      for (const k of [es.privateKey, es.contentPrivateKey]) expect(isValidPrivateKey(k)).toBe(true);
      expect(es.publicKey).not.toBe(es.contentPublicKey);
    });

    const appKeys = (): Record<string, AppKeys> => ({
      elearning: { keys: {}, contentKeys: {}, publicKeys: { [es.kid]: es.publicKey }, contentPublicKeys: { [es.contentKid]: es.contentPublicKey } },
    });

    describe.each(es.tokens.map((t) => [t.name, t] as const))('tokens: %s', (_name, t) => {
      it('a rögzített token az URL-ben, és a lejáratig érvényes', () => {
        expect(parseSignedPath(t.urlPath)).toMatchObject({ token: t.token, expires: t.expires, path: t.path });
        expect(verifySignedPath(t.urlPath, appLookupFrom(appKeys()), t.expires)).toMatchObject({ ok: true, kid: t.params.kid });
      });
      it('oda-vissza: az sdk aláír (másik tokent ad), a TS elfogadja; az URL a token nélkül azonos', () => {
        const privateKey = t.params.kid === es.kid ? es.privateKey : es.contentPrivateKey;
        const input = { tokenPath: t.tokenPath, expires: t.expires, params: t.params };
        const token = signToken({ privateKey, ...input });
        expect(token).not.toBe(t.token);
        const url = buildSignedPath({ privateKey, kid: t.params.kid, u: t.params.u, tokenPath: t.tokenPath, expires: t.expires, path: t.path });
        expect(url.replace(/^\/bcdn_token=[^&]+/, '')).toBe(t.urlPath.replace(/^\/bcdn_token=[^&]+/, ''));
        expect(verifySignedPath(url, appLookupFrom(appKeys()), t.expires).ok).toBe(true);
      });
    });

    describe.each(es.verify.map((v) => [v.name, v] as const))('verify: %s', (_name, v) => {
      it(`→ ${v.expected.status}${v.expected.reason ? ` (${v.expected.reason})` : ''}`, () => checkVerify(v));
    });

    it('a verify-vektorok minden ES256-hoz kötődő okot fednek', () => {
      const reasons = new Set(es.verify.map((v) => v.expected.reason ?? 'ok'));
      for (const r of ['ok', 'expired', 'bad-signature', 'malformed-token', 'wrong-scheme', 'wrong-key-kind']) expect(reasons).toContain(r);
    });
  });
});
