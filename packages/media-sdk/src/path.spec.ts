import { describe, expect, it } from 'vitest';
import { classifyMediaPath, isPrefixOf, isSafeMediaPath, isSafeTokenPath, MEDIA_CONTENT_TYPES } from './path.js';
import { appLookupFrom, buildSignedPath, verifySignedPath } from './token.js';

describe('isSafeMediaPath (SPEC 3.)', () => {
  it.each([
    '/elearning/t/lessons/ch-01-l01/m01.720p.mp4',
    '/elearning/_content/2026.11.23-1.json.gz',
    '/a/b',
    '/elearning/topic_1/ep-01/x.m4a',
  ])('elfogad: %s', (p) => expect(isSafeMediaPath(p)).toBe(true));

  it.each([
    '',
    'elearning/a.mp4',
    '/elearning',
    '/elearning/',
    '/elearning/a/',
    '/elearning//a.mp4',
    '/elearning/../a.mp4',
    '/elearning/./a.mp4',
    '/elearning/.hidden.mp4',
    '/elearning/a%2Fb.mp4',
    '/elearning/a b.mp4',
    '/elearning/ä.mp4',
    '/elearning/a\\b.mp4',
    '/elearning/a?.mp4',
  ])('elutasít: %j', (p) => expect(isSafeMediaPath(p)).toBe(false));
});

describe('isSafeTokenPath', () => {
  it.each(['/elearning/', '/elearning/t/lessons/ch-01-l01/', '/elearning/_content/v.json.gz'])('elfogad: %s', (p) =>
    expect(isSafeTokenPath(p)).toBe(true),
  );
  it.each(['', '/', '//', 'elearning/', '/elearning//', '/elearning/../', '/elearning/%2F/', '/.x/'])('elutasít: %j', (p) =>
    expect(isSafeTokenPath(p)).toBe(false),
  );
});

describe('isPrefixOf (SPEC 2.1)', () => {
  it('könyvtár-előtag: csak a könyvtáron belül', () => {
    expect(isPrefixOf('/e/t/lessons/ch-01-l01/', '/e/t/lessons/ch-01-l01/m01.720p.mp4')).toBe(true);
    expect(isPrefixOf('/e/t/lessons/ch-01-l01/', '/e/t/lessons/ch-01-l01/sub/x.mp4')).toBe(true);
    expect(isPrefixOf('/e/t/lessons/ch-01-l01/', '/e/t/lessons/ch-01-l010/x.mp4')).toBe(false);
    expect(isPrefixOf('/e/t/lessons/ch-01-l0/', '/e/t/lessons/ch-01-l01/x.mp4')).toBe(false);
  });
  it('fájl: csak pontos egyezés (a ch-01-l0 nem fedi a ch-01-l01-et)', () => {
    expect(isPrefixOf('/e/_content/v.json.gz', '/e/_content/v.json.gz')).toBe(true);
    expect(isPrefixOf('/e/t/lessons/ch-01-l0', '/e/t/lessons/ch-01-l01/x.mp4')).toBe(false);
    expect(isPrefixOf('/e/_content/v.json.gz', '/e/_content/v.json.gz.x')).toBe(false);
  });
  it('üres előtag semmit nem fed', () => expect(isPrefixOf('', '/e/x.mp4')).toBe(false));
});

describe('classifyMediaPath (kiterjesztés-tábla, SPEC 3.)', () => {
  it('a tábla a SPEC 3. pontja (az njs-sel és az nginx types-szal a szerver config.spec.ts-e veti össze)', () => {
    expect(MEDIA_CONTENT_TYPES).toEqual({ '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg' });
  });
  it.each([
    ['/e/t/lessons/ch-01-l01/m01.720p.mp4', 'browser', 'video/mp4'],
    ['/e/t/lessons/ch-01-l01/m01.audio.m4a', 'browser', 'audio/mp4'],
    ['/e/t/lessons/ch-01-l01/m01.poster.jpg', 'browser', 'image/jpeg'],
    ['/e/_content/2026.11.23-1.json.gz', 'content', 'application/gzip'],
  ])('%s → %s, %s', (p, kind, ctype) => {
    expect(classifyMediaPath(p)).toMatchObject({ app: 'e', kind, contentType: ctype });
  });
  it('csak az app utáni első szegmens számít: a mélyebb _-os szegmens böngészős útvonal (SPEC 3.)', () => {
    expect(classifyMediaPath('/e/t/_x/m.mp4')).toMatchObject({ app: 'e', kind: 'browser', contentType: 'video/mp4' });
    expect(classifyMediaPath('/e/t/_content/v.json.gz')).toBeNull();
    // CSAK TESZT kulcs.
    const key = 'CSAK-TESZT-kulcs-melyebb-alahuzas-0000000000';
    const link = buildSignedPath({ key, kid: 'k1', tokenPath: '/e/t/', expires: 100, path: '/e/t/_x/m.mp4' });
    const apps = appLookupFrom({ e: { keys: { k1: key }, contentKeys: {} } });
    expect(verifySignedPath(link, apps, 50)).toMatchObject({ ok: true, kind: 'browser', assetKey: 't/_x/m.mp4' });
  });
  it('assetKey az app utáni rész', () => {
    expect(classifyMediaPath('/e/t/lessons/ch-01-l01/m01.720p.mp4')?.assetKey).toBe('t/lessons/ch-01-l01/m01.720p.mp4');
  });
  it.each([
    '/e/t/x.json.gz',
    '/e/t/m01.720p.mp4.build.json',
    '/e/t/m01.720p.mp4.part',
    '/e/t/m01.png',
    '/e/t/m01.MP4',
    '/e/t/mp4',
    '/e/_content/a/v.json.gz',
    '/e/_content/.json.gz',
    '/e/_content/v.mp4',
    '/e/_private/x.mp4',
    '/e/__content/v.json.gz',
    '/e/.hidden.mp4',
    '/e/x/',
  ])('nem kiszolgálható: %s', (p) => expect(classifyMediaPath(p)).toBeNull());
});
