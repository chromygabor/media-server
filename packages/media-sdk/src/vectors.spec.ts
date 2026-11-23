// A közös vektorok (../test-vectors.json) a TS-megvalósításon; ugyanezt a fájlt olvassa a médiaszerver
// njs-tesztje (implementációs terv WP1, WP2).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appLookupFrom, buildSignedPath, signToken, verifySignedPath, type AppKeys, type TokenParams } from './index.js';

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
interface Vectors {
  version: number;
  sign: SignVector[];
  verify: VerifyVector[];
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
    it(`→ ${v.expected.status}${v.expected.reason ? ` (${v.expected.reason})` : ''}`, () => {
      const r = verifySignedPath(v.requestUri, appLookupFrom(v.keys), v.now);
      if (r.ok) {
        expect({ status: 200, app: r.app, kid: r.kid, ...(r.u ? { u: r.u } : {}), kind: r.kind, contentType: r.contentType }).toEqual(
          v.expected,
        );
      } else {
        expect({ status: r.status, reason: r.reason }).toEqual(v.expected);
      }
    });
  });
});
