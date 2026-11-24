// A futó médiaszerver-konténer viselkedése (terv 4.1–4.4 és 8. MS1-elfogadás; implementációs
// terv WP3 2.; a kapu és az ES256: aszimmetrikus terv WP52). A konténert a ./setup.ts indítja szintetikus
// teszt-gyökérrel és a test/fixtures/apps.test.json CSAK TESZT kulcsaival (vegyes fájl: az elearning appnak HMAC- és
// ES256-kid-jei is vannak; a HMAC-esetek változatlanok, az ES256-esetek külön blokkban). A kéréseket a node:http küldi, hogy a nyers útvonal (`..`, `%2F`, `//`) változatlanul
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
  publicKeys?: Record<string, string>;
  contentPublicKeys?: Record<string, string>;
}
const requireJson = createRequire(import.meta.url);
const VECTORS_FILE = requireJson.resolve('@chromygabor/media-sdk/test-vectors.json');
/** A vektorok CSAK TESZT ES256 kulcspárjai (a fixture `t2026e` / `t2026f` nyilvános kulcsai ezek). */
const ES = (JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as { es256: { privateKey: string; contentPrivateKey: string; publicKey: string } }).es256;
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

/** ES256-link a fixture elearning appjára (t2026e böngészős, t2026f tartalom; a vektorok CSAK TESZT kulcspárjai). */
function esSigned(path: string, o: { u?: string | null; content?: boolean; expires?: number; privateKey?: string } = {}): string {
  const u = o.content ? undefined : o.u === null ? undefined : (o.u ?? USER);
  return buildSignedPath({
    privateKey: o.privateKey ?? (o.content ? ES.contentPrivateKey : ES.privateKey),
    kid: o.content ? 't2026f' : 't2026e',
    tokenPath: o.content ? path : dirOf(path),
    expires: o.expires ?? (o.content ? now() + 300 : bucketExpires(now())),
    path,
    ...(u ? { u } : {}),
  });
}

