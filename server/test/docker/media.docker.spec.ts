// A futó médiaszerver-konténer viselkedése (terv 4.1–4.4 és 8. MS1-elfogadás; implementációs
// terv WP3 2.). A konténert a ./setup.ts indítja szintetikus teszt-gyökérrel és a test/fixtures/apps.test.json
// CSAK TESZT kulcsaival. A kéréseket a node:http küldi, hogy a nyers útvonal (`..`, `%2F`, `//`) változatlanul
// menjen át. A korlát-tesztek a végén futnak (nyitott kapcsolatok, IP-nkénti limit_req).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildSignedPath, bucketExpires, signToken } from '@chromygabor/media-sdk';
import { describe, expect, inject, it } from 'vitest';
import { APP_DIR, BLOB_SIZE, CONTENT_JSON, FILES, seededBytes, type DockerEnv } from './setup.js';

const env = inject('mediaDocker') as DockerEnv;
const ready = env.ok ? env : null;

interface AppFixture {
  keys: Record<string, string>;
  contentKeys: Record<string, string>;
}
const fixture = JSON.parse(readFileSync(join(APP_DIR, 'test/fixtures/apps.test.json'), 'utf8')) as Record<
  string,
  AppFixture
>;
const KEY = {
  elearning: fixture.elearning!.keys.t2026a!,
  elearningContent: fixture.elearning!.contentKeys.t2026c!,
  masik: fixture.masik!.keys.t2026a!,
  helyi: fixture.helyi!.keys.t2026a!,
};
const LESSON = '/elearning/t/lessons/ch-01-l01/';
const USER = 'user-0b7d3c1e';

const now = (): number => Math.floor(Date.now() / 1000);
const local = (rel: string): Buffer => readFileSync(join(ready?.root ?? '', rel));
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);

interface SegOpts {
  key?: string;
  kid?: string;
  tokenPath: string;
  u?: string | null;
  expires?: number;
}

/** A token-szegmens (útvonal nélkül), tetszőleges – akár a médiaszerver által elutasítandó – token_path-szal. */
function seg(o: SegOpts): string {
  const kid = o.kid ?? 't2026a';
  const u = o.u === null ? undefined : (o.u ?? USER);
  const expires = o.expires ?? bucketExpires(now());
  const token = signToken({ key: o.key ?? KEY.elearning, tokenPath: o.tokenPath, expires, params: u ? { kid, u } : { kid } });
  return `/bcdn_token=${token}&kid=${kid}&token_path=${encodeURIComponent(o.tokenPath)}${u ? `&u=${u}` : ''}&expires=${expires}`;
}

/** Elfogadható link a media-sdk buildSignedPath-jával (böngészős: a fájl könyvtára). */
function signed(path: string, o: Partial<SegOpts> = {}): string {
  const u = o.u === null ? undefined : (o.u ?? USER);
  return buildSignedPath({
    key: o.key ?? KEY.elearning,
    kid: o.kid ?? 't2026a',
    tokenPath: o.tokenPath ?? dirOf(path),
    expires: o.expires ?? bucketExpires(now()),
    path,
    ...(u ? { u } : {}),
  });
}

/** Tartalomlink: tartalomkulcs, fájlra szóló token_path, `u` nélkül, 5 perc. */
function contentLink(path: string): string {
  return buildSignedPath({ key: KEY.elearningContent, kid: 't2026c', tokenPath: path, expires: now() + 300, path });
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  /** false: nincs X-Forwarded-For (a kapcsolat az átjáróról jön). */
  xff?: boolean;
}

let ipSeq = 0;
/**
 * Alapból minden kérés saját X-Forwarded-For-t kap (198.18.0.0/15, benchmark-tartomány): az érvénytelen tokenre
 * vonatkozó IP-nkénti limit_req (10 r/s, burst 20) így nem torzítja a sok 403-as esetet.
 */
