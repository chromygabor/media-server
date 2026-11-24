// A docker-integrációs teszt globális előkészítése (implementációs terv WP3 1.): szintetikus teszt-gyökér
// (ffmpeg-gel generált rövid MP4 / M4A / JPG, magolt bináris, szintetikus _content/<v>.json.gz – valódi tananyag
// NEM), majd a compose indítása egyedi projektnévvel, szabad porttal és saját alhálózattal, hogy egy esetleg futó
// példánnyal ne ütközzön; a végén `down` és az ideiglenes könyvtár törlése.
// A teszt az IMAGE-et teszteli (kiemelési terv WP49), csatolt nginx/ és njs/ nélkül: a MEDIA_IMAGE-ben megadott kész
// image-et (pl. a deploy kiadási címkéjét), ennek hiányában előbb a scripts/image-build.sh-val media-server:dev-et épít.
// Ha nincs docker (vagy nem fut a démon), vagy nincs ffmpeg: a spec érthető üzenettel KIHAGY, nem bukik –
// kivéve MEDIA_DOCKER_REQUIRED=1 mellett (deploy, CI): akkor hiba.

import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const TMP_BASE = join(APP_DIR, 'test', '.tmp');
const APPS_JSON = join(APP_DIR, 'test', 'fixtures', 'apps.test.json');
const IMAGE_BUILD = join(APP_DIR, 'scripts', 'image-build.sh');
const DEV_IMAGE = 'media-server:dev';

/** A spec ezt kapja (`inject('mediaDocker')`). */
export type DockerEnv =
  | { ok: false; skip: string }
  | {
      ok: true;
      host: string;
      port: number;
      gateway: string;
      /** A tesztelt image (címke). */
      image: string;
      /** A `docker compose` közös argumentumai (projekt, compose-fájl, env-fájl). */
      composeArgs: string[];
      /** A teszt-gyökér (a konténerben /srv/media). */
      root: string;
    };

declare module 'vitest' {
  export interface ProvidedContext {
    mediaDocker: DockerEnv;
  }
}

/** A teszt-gyökér fájljai (a `MEDIA_ROOT` alatt); a spec ugyanezekre hivatkozik. */
export const FILES = {
  video: 'elearning/t/lessons/ch-01-l01/m01.720p.mp4',
  audio: 'elearning/t/lessons/ch-01-l01/m01.audio.m4a',
  poster: 'elearning/t/lessons/ch-01-l01/m01.poster.jpg',
  /** 8 MiB magolt (determinisztikus) bináris, a Range-tesztekhez. */
  blob: 'elearning/t/lessons/ch-01-l01/m02.720p.mp4',
  buildJson: 'elearning/t/lessons/ch-01-l01/m01.720p.mp4.build.json',
  txt: 'elearning/t/lessons/ch-01-l01/notes.txt',
  hidden: 'elearning/t/lessons/ch-01-l01/.hidden.mp4',
  /** Könyvtár .mp4 névvel: a try_files nem adhat könyvtárat. */
  dirAsFile: 'elearning/t/lessons/ch-01-l01/dir.mp4',
  /** Szomszéd-előtag (a ch-01-l01 → ch-01-l10 nem fedheti). */
  neighbour: 'elearning/t/lessons/ch-01-l10/m01.720p.mp4',
  /** 40 MiB ritka fájl: a limit_rate_after (30m) utáni lassított rész a korlát-tesztekhez nyitva tartja a kapcsolatot. */
  big: 'elearning/t/big/b01.mp4',
  content: 'elearning/_content/2026.11.23-1.json.gz',
  masik: 'masik/x/y.mp4',
  /** A `helyi` app (`dir: "."`) fájlja: /helyi/h/pic.jpg → /srv/media/h/pic.jpg. */
  helyi: 'h/pic.jpg',
} as const;

export const BLOB_SIZE = 8 * 1024 * 1024;
export const BIG_SIZE = 40 * 1024 * 1024;

/** Determinisztikus bájtsor (xorshift32, rögzített mag). */
export function seededBytes(size: number, seed = 0x5eed1234): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    if (i + 4 <= size) buf.writeUInt32LE(x, i);
    else for (let j = 0; i + j < size; j++) buf[i + j] = (x >>> (8 * j)) & 0xff;
  }
  return buf;
}

/** A szintetikus tartalomkiadás (nem valódi kiadás). */
export const CONTENT_JSON = JSON.stringify({ version: '2026.11.23-1', synthetic: true, note: 'WP3 docker-teszt' });

function has(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 15_000 });
  return r.status === 0;
}

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function put(root: string, rel: string, data: Buffer | string): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
}

/** Minden könyvtár 0755, minden fájl 0644: a konténer nginx-felhasználója (101) olvassa. */
function openUp(dir: string): void {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) openUp(p);
    else chmodSync(p, 0o644);
  }
}