/** Magas-S változat: ugyanaz az aláírás `s → n − s`-sel (a WebCrypto elfogadná, a kapu nem). */
function highS(uri: string): string {
  return uri.replace(/ES256-([A-Za-z0-9_-]{86})/, (_m, b64: string) => {
    const sig = Buffer.from(b64, 'base64url');
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const sv = BigInt(`0x${sig.subarray(32).toString('hex')}`);
    Buffer.from((n - sv).toString(16).padStart(64, '0'), 'hex').copy(sig, 32);
    return `ES256-${sig.toString('base64url')}`;
  });
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
    it('az image-et teszteli: a konfig és az njs az image-ben, csak az apps.json és a médiagyökér csatolt (WP49)', async () => {
      const id = (await dc(['ps', '-q', 'media'])).stdout.trim();
      expect(id).not.toBe('');
      const r = await new Promise<string>((resolve, reject) => {
        const p = spawn('docker', ['inspect', '--format', '{{.Config.Image}}|{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}', id]);
        let out = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.on('error', reject);
        p.on('close', () => resolve(out.trim()));
      });
      const [img, mounts] = r.split('|');
      expect(img).toBe(ready.image);
      expect((mounts ?? '').trim().split(/\s+/).sort()).toEqual(['/etc/nginx/secrets/apps.json:false', '/srv/media:false']);
      const files = await exec(['sh', '-c', 'ls /etc/nginx/media /etc/nginx/media/templates /etc/nginx/njs']);
      expect(files.code).toBe(0);
      for (const f of ['nginx.conf', 'media.conf', 'realip.conf.template', 'media.js', 'check-apps.js']) expect(files.stdout).toContain(f);
    });

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
      expect(okRun.stdout).toContain('rendben (3 app, 2 nyilvános kulcs)');
      const bad = JSON.stringify({ x: { dir: '../x', keys: { a: 'rövid' }, contentKeys: { a: 'rövid' } } });
      await exec(['sh', '-c', 'cat > /tmp/bad-apps.json'], bad);
      const badRun = await exec(['njs', '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js', '/tmp/bad-apps.json']);
      expect(badRun.code).not.toBe(0);
      expect(badRun.stdout + badRun.stderr).toMatch(/dir: érvénytelen könyvtár/);
      expect(badRun.stdout + badRun.stderr).not.toContain('rövid');
    });

    // SPEC 6.: a kulcs hibaüzenetbe nem kerülhet. Szintaktikailag hibás fájl, a hiba helyén kulcsszerű szöveggel: a
    // check-apps.js a `JSON.parse` kivételének üzenetét írja ki, és ez motoronként más. Az alapértelmezett motor (a
    // deploy.sh hívása, `-n` nélkül) és az `njs` csak a pozíciót adja, a QuickJS a bemenetből idéz.
    const checkBroken = async (engineArgs: string[]) => {
      const secret = 'CSAKTESZTszivargasProba0123456789abcdefghijk';
      const broken = `{"x":{"dir":"x","keys":{"a":${secret}},"contentKeys":{}}}`;
      expect((await exec(['sh', '-c', 'cat > /tmp/broken-apps.json'], broken)).code).toBe(0);
      const args = ['njs', ...engineArgs, '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js', '/tmp/broken-apps.json'];
      const r = await exec(args);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('nem olvasható JSON');
      expect(r.stdout + r.stderr).not.toContain(secret.slice(0, 12));
    };
    // P16 (WP39): a `__proto__` kid a keys-ben és a contentKeys-ben is → ütközés, mindkét motoron (prototípus nélküli halmaz).
    it.each(['njs', 'QuickJS'])('check-apps.js: __proto__ kid-ütközés → hiba (%s motor)', async (engine) => {
      const K = 'A'.repeat(43);
      const apps = `{"x":{"dir":"x","keys":{"__proto__":"${K}"},"contentKeys":{"__proto__":"${K}"}}}`;
      expect((await exec(['sh', '-c', 'cat > /tmp/proto-apps.json'], apps)).code).toBe(0);
      const r = await exec(['njs', '-n', engine, '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js', '/tmp/proto-apps.json']);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('a kid több kulcstérképben is szerepel: __proto__');
    });

    // A QuickJS `JSON.parse`-üzenete a bemenetből idéz (`unexpected token: '<kulcs>'`); a WP39 óta a check-apps.js az
    // `e.message`-et nem írja ki (javítási terv P10).
    it.each([
      ['alapértelmezett (deploy.sh)', []],
      ['njs', ['-n', 'njs']],
      ['QuickJS', ['-n', 'QuickJS']],
    ])('check-apps.js: szintaktikailag hibás fájl → a kimenetben nincs a kulcsszerű szöveg (%s motor)', async (_name, engineArgs) => {
      await checkBroken(engineArgs);
    });

    it.each(['njs', 'QuickJS'])('a közös vektorok a konténer njs CLI-jén (%s motor)', async (engine) => {
      const vectors = readFileSync(VECTORS_FILE, 'utf8');
      const runner = readFileSync(join(APP_DIR, 'test/docker/njs-vectors.js'), 'utf8');
      expect((await exec(['sh', '-c', 'cat > /tmp/vectors.json'], vectors)).code).toBe(0);
      expect((await exec(['sh', '-c', 'cat > /tmp/njs-vectors.js'], runner)).code).toBe(0);
      const r = await exec(['njs', '-n', engine, '-q', '-m', '-p', '/etc/nginx/njs', '/tmp/njs-vectors.js', '/tmp/vectors.json']);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
        verify: number;
        es256Verify: number;
        sign: number;
        es256Tokens: number;
        fails: string[];
      };
      const parsed = JSON.parse(vectors) as { verify: unknown[]; sign: unknown[]; es256: { verify: unknown[]; tokens: unknown[] } };
      expect(out.fails).toEqual([]);
      expect(out.verify).toBe(parsed.verify.length);
      expect(out.es256Verify).toBe(parsed.es256.verify.length);
      expect(out.es256Verify).toBeGreaterThan(10);
      expect(out.sign).toBe(parsed.sign.length);
      expect(out.es256Tokens).toBe(parsed.es256.tokens.length);
    });
  });

  describe('apps.json-változatok, görbe-ellenőrzés, kanári (WP52)', () => {
    /** A fixture a nyilvános kulcsok nélkül (HMAC-only, a WP52 előtti alak). */
    const hmacOnly = (): string => {
      const apps = JSON.parse(readFileSync(join(APP_DIR, 'test/fixtures/apps.test.json'), 'utf8')) as Record<string, AppFixture>;
      for (const a of Object.values(apps)) {
        delete a.publicKeys;
        delete a.contentPublicKeys;
      }
      return JSON.stringify(apps);
    };

    it.each(['njs', 'QuickJS'])('check-apps.js: HMAC-only és vegyes apps.json rendben (%s motor)', async (engine) => {
      expect((await exec(['sh', '-c', 'cat > /tmp/hmac-apps.json'], hmacOnly())).code).toBe(0);
      const base = ['njs', '-n', engine, '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js'];
      const hmac = await exec([...base, '/tmp/hmac-apps.json']);
      expect(hmac.code, hmac.stderr).toBe(0);
      expect(hmac.stdout).toContain('rendben (3 app, 0 nyilvános kulcs)');
      const mixed = await exec(base);
      expect(mixed.code, mixed.stderr).toBe(0);
      expect(mixed.stdout).toContain('rendben (3 app, 2 nyilvános kulcs)');
    });

    it.each(['njs', 'QuickJS'])('check-apps.js: görbén kívüli nyilvános kulcs → hiba, a kulcs nélkül (%s motor)', async (engine) => {
      const off = `BA${'C'.repeat(84)}A`;
      const apps = { x: { dir: 'x', keys: {}, contentKeys: {}, publicKeys: { e: ES.publicKey }, contentPublicKeys: { f: off } } };
      expect((await exec(['sh', '-c', 'cat > /tmp/offcurve-apps.json'], JSON.stringify(apps))).code).toBe(0);
      const r = await exec(['njs', '-n', engine, '-q', '-m', '-p', '/etc/nginx/njs', '/etc/nginx/njs/check-apps.js', '/tmp/offcurve-apps.json']);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('apps["x"].contentPublicKeys["f"]: a nyilvános kulcs nem egy P-256 görbepont');
      expect(r.stdout + r.stderr).not.toContain('CCCCCCCC');
      expect(r.stdout + r.stderr).not.toContain(ES.publicKey.slice(0, 12));
    });

    it('nginx -t a HMAC-only és a vegyes apps.json-nal is', async () => {
      expect((await exec(['sh', '-c', 'cat > /tmp/hmac-apps.json'], hmacOnly())).code).toBe(0);
      const conf = await exec([
        'sh',
        '-c',
        "sed 's#/etc/nginx/secrets/apps.json#/tmp/hmac-apps.json#' /etc/nginx/media/nginx.conf > /tmp/nginx-hmac.conf && grep -c /tmp/hmac-apps.json /tmp/nginx-hmac.conf",
      ]);
      expect(conf.stdout.trim()).toBe('1');
      const hmac = await exec(['nginx', '-c', '/tmp/nginx-hmac.conf', '-t']);
      expect(hmac.code, hmac.stderr).toBe(0);
      expect(hmac.stderr).toContain('syntax is ok');
      const mixed = await exec([...NGINX_C, '-t']);
      expect(mixed.code, mixed.stderr).toBe(0);
    });

    // Kanári (D111): a rögzített image nginx-modulja ma nem ismeri az Ed25519-et (a CLI igen). Ha egy image-emelés
    // után ez a teszt elbukik, az Ed25519 egy új kid-sémaként (`EDDSA-`) újra mérlegelhető. Egy második, ideiglenes
    // nginx fut a konténerben (/tmp, a 127.0.0.1:18099-en), a futó szolgáltatást nem érinti.
    it('kanári: a modulban az Ed25519 ma „unknown algorithm”, az ECDSA P-256 működik', async () => {
      const js = `async function probe(r) {
  var out = [];
  var algs = [{ name: 'Ed25519' }, { name: 'ECDSA', namedCurve: 'P-256' }];
  for (var i = 0; i < algs.length; i++) {
    try {
      await crypto.subtle.generateKey(algs[i], false, ['sign', 'verify']);
      out.push(algs[i].name + '=ok');
    } catch (e) {
      out.push(algs[i].name + '=' + e.message);
    }
  }
  r.return(200, out.join('\\n') + '\\n');
}
export default { probe: probe };
`;
      const conf = `load_module /usr/lib/nginx/modules/ngx_http_js_module.so;
pid /tmp/canary.pid;
error_log /tmp/canary.err warn;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/c_cb; proxy_temp_path /tmp/c_p; fastcgi_temp_path /tmp/c_f; uwsgi_temp_path /tmp/c_u; scgi_temp_path /tmp/c_s;
  js_path /tmp/canary;
  js_import c from canary.js;
  server { listen 127.0.0.1:18099; location / { js_content c.probe; } }
}
`;
      expect((await exec(['sh', '-c', 'mkdir -p /tmp/canary && cat > /tmp/canary/canary.js'], js)).code).toBe(0);
      expect((await exec(['sh', '-c', 'cat > /tmp/canary.conf'], conf)).code).toBe(0);
      const r = await exec([
        'sh',
        '-c',
        'nginx -c /tmp/canary.conf && sleep 0.5; wget -q -O - http://127.0.0.1:18099/; s=$?; nginx -c /tmp/canary.conf -s quit; exit $s',
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('Ed25519=unknown algorithm name: "Ed25519"');
      expect(r.stdout).toContain('ECDSA=ok');
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

    it('POST → 405, Allow: GET, HEAD, OPTIONS (D100)', async () => {
      const r = await get(signed(`/${FILES.video}`), { method: 'POST' });
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD, OPTIONS');
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

  describe('ES256 (aszimmetrikus kid, ugyanaz a kapu; WP52)', () => {
    it('videó: 200, bájtra egyezik, ugyanazok a fejlécek; HEAD; Range 206; 416; If-None-Match 304', async () => {
      const link = esSigned(`/${FILES.video}`);
      expect(link).toMatch(/^\/bcdn_token=ES256-[A-Za-z0-9_-]{86}&kid=t2026e&/);
      const r = await get(link);
      expect(r.status).toBe(200);
      expect(r.body.equals(local(FILES.video))).toBe(true);
      expect(r.headers).toMatchObject({
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
        'cross-origin-resource-policy': 'same-site',
        'cache-control': 'private, max-age=3600',
        vary: 'Origin',
      });
      const head = await get(esSigned(`/${FILES.blob}`), { method: 'HEAD' });
      expect([head.status, head.headers['content-length'], head.body.length]).toEqual([200, String(BLOB_SIZE), 0]);
      const part = await get(esSigned(`/${FILES.blob}`), { headers: { Range: 'bytes=4194304-4198399' } });
      expect([part.status, part.headers['content-range']]).toEqual([206, `bytes 4194304-4198399/${BLOB_SIZE}`]);
      expect(part.body.equals(seededBytes(BLOB_SIZE).subarray(4_194_304, 4_198_400))).toBe(true);
      const bad = await get(esSigned(`/${FILES.blob}`), { headers: { Range: `bytes=${BLOB_SIZE}-` } });
      expect([bad.status, bad.headers['content-range'], bad.headers['cache-control']]).toEqual([416, `bytes */${BLOB_SIZE}`, 'no-store']);
      const nm = await get(link, { headers: { 'If-None-Match': r.headers.etag! } });
      expect([nm.status, nm.headers['cache-control']]).toEqual([304, 'private, max-age=3600']);
    });

    it('tartalom: contentPublicKeys-kid → 200, no-store; publicKeys-kid _content/-re → 403', async () => {
      const path = `/${FILES.content}`;
      const r = await get(esSigned(path, { content: true }));
      expect([r.status, r.headers['content-type'], r.headers['cache-control']]).toEqual([200, 'application/gzip', 'no-store']);
      expect(gunzipSync(r.body).toString()).toBe(CONTENT_JSON);
      const wrongKind = buildSignedPath({ privateKey: ES.privateKey, kid: 't2026e', tokenPath: path, expires: now() + 300, path });
      expect((await get(wrongKind, { headers: ua('es-wrong-kind') })).status).toBe(403);
      expect(await logLine('wp3-docker/es-wrong-kind')).toMatchObject({ status: 403, reason: 'wrong-key-kind', kid: '' });
    });

    it('wrong-scheme mindkét irányban; magas-S, idegen kulcspár, átírt u → 403 bad-signature; lejárt → 410; nincs fájl → 404', async () => {
      const video = `/${FILES.video}`;
      const hsWithEsKid = buildSignedPath({ key: KEY.elearning, kid: 't2026e', tokenPath: LESSON, expires: now() + 60, u: USER, path: video });
      const esWithHsKid = buildSignedPath({ privateKey: ES.privateKey, kid: 't2026a', tokenPath: LESSON, expires: now() + 60, u: USER, path: video });
      const cases: Array<[string, string, number, string]> = [
        ['es-ws1', hsWithEsKid, 403, 'wrong-scheme'],
        ['es-ws2', esWithHsKid, 403, 'wrong-scheme'],
        ['es-high', highS(esSigned(video)), 403, 'bad-signature'],
        ['es-other', esSigned(video, { privateKey: ES.contentPrivateKey }), 403, 'bad-signature'],
        ['es-u', esSigned(video).replace(`u=${USER}`, 'u=user-masik'), 403, 'bad-signature'],
        ['es-exp', esSigned(video, { expires: now() - 10 }), 410, 'expired'],
        ['es-404', esSigned(`${LESSON}nincs.mp4`), 404, ''],
      ];
      for (const [tag, link, status, reason] of cases) {
        const r = await get(link, { headers: ua(tag) });
        expect(r.status, tag).toBe(status);
        const line = await logLine(`wp3-docker/${tag}`);
        expect([line.status, line.reason], tag).toEqual([status, reason]);
      }
      expect((await get(highS(esSigned(video)))).body.toString()).toBe('forbidden\n');
    });

    it('CORS és napló: az engedett origin ACAO-t kap; a sor kid-je t2026e, token nélkül', async () => {
      const r = await get(esSigned(`/${FILES.video}`), { headers: { ...ua('es-log'), Origin: 'https://elearning.example.test', Range: 'bytes=0-1' } });
      expect([r.status, r.headers['access-control-allow-origin']]).toEqual([206, 'https://elearning.example.test']);
      expect(await logLine('wp3-docker/es-log')).toMatchObject({ app: 'elearning', kid: 't2026e', u: USER, path: `/${FILES.video}`, status: 206, reason: '' });
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

    it('ES256: limit_conn ugyanazzal az u-val a 4. egyidejű kérés 503 (a HMAC-cal közös kulcs: app + u)', async () => {
      const held: IncomingMessage[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const r = await open(esSigned(big, { u: 'es-conn-user' }));
          held.push(r);
          expect(r.statusCode).toBe(200);
        }
        // A harmadik HMAC-kal: a korlát a felhasználóé, nem a sémáé.
        const third = await open(signed(big, { u: 'es-conn-user' }));
        held.push(third);
        expect(third.statusCode).toBe(200);
        const fourth = await get(esSigned(big, { u: 'es-conn-user' }), { method: 'HEAD' });
        expect(fourth.status).toBe(503);
        const other = await open(esSigned(big, { u: 'es-conn-masik' }));
        held.push(other);
        expect(other.statusCode).toBe(200);
      } finally {
        for (const r of held) r.destroy();
      }
    });

    it('limit_conn appenként 40: 40 nyitott kérés (14 u, legfeljebb 3/u) mellett a 41. 503; másik app közben 200', async () => {
      // A korábbi tesztek bontott kapcsolatait az nginx már elengedte-e: rövid várakozás.
      await new Promise((r) => setTimeout(r, 500));
      const held: IncomingMessage[] = [];
      try {
        for (let i = 0; i < 40; i++) {
          // a törzset nem olvassuk: a kapcsolat nyitva marad (a 30 MiB fölött amúgy is fékezve)
          const r = await open(signed(big, { u: `app-conn-${Math.floor(i / 3)}` }));
          held.push(r);
          expect(r.statusCode, `${i + 1}. kérés`).toBe(200);
        }
        // Új u (a felhasználónkénti korlát nem érinti): az appenkénti korlát dönt.
        const over = await get(signed(big, { u: 'app-conn-uj' }), { method: 'HEAD' });
        expect(over.status).toBe(503);
        const other = await get(signed(`/${FILES.masik}`, { key: KEY.masik, u: 'app-conn-uj' }));
        expect(other.status).toBe(200);
        expect(other.body.equals(local(FILES.masik))).toBe(true);
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

  describe('hibaszámláló (D116: 50 hibás ES256-aláírás / 10 s IP-nként → 429 blocked)', () => {
    it('a küszöb után az IP ES256-kérése 429 (too many requests, no-store, nosniff), a HMAC-é és más IP-é nem; 10 s után lejár', async () => {
      const ip = '203.0.113.77';
      const video = `/${FILES.video}`;
      const bad = highS(esSigned(video));
      const t0 = performance.now();
      // Sorban: mind számol (a kapu a döntés előtt számol), akkor is, ha a @denied limit_req-je 429-et ad.
      const statuses: number[] = [];
      for (let i = 0; i < 50; i++) statuses.push((await get(bad, { headers: { 'X-Forwarded-For': ip } })).status);
      expect(new Set(statuses)).toEqual(new Set([403, 429]));
      expect(statuses.filter((st) => st === 403).length).toBeGreaterThanOrEqual(21);

      const blocked = await get(esSigned(video), { headers: { 'X-Forwarded-For': ip, ...ua('blocked') } });
      expect(blocked.status).toBe(429);
      expect(blocked.body.toString()).toBe('too many requests\n');
      expect(blocked.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/plain' });
      expect(await logLine('wp3-docker/blocked')).toMatchObject({ ip, status: 429, reason: 'blocked', app: '', kid: '' });

      // A HMAC-ra nem hat; más IP-t nem érint.
      expect((await get(signed(video), { headers: { 'X-Forwarded-For': ip } })).status).toBe(200);
      expect((await get(esSigned(video), { headers: { 'X-Forwarded-For': '203.0.113.78' } })).status).toBe(200);
      // Az olcsó elővizsgálat a blokk előtt fut: ismeretlen kid → 403 (nem 429).
      expect((await get(esSigned(video).replace('kid=t2026e', 'kid=nincs'), { headers: { 'X-Forwarded-For': ip } })).status).toBe(403);

      // Lejárat: az első hiba után 10 s (explicit incr-timeout).
      const wait = 10_500 - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      expect((await get(esSigned(video), { headers: { 'X-Forwarded-For': ip } })).status).toBe(200);
    });

    it('HMAC hibás aláírásra a számláló nem hat: 60 hibás HMAC után az IP ES256-kérése 200', async () => {
      const ip = '203.0.113.79';
      const bad = signed(`/${FILES.video}`).replace(`u=${USER}`, 'u=user-masik');
      for (let i = 0; i < 60; i++) expect([403, 429]).toContain((await get(bad, { headers: { 'X-Forwarded-For': ip } })).status);
      expect((await get(esSigned(`/${FILES.video}`), { headers: { 'X-Forwarded-For': ip } })).status).toBe(200);
    });
  });

  describe('a napló egésze (a végén)', () => {
    it('a JSON-sorok érvényesek, és sehol (stdout, stderr) nincs token', async () => {
      const all = await logs();
      expect(all).not.toContain('bcdn_token');
      expect(all).not.toContain('HS256-');
      expect(all).not.toContain('ES256-');
      for (const k of [ES.privateKey, ES.contentPrivateKey]) expect(all).not.toContain(k.slice(-40));
      expect(all).not.toContain('token_path');
      for (const k of Object.values(KEY)) expect(all).not.toContain(k);
      const json = all.split('\n').filter((l) => l.startsWith('{'));
      expect(json.length).toBeGreaterThan(50);
      for (const l of json) expect(() => JSON.parse(l) as unknown).not.toThrow();
      expect(json.some((l) => (JSON.parse(l) as LogLine).status === 429)).toBe(true);
    });
  });
}