function nextIp(): string {
  ipSeq++;
  return `198.18.${(ipSeq >> 8) & 0xff}.${ipSeq & 0xff}`;
}

function open(path: string, opts: ReqOpts = {}): Promise<IncomingMessage> {
  const headers = { ...(opts.xff === false ? {} : { 'X-Forwarded-For': nextIp() }), ...opts.headers };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: ready!.host, port: ready!.port, path, method: opts.method ?? 'GET', headers, agent: false },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

async function get(path: string, opts: ReqOpts = {}): Promise<Res> {
  const res = await open(path, opts);
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
}

/** `docker compose … <args>` (stdin opcionális); { code, stdout, stderr }. */
function dc(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['compose', ...ready!.composeArgs, ...args], { cwd: APP_DIR });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.stdin.end(input ?? '');
  });
}

const exec = (cmd: string[], input?: string) => dc(['exec', '-T', 'media', ...cmd], input);
const NGINX_C = ['nginx', '-c', '/etc/nginx/media/nginx.conf'];

/** A konténer teljes naplója (stdout + stderr). */
async function logs(): Promise<string> {
  const r = await dc(['logs', '--no-color', '--no-log-prefix', 'media']);
  return r.stdout + r.stderr;
}

type LogLine = Record<string, string | number>;

/** A JSON access log sora az adott User-Agenttel (a naplózás aszinkron: rövid várakozással). */
async function logLine(ua: string): Promise<LogLine> {
  for (let i = 0; i < 30; i++) {
    const lines = (await logs())
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as LogLine)
      .filter((l) => l.ua === ua);
    if (lines.length > 0) return lines[lines.length - 1]!;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`nincs naplósor: ${ua}`);
}

const ua = (tag: string): Record<string, string> => ({ 'User-Agent': `wp3-docker/${tag}` });

