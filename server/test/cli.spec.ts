// A keys:new és a sign CLI logikája (implementációs terv WP2 5–6.); az aláírt linket az njs is elfogadja.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bucketExpires } from '@chromygabor/media-sdk';
import media from '../njs/media.js';
import { readAppsFile, writeAppsFile, type AppsFile } from '../scripts/apps-file.js';
import { addKey, defaultKid, generateKey } from '../scripts/keys-new.js';
import { CONTENT_TTL, signUrl } from '../scripts/sign.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/apps.test.json', import.meta.url), 'utf8')) as AppsFile;
const NOW = 1_795_431_700;

describe('keys:new', () => {
  it('32 véletlen bájt base64url-szövege (43 jel), az njs elfogadja', () => {
    const k = generateKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k, 'base64url')).toHaveLength(32);
    expect(generateKey()).not.toBe(k);
    expect(media.validateApps(addKey({}, { app: 'x', kid: '2026a', key: k, content: false }))).toEqual([]);
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
    expect(addKey({}, { app: 'helyi', kid: 'a', key: 'K', content: false, dir: '.' }).helyi?.dir).toBe('.');
  });

  describe('fájlírás', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = '';
    });
    it('új fájl 0600; meglévő 0400 marad 0400, ugyanaz az inode', () => {
      dir = mkdtempSync(join(tmpdir(), 'media-server-keys-'));
      const file = join(dir, 'apps.json');
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
      dir = mkdtempSync(join(tmpdir(), 'media-server-keys-'));
      const file = join(dir, 'apps.json');
      writeFileSync(file, '[]');
      expect(() => readAppsFile(file)).toThrow(/nem objektum/);
    });
  });
});

describe('sign', () => {
  const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

  it('böngészős: alap base, a fájl könyvtára a token_path, vödrözött lejárat; az njs elfogadja', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: 't/lessons/ch-01-l01/m01.720p.mp4', u: 'u1', now: NOW });
    expect(url.startsWith('http://127.0.0.1:10090/bcdn_token=HS256-')).toBe(true);
    expect(url).toContain('&token_path=%2Felearning%2Ft%2Flessons%2Fch-01-l01%2F&u=u1&');
    expect(url).toContain(`&expires=${bucketExpires(NOW)}/elearning/t/lessons/ch-01-l01/m01.720p.mp4`);
    const r = media.verify(path(url), fixture, NOW);
    expect(r.ok && [r.app, r.kid, r.u]).toEqual(['elearning', 't2026a', 'u1']);
  });

  it('tartalom: tartalomkulcs, fájlra szóló token_path, 5 perc', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: '_content/v1.json.gz', content: true, now: NOW, base: 'https://m.example/' });
    expect(url.startsWith('https://m.example/bcdn_token=')).toBe(true);
    expect(url).toContain('kid=t2026c&token_path=%2Felearning%2F_content%2Fv1.json.gz&expires=');
    expect(url).toContain(`expires=${NOW + CONTENT_TTL}/`);
    expect(media.verify(path(url), fixture, NOW).ok).toBe(true);
    expect(media.verify(path(url), fixture, NOW + CONTENT_TTL + 1)).toMatchObject({ status: 410 });
  });

  it('--ttl, --prefix, --kid', () => {
    const url = signUrl({ apps: fixture, app: 'elearning', assetKey: 't/lessons/ch-01-l01/m.jpg', ttl: 60, prefix: '/elearning/t/', kid: 't2026a', now: NOW });
    expect(url).toContain('token_path=%2Felearning%2Ft%2F&expires=' + String(NOW + 60));
    expect(media.verify(path(url).replace('ch-01-l01/m.jpg', 'ch-02-l01/m.jpg'), fixture, NOW).ok).toBe(true);
    expect(media.verify(path(url).replace('/elearning/t/lessons/', '/elearning/v/lessons/'), fixture, NOW)).toMatchObject({
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
});