async function buildRoot(root: string): Promise<void> {
  const lesson = join(root, 'elearning/t/lessons/ch-01-l01');
  mkdirSync(lesson, { recursive: true });
  // Rövid, lejátszható szintetikus média (2 s; testsrc2 + szinusz).
  await Promise.all([
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
      join(root, FILES.video),
    ]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', join(root, FILES.audio)]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', join(root, FILES.poster)]),
  ]);
  put(root, FILES.blob, seededBytes(BLOB_SIZE));
  put(root, FILES.buildJson, '{"synthetic":true}\n');
  put(root, FILES.txt, 'nem kiszolgálható kiterjesztés\n');
  put(root, FILES.hidden, seededBytes(1024, 7));
  mkdirSync(join(root, FILES.dirAsFile), { recursive: true });
  put(root, `${FILES.dirAsFile}/inner.mp4`, seededBytes(1024, 8));
  put(root, FILES.neighbour, seededBytes(4096, 9));
  put(root, FILES.content, gzipSync(Buffer.from(CONTENT_JSON)));
  put(root, FILES.masik, seededBytes(4096, 10));
  put(root, FILES.helyi, seededBytes(2048, 11));
  // Ritka fájl (nem foglal lemezt): a korlát-tesztek nyitott kapcsolataihoz.
  put(root, FILES.big, '');
  truncateSync(join(root, FILES.big), BIG_SIZE);
  openUp(root);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** A meglévő docker-hálózatok alhálózatai (ütközés elkerülésére). */
async function usedSubnets(): Promise<Set<string>> {
  const ids = (await run('docker', ['network', 'ls', '-q'])).stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return new Set();
  const out = (await run('docker', ['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', ...ids]))
    .stdout;
  return new Set(out.split(/\s+/).filter(Boolean));
}

let state: { composeArgs: string[]; dir: string } | null = null;

async function compose(args: string[], composeArgs: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('docker', ['compose', ...composeArgs, ...args], { cwd: APP_DIR, maxBuffer: 64 * 1024 * 1024 });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const skip = (why: string): (() => Promise<void>) => {
    if (process.env.MEDIA_DOCKER_REQUIRED === '1') {
      throw new Error(`[media-server test:docker] MEDIA_DOCKER_REQUIRED=1, de nem futtatható: ${why}`);
    }
    console.warn(`\n[media-server test:docker] KIHAGYVA: ${why}\n`);
    project.provide('mediaDocker', { ok: false, skip: why });
    return async () => {};
  };
  if (!has('docker', ['info', '--format', '{{.ServerVersion}}'])) {
    return skip('nincs docker, vagy nem fut a démon (`docker info` sikertelen)');
  }
  if (!has('docker', ['compose', 'version'])) return skip('nincs `docker compose` (v2 plugin)');
  if (!has('ffmpeg', ['-version'])) return skip('nincs ffmpeg (a szintetikus média generálásához kell)');

  const image = await resolveImage();

  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, 'docker-'));
  const root = join(dir, 'root');
  const project_ = `media-server-test-${process.pid}-${randomBytes(3).toString('hex')}`;
  const envFile = join(dir, '.env.test');
  const composeArgs = ['-p', project_, '-f', join(APP_DIR, 'compose.yaml'), '--env-file', envFile];
  state = { composeArgs, dir };

  try {
    await buildRoot(root);
    const used = await usedSubnets();
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      let octet = 100 + Math.floor(Math.random() * 150);
      while (used.has(`172.29.${octet}.0/24`)) octet = 100 + Math.floor(Math.random() * 150);
      const port = await freePort();
      const gateway = `172.29.${octet}.1`;
      writeFileSync(
        envFile,
        [
          `MEDIA_IMAGE=${image}`,
          `MEDIA_ROOT=${root}`,
          `APPS_JSON=${APPS_JSON}`,
          'BIND=127.0.0.1',
          `PORT=${port}`,
          `NET_SUBNET=172.29.${octet}.0/24`,
          `NET_GATEWAY=${gateway}`,
          `COMPOSE_PROJECT_NAME=${project_}`,
          '',
        ].join('\n'),
      );
      try {
        await compose(['up', '-d', '--wait', '--wait-timeout', '60', '--no-build', '--pull', 'never'], composeArgs);
        console.info(`\n[media-server test:docker] image: ${image}\n`);
        project.provide('mediaDocker', { ok: true, host: '127.0.0.1', port, gateway, image, composeArgs, root });
        return teardown;
      } catch (e) {
        lastErr = e;
        used.add(`172.29.${octet}.0/24`);
        await compose(['down', '-v', '--remove-orphans', '--timeout', '5'], composeArgs).catch(() => {});
      }
    }
    throw lastErr;
  } catch (e) {
    await teardown();
    throw e;
  }
}

/** A tesztelendő image: a MEDIA_IMAGE (léteznie kell), különben a Dockerfile-ból épített media-server:dev. */
async function resolveImage(): Promise<string> {
  const given = process.env.MEDIA_IMAGE?.trim();
  if (given) {
    try {
      await run('docker', ['image', 'inspect', '--format', '{{.Id}}', given]);
    } catch {
      throw new Error(`[media-server test:docker] a MEDIA_IMAGE (${given}) nem létező image`);
    }
    return given;
  }
  await run('bash', [IMAGE_BUILD, '--tag', DEV_IMAGE, '--quiet'], { cwd: APP_DIR, maxBuffer: 64 * 1024 * 1024 });
  return DEV_IMAGE;
}

async function teardown(): Promise<void> {
  if (state === null) return;
  const { composeArgs, dir } = state;
  state = null;
  try {
    await compose(['down', '-v', '--remove-orphans', '--timeout', '5'], composeArgs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try {
      rmdirSync(TMP_BASE); // csak ha üres (egy párhuzamos futás könyvtára marad)
    } catch {
      // nem üres vagy nincs: rendben
    }
  }
}