if (!ready) {
  describe('médiaszerver (docker)', () => {
    it.skip(`KIHAGYVA: ${env.ok ? '' : env.skip}`, () => {});
  });
} else {
  describe('konténer és konfig', () => {
    it('/healthz → 204', async () => {
      const r = await get('/healthz');
      expect(r.status).toBe(204);
    });

    it('nginx -t (a -c /etc/nginx/media/nginx.conf-fal)', async () => {
      const r = await exec([...NGINX_C, '-t']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('syntax is ok');
    });

    it('a korlátok a futó konfigban (nginx -T)', async () => {
      const r = await exec([...NGINX_C, '-T']);
      expect(r.code).toBe(0);
      for (const d of [
        /limit_conn\s+media_user\s+3;/,
        /limit_conn\s+media_app\s+40;/,
        /limit_rate_after\s+30m;/,
        /limit_rate\s+600k;/,
        /limit_req\s+zone=media_denied/,
        /autoindex\s+off;/,
        /set_real_ip_from\s+172\.29\.\d+\.1;/,
      ]) {
        expect(r.stdout).toMatch(d);
      }
      expect(r.stdout).toContain(`set_real_ip_from  ${ready.gateway};`);
    });

    it('check-apps.js: a teszt apps.json rendben, a hibás nem nulla kilépéssel', async () => {
      const okRun = await exec(['njs', '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js']);
      expect(okRun.code, okRun.stderr).toBe(0);
      expect(okRun.stdout).toContain('rendben (3 app)');
      const bad = JSON.stringify({ x: { dir: '../x', keys: { a: 'rövid' }, contentKeys: { a: 'rövid' } } });
      await exec(['sh', '-c', 'cat > /tmp/bad-apps.json'], bad);
      const badRun = await exec(['njs', '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js', '/tmp/bad-apps.json']);
      expect(badRun.code).not.toBe(0);
      expect(badRun.stdout + badRun.stderr).toMatch(/dir: érvénytelen könyvtár/);
      expect(badRun.stdout + badRun.stderr).not.toContain('rövid');
    });

    it.each(['njs', 'QuickJS'])('a közös vektorok a konténer njs CLI-jén (%s motor)', async (engine) => {
      const require = createRequire(import.meta.url);
      const vectors = readFileSync(require.resolve('@chromygabor/media-sdk/test-vectors.json'), 'utf8');
      const runner = readFileSync(join(APP_DIR, 'test/docker/njs-vectors.js'), 'utf8');
      expect((await exec(['sh', '-c', 'cat > /tmp/vectors.json'], vectors)).code).toBe(0);
      expect((await exec(['sh', '-c', 'cat > /tmp/njs-vectors.js'], runner)).code).toBe(0);
      const r = await exec(['njs', '-n', engine, '-q', '-m', '-p', '/etc/nginx/njs', '/tmp/njs-vectors.js', '/tmp/vectors.json']);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { verify: number; sign: number; fails: string[] };
      const parsed = JSON.parse(vectors) as { verify: unknown[]; sign: unknown[] };
      expect(out.fails).toEqual([]);
      expect(out.verify).toBe(parsed.verify.length);
      expect(out.sign).toBe(parsed.sign.length);
    });
  });

  describe('kiszolgálás (200 / 206 / 416 / HEAD / feltételes kérések)', () => {
    it('videó: 200, bájtra egyezik, fejlécek (terv 4.4)', async () => {
      const r = await get(signed(`/${FILES.video}`));
      expect(r.status).toBe(200);
      expect(r.body.equals(local(FILES.video))).toBe(true);
      expect(r.headers['content-type']).toBe('video/mp4');
      expect(r.headers['content-length']).toBe(String(local(FILES.video).length));
      expect(r.headers['accept-ranges']).toBe('bytes');
      expect(r.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
      expect(r.headers['last-modified']).toBeTruthy();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-disposition']).toBe('inline');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
      expect(r.headers['cache-control']).toBe('private, max-age=3600');
      expect(r.headers.vary).toBe('Origin');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers.server).toBe('nginx');
    });

    it.each([
      ['hang', FILES.audio, 'audio/mp4'],
      ['poszter', FILES.poster, 'image/jpeg'],
    ])('%s: 200, Content-Type, bájtra egyezik', async (_n, file, type) => {
      const r = await get(signed(`/${file}`));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe(type);
      expect(r.body.equals(local(file))).toBe(true);
    });

    it('HEAD: 200, Content-Length, üres törzs', async () => {
      const r = await get(signed(`/${FILES.blob}`), { method: 'HEAD' });
      expect(r.status).toBe(200);
      expect(r.headers['content-length']).toBe(String(BLOB_SIZE));
      expect(r.body.length).toBe(0);
    });

    it.each([
      ['bytes=0-99', 0, 99],
      ['bytes=4194304-4198399', 4_194_304, 4_198_399],
      ['bytes=-100', BLOB_SIZE - 100, BLOB_SIZE - 1],
      [`bytes=${BLOB_SIZE - 10}-`, BLOB_SIZE - 10, BLOB_SIZE - 1],
    ])('Range %s → 206, Content-Range, pontos bájtok', async (range, from, to) => {
      const r = await get(signed(`/${FILES.blob}`), { headers: { Range: range } });
      expect(r.status).toBe(206);
      expect(r.headers['content-range']).toBe(`bytes ${from}-${to}/${BLOB_SIZE}`);
      expect(r.headers['content-length']).toBe(String(to - from + 1));
      expect(r.body.equals(seededBytes(BLOB_SIZE).subarray(from, to + 1))).toBe(true);
      expect(r.headers['cache-control']).toBe('private, max-age=3600');
    });

    it('Range a fájl végén túl → 416, Content-Range: bytes */<méret>', async () => {
      const r = await get(signed(`/${FILES.blob}`), { headers: { Range: `bytes=${BLOB_SIZE}-${BLOB_SIZE + 10}` } });
      expect(r.status).toBe(416);
      expect(r.headers['content-range']).toBe(`bytes */${BLOB_SIZE}`);
      // egyszer, a tényleges állapot szerint (WP2-ben add_header-rel minden fejléc kétszer, private cache-sel jött)
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
      expect(r.headers.vary).toBe('Origin');
    });

    it('If-Range: egyező ETag → 206, eltérő → 200 a teljes fájllal; If-None-Match → 304', async () => {
      const link = signed(`/${FILES.video}`);
      const etag = (await get(link, { method: 'HEAD' })).headers.etag!;
      const hit = await get(link, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
      expect(hit.status).toBe(206);
      const miss = await get(link, { headers: { Range: 'bytes=0-9', 'If-Range': '"masik"' } });
      expect(miss.status).toBe(200);
      expect(miss.body.length).toBe(local(FILES.video).length);
      const nm = await get(link, { headers: { 'If-None-Match': etag } });
      expect(nm.status).toBe(304);
      expect(nm.headers['cache-control']).toBe('private, max-age=3600');
    });

    it('másik app saját linkje a saját könyvtárából 200', async () => {
      const r = await get(signed(`/${FILES.masik}`, { key: KEY.masik }));
      expect(r.status).toBe(200);
      expect(r.body.equals(local(FILES.masik))).toBe(true);
    });

    it('`dir: "."` app (helyi): /helyi/<assetKey> → MEDIA_ROOT/<assetKey>, CORP az apps.json szerint', async () => {
      const r = await get(signed(`/helyi/${FILES.helyi}`, { key: KEY.helyi }));
      expect(r.status).toBe(200);
      expect(r.body.equals(local(FILES.helyi))).toBe(true);
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });
  });

  describe('elutasítás (terv 4.4 sorrendje: alak 403 → tábla 404 → token 403 → lejárat 410 → fájl 404)', () => {
    it('token nélkül → 403, minimális törzs, no-store', async () => {
      const r = await get(`/${FILES.video}`);
      expect(r.status).toBe(403);
      expect(r.body.toString()).toBe('forbidden\n');
      expect(r.headers['content-type']).toBe('text/plain');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    });

    it('másik app kulcsával aláírt link → 403', async () => {
      expect((await get(signed(`/${FILES.video}`, { key: KEY.masik }))).status).toBe(403);
      // a másik app érvényes token-szegmense a mi útvonalunkkal
      expect((await get(seg({ key: KEY.masik, tokenPath: '/masik/x/' }) + `/${FILES.video}`)).status).toBe(403);
      // a mi érvényes szegmensünk a másik app útvonalával
      expect((await get(seg({ tokenPath: '/elearning/' }) + `/${FILES.masik}`)).status).toBe(403);
    });

    it('ismeretlen kid / ismeretlen app → 403', async () => {
      expect((await get(seg({ kid: 'nincs', tokenPath: LESSON }) + `/${FILES.video}`)).status).toBe(403);
      expect((await get(seg({ tokenPath: '/senki/' }) + '/senki/a.mp4')).status).toBe(403);
    });

    it('lejárt (hiteles) link → 410', async () => {
      const r = await get(signed(`/${FILES.video}`, { expires: now() - 10 }));
      expect(r.status).toBe(410);
      expect(r.body.toString()).toBe('expired\n');
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('lejárt, de hamis link → 403 (az aláírás a lejárat előtt)', async () => {
      const link = signed(`/${FILES.video}`, { expires: now() - 10 }).replace(/bcdn_token=HS256-./, (m) =>
        m.endsWith('A') ? `${m.slice(0, -1)}B` : `${m.slice(0, -1)}A`,
      );
      expect((await get(link)).status).toBe(403);
    });

    it('módosított u → 403', async () => {
      const link = signed(`/${FILES.video}`).replace(`u=${USER}`, 'u=user-masik');
      expect((await get(link)).status).toBe(403);
    });

    it('token_path-on kívül, szomszéd-előtag → 403', async () => {
      // a ch-01-l01/ token a ch-01-l10 leckére
      expect((await get(seg({ tokenPath: LESSON }) + `/${FILES.neighbour}`)).status).toBe(403);
      // nem /-re végződő könyvtár-előtag (P6): a ch-01-l1 nem fedheti a ch-01-l10-et
      expect((await get(seg({ tokenPath: '/elearning/t/lessons/ch-01-l1' }) + `/${FILES.neighbour}`)).status).toBe(403);
      // kontroll: a saját tokenjével a szomszéd fájl elérhető
      expect((await get(signed(`/${FILES.neighbour}`))).status).toBe(200);
    });

    it.each([
      ['..', `${LESSON}../ch-01-l10/m01.720p.mp4`],
      ['.. a gyökér fölé', `${LESSON}../../../../../etc/passwd.mp4`],
      ['.. másik appba', '/elearning/../masik/x/y.mp4'],
      ['%2F', '/elearning/t%2Flessons/ch-01-l01/m01.720p.mp4'],
      ['%2e%2e', `${LESSON}%2e%2e/ch-01-l10/m01.720p.mp4`],
      ['//', '/elearning/t//lessons/ch-01-l01/m01.720p.mp4'],
      ['.-tal kezdődő fájl', `/${FILES.hidden}`],
      ['könyvtár-útvonal /-rel', LESSON],
    ])('kilógó / hibás alakú útvonal (%s) → 403', async (_n, path) => {
      const r = await get(seg({ tokenPath: '/elearning/' }) + path);
      expect(r.status).toBe(403);
      expect(r.body.toString()).toBe('forbidden\n');
    });

    it.each([
      ['*.build.json', `/${FILES.buildJson}`],
      ['nem engedett kiterjesztés', `/${FILES.txt}`],
      ['kiterjesztés nélküli könyvtár', '/elearning/t/lessons/ch-01-l01'],
      ['.json.gz nem _content/ alatt', '/elearning/t/x.json.gz'],
    ])('%s → 404 (érvényes tokennel is)', async (_n, path) => {
      const r = await get(seg({ tokenPath: '/elearning/' }) + path);
      expect(r.status).toBe(404);
      expect(r.body.toString()).toBe('not found\n');
    });

    it('nincs könyvtárlistázás: .mp4 nevű könyvtár → 404; token nélküli könyvtár → 403', async () => {
      const r = await get(signed(`/${FILES.dirAsFile}`));
      expect(r.status).toBe(404);
      expect(r.body.toString()).not.toMatch(/Index of|inner\.mp4/);
      for (const p of ['/', '/elearning/', LESSON]) {
        const d = await get(p);
        expect(d.status).toBe(403);
        expect(d.body.toString()).not.toMatch(/Index of/);
      }
    });

    it('nem létező fájl érvényes tokennel → 404', async () => {
      expect((await get(signed(`${LESSON}nincs.mp4`))).status).toBe(404);
    });

    it('POST → 405', async () => {
      expect((await get(signed(`/${FILES.video}`), { method: 'POST' })).status).toBe(405);
    });
  });

  describe('_content/ (tartalomkulcs, terv 4.3–4.4)', () => {
    const path = `/${FILES.content}`;

    it('böngészős kulccsal → 403', async () => {
      expect((await get(seg({ tokenPath: path }) + path)).status).toBe(403);
      expect((await get(seg({ tokenPath: '/elearning/_content/' }) + path)).status).toBe(403);
    });

    it('tartalomkulccsal → 200, application/gzip, Content-Encoding nélkül, no-store, bájtra egyezik', async () => {
      const r = await get(contentLink(path), { headers: { 'Accept-Encoding': 'gzip, br' } });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/gzip');
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body.equals(local(FILES.content))).toBe(true);
      expect(gunzipSync(r.body).toString()).toBe(CONTENT_JSON);
    });

    it('tartalomkulccsal, de könyvtár-token_path vagy `u` → 403; médiafájlra → 403', async () => {
      const k = { key: KEY.elearningContent, kid: 't2026c' };
      expect((await get(seg({ ...k, tokenPath: '/elearning/_content/', u: null }) + path)).status).toBe(403);
      expect((await get(seg({ ...k, tokenPath: path }) + path)).status).toBe(403);
      expect((await get(seg({ ...k, tokenPath: LESSON, u: null }) + `/${FILES.video}`)).status).toBe(403);
    });
  });

  describe('CORS (az app origins listájából)', () => {
    const allowed = 'https://elearning.example.test';

    it('engedett origin → ACAO, Expose-Headers, Vary: Origin', async () => {
      const r = await get(signed(`/${FILES.video}`), { headers: { Origin: allowed, Range: 'bytes=0-1' } });
      expect(r.status).toBe(206);
      expect(r.headers['access-control-allow-origin']).toBe(allowed);
      expect(r.headers['access-control-expose-headers']).toBe('Content-Length, Content-Range, Accept-Ranges');
      expect(r.headers.vary).toBe('Origin');
    });

    it('nem engedett origin → nincs ACAO', async () => {
      const r = await get(signed(`/${FILES.video}`), { headers: { Origin: 'https://evil.example' } });
      expect(r.status).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('OPTIONS (token nélkül): engedett originnel 204 + CORS, nem engedettel 204 CORS nélkül', async () => {
      const ok = await get(`/${FILES.video}`, {
        method: 'OPTIONS',
        headers: { Origin: allowed, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
      });
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(allowed);
      expect(ok.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
      expect(ok.headers['access-control-allow-headers']).toBe('Range, If-Range');
      expect(ok.headers['access-control-max-age']).toBe('600');
      const no = await get(`/${FILES.video}`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
      expect(no.status).toBe(204);
      expect(no.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('napló (JSON, token nélkül, valódi kliens-IP)', () => {
    it('X-Forwarded-For az átjárótól → a naplóban az az IP; a sor szétszedett mezői', async () => {
      const link = signed(`/${FILES.video}`);
      const r = await get(link, { headers: { ...ua('xff'), 'X-Forwarded-For': '198.51.100.23' } });
      expect(r.status).toBe(200);
      const l = await logLine('wp3-docker/xff');
      expect(l).toMatchObject({
        ip: '198.51.100.23',
        method: 'GET',
        app: 'elearning',
        kid: 't2026a',
        u: USER,
        path: `/${FILES.video}`,
        status: 200,
        reason: '',
      });
      expect(Number(l.bytes)).toBeGreaterThan(local(FILES.video).length);
    });

    it('X-Forwarded-For nélkül → az átjáró IP-je; elutasításnál az ok a naplóban', async () => {
      await get(`/${FILES.video}`, { headers: ua('noxff'), xff: false });
      expect(await logLine('wp3-docker/noxff')).toMatchObject({ ip: ready.gateway, status: 403, reason: 'missing-token', u: '' });
    });

    it('nem az átjárótól érkező X-Forwarded-For figyelmen kívül marad', async () => {
      const ipRun = await exec(['sh', '-c', "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1"]);
      const own = ipRun.stdout.trim();
      expect(own).toMatch(/^172\.29\.\d+\.\d+$/);
      const r = await exec([
        'wget', '-q', '-O', '/dev/null', '-U', 'wp3-docker/spoof', '--header', 'X-Forwarded-For: 192.0.2.99', `http://${own}/${FILES.video}`,
      ]);
      expect(r.code).not.toBe(0); // 403
      expect(await logLine('wp3-docker/spoof')).toMatchObject({ ip: own, status: 403 });
    });

    it('a tartalomkérés sora: u üres, kid a tartalomkulcsé', async () => {
      await get(contentLink(`/${FILES.content}`), { headers: ua('content') });
      expect(await logLine('wp3-docker/content')).toMatchObject({ app: 'elearning', kid: 't2026c', u: '', status: 200 });
    });
  });

  describe('korlátok (terv 4.4)', () => {
    const big = `/${FILES.big}`;

    it('limit_rate_after 30m, utána ~600 KB/s (tűréssel)', async () => {
      const res = await open(signed(big, { u: 'rate-user' }));
      expect(res.statusCode).toBe(200);
      const fast = 30 * 1024 * 1024;
      const start = 31 * 1024 * 1024;
      const span = 2 * 1024 * 1024;
      const tStart = performance.now();
      let got = 0;
      let tFast = 0;
      let t0 = 0;
      let t1 = 0;
      await new Promise<void>((resolve, reject) => {
        res.on('data', (c: Buffer) => {
          got += c.length;
          if (tFast === 0 && got >= fast) tFast = performance.now();
          if (t0 === 0 && got >= start) t0 = performance.now();
          if (t0 !== 0 && got >= start + span) {
            t1 = performance.now();
            res.destroy();
            resolve();
          }
        });
        res.on('error', reject);
        res.on('end', resolve);
      });
      expect(t1).toBeGreaterThan(0);
      // az első 30 MiB fékezés nélkül (600 KB/s-mal ~51 s volna)
      expect(tFast - tStart).toBeLessThan(10_000);
      const rate = span / ((t1 - t0) / 1000);
      expect(rate).toBeGreaterThan(300 * 1024);
      expect(rate).toBeLessThan(1000 * 1024);
    });

    it('limit_conn: ugyanazzal az u-val a 4. egyidejű kérés 503; másik u-val 200', async () => {
      const held: IncomingMessage[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          // a törzset nem olvassuk: a kapcsolat nyitva marad (a 30 MiB fölött amúgy is fékezve)
          const r = await open(signed(big, { u: 'conn-user' }));
          held.push(r);
          expect(r.statusCode).toBe(200);
        }
        const fourth = await get(signed(big, { u: 'conn-user' }), { method: 'HEAD' });
        expect(fourth.status).toBe(503);
        const other = await open(signed(big, { u: 'conn-masik' }));
        held.push(other);
        expect(other.statusCode).toBe(200);
      } finally {
        for (const r of held) r.destroy();
      }
    });

    it('limit_req: érvénytelen tokenre IP-nként ~10 r/s (burst 20) → a többletre 429', async () => {
      const headers = { 'X-Forwarded-For': '203.0.113.50', ...ua('flood') };
      const res = await Promise.all(Array.from({ length: 50 }, () => get(`/${FILES.video}`, { headers })));
      const n403 = res.filter((r) => r.status === 403).length;
      const n429 = res.filter((r) => r.status === 429).length;
      expect(n403 + n429).toBe(50);
      expect(n403).toBeGreaterThanOrEqual(21);
      expect(n403).toBeLessThanOrEqual(30);
      expect(n429).toBeGreaterThanOrEqual(20);
      // másik IP-t nem érint
      expect((await get(`/${FILES.video}`, { headers: { 'X-Forwarded-For': '203.0.113.51' } })).status).toBe(403);
    });
  });

  describe('a napló egésze (a végén)', () => {
    it('a JSON-sorok érvényesek, és sehol (stdout, stderr) nincs token', async () => {
      const all = await logs();
      expect(all).not.toContain('bcdn_token');
      expect(all).not.toContain('HS256-');
      expect(all).not.toContain('token_path');
      for (const k of Object.values(KEY)) expect(all).not.toContain(k);
      const json = all.split('\n').filter((l) => l.startsWith('{'));
      expect(json.length).toBeGreaterThan(50);
      for (const l of json) expect(() => JSON.parse(l) as unknown).not.toThrow();
      expect(json.some((l) => (JSON.parse(l) as LogLine).status === 429)).toBe(true);
    });
  });
}

