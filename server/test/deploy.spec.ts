// A szerveres telepítés (deploy/; kiemelési terv WP49, implementációs terv WP4) összhangja a termékkel:
// a compose a server/compose.yaml keményítését viszi, csak a címkézett image-et futtatja; a .env.example minden
// változót ismer; a host-blokk a nyers URI-t a loopback-portra adja; a deploy.sh csak a compose.yaml-t szinkronizálja,
// sudo nélkül, és a hibás kapcsolót / DEPLOY_DIR-t a szerver érintése előtt elutasítja.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DEPLOY_DIR = fileURLToPath(new URL('../../deploy/', import.meta.url));
const readDeploy = (rel: string): string => readFileSync(`${DEPLOY_DIR}${rel}`, 'utf8');
const readServer = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const compose = readDeploy('compose.yaml');
const devCompose = readServer('compose.yaml');
const envExample = readDeploy('.env.example');
const host = readDeploy('host-nginx.conf.example');
const deploy = readDeploy('deploy.sh');

const envVars = new Map(
  envExample
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
);

/** A compose `services:`-től: megjegyzések és az image-választás (build, image, pull_policy) nélkül. */
function hardening(text: string): string {
  return text
    .slice(text.indexOf('\nservices:'))
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^ {4}(build|image|pull_policy):/.test(l))
    .join('\n')
    .trim();
}

describe('deploy/compose.yaml', () => {
  it('a kész image-et futtatja a .env IMAGE_TAG-jével, regisztry nélkül', () => {
    expect(compose).toMatch(/^ {4}image: media-server:\$\{IMAGE_TAG:\?[^}]*\}$/m);
    expect(compose).toMatch(/^ {4}pull_policy: never$/m);
    expect(compose).not.toMatch(/^ {4}build:/m);
  });

  it('ugyanaz a keményítés, mint a server/compose.yaml-é (read_only, tmpfs, port, kötetek, hálózat, health, napló)', () => {
    expect(hardening(compose)).toBe(hardening(devCompose));
    expect(compose).toMatch(/read_only: true/);
    const block = /\n {4}volumes:\n((?: {6}- .*\n)+)/.exec(compose)?.[1] ?? '';
    const mounts = block.trimEnd().split('\n');
    expect(mounts.length).toBe(2);
    for (const mnt of mounts) expect(mnt.endsWith(':ro'), mnt).toBe(true);
    expect(block).not.toMatch(/\.\/(nginx|njs)\b/);
  });

  it('a compose minden változója a .env.example-ben, az alapértékek egyeznek', () => {
    const vars = new Set([...compose.matchAll(/\$\{([A-Z_]+)[:}?-]/g)].map((m) => m[1] as string));
    expect(vars.size).toBeGreaterThan(0);
    for (const v of vars) expect(envVars.has(v), v).toBe(true);
    for (const v of ['BIND', 'PORT', 'NET_SUBNET', 'NET_GATEWAY', 'COMPOSE_PROJECT_NAME']) {
      const def = new RegExp(`\\$\\{${v}:-([^}]+)\\}`).exec(compose)?.[1];
      expect(def, v).toBe(envVars.get(v));
    }
    expect(envVars.has('PREVIOUS_IMAGE_TAG')).toBe(true);
    expect(envVars.get('BIND')).toBe('127.0.0.1');
    expect(envExample).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
  });
});

describe('host-nginx blokk (WP4)', () => {
  const port = envVars.get('PORT');

  it('proxy_pass URI-rész nélkül, a .env.example portjára (különben a %2F dekódolódik)', () => {
    const passes = [...host.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1]);
    expect(passes).toEqual([`http://127.0.0.1:${port}`]);
  });

  it('a host nem naplóz tokent, nem tömörít, nem pufferel, nem cache-el', () => {
    expect(host).toMatch(/^\s*access_log off;/m);
    expect(host).toMatch(/^\s*error_log \S+ crit;/m);
    expect(host).toMatch(/^\s*gzip off;/m);
    expect(host).toMatch(/^\s*proxy_buffering off;/m);
    expect(host).toMatch(/^\s*proxy_cache off;/m);
    expect(host).toMatch(/^\s*proxy_set_header X-Forwarded-For \$remote_addr;/m);
    expect(host).toMatch(/^\s*server_name media\.example\.com;/m);
  });
});

describe('deploy.sh (WP49)', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [`${DEPLOY_DIR}deploy.sh`, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_HOST: 'nem-letezo.invalid', ...env },
      timeout: 15_000,
    });

  it('csak a compose.yaml-t szinkronizálja (--delete nélkül), sudo nélkül', () => {
    expect(deploy).toMatch(/^set -euo pipefail$/m);
    expect(deploy).not.toMatch(/\bsudo\s+(?!install -d)/);
    expect(deploy).not.toMatch(/--delete/);
    const dests = [...deploy.matchAll(/DEST="([^"]*)"/g)].map((m) => m[1]);
    expect(dests).toEqual(['$TARGET:$DEPLOY_DIR/compose.yaml', '$DEPLOY_DIR/compose.yaml']);
    expect([...deploy.matchAll(/^\s*"\$\{RSYNC\[@\]\}"/gm)]).toHaveLength(1);
  });

  it('a .env-be csak a set_tags ír (ideiglenes fájl + mv), csak az IMAGE_TAG és a PREVIOUS_IMAGE_TAG sort', () => {
    const writes = [...deploy.matchAll(/>\s*"?\$dir\/\.env"?|mv -f \S+ "\$dir\/\.env"/g)].map((m) => m[0]);
    expect(writes).toEqual(['mv -f "$tmp" "$dir/.env"']);
    expect(deploy).toMatch(/print "IMAGE_TAG=" n/);
    expect(deploy).toMatch(/print "PREVIOUS_IMAGE_TAG=" p/);
  });

  it('a docker-teszt a kiadási image-en, kötelező módban fut a váltás előtt', () => {
    expect(deploy).toMatch(/MEDIA_IMAGE="\$IMAGE" MEDIA_DOCKER_REQUIRED=1 pnpm --silent --filter @chromygabor\/media-server test:docker/);
    expect(deploy.indexOf('test:docker')).toBeLessThan(deploy.indexOf('remote switch'));
    expect(deploy.indexOf('remote verify')).toBeLessThan(deploy.indexOf('remote switch'));
  });

  it('--help: 0; ismeretlen kapcsoló, kizáró kapcsolók, --keep < 2: 2; hibás DEPLOY_DIR / átvitel: 1 (a szerver érintése előtt)', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--rollback/);
    expect(help.stdout).toMatch(/--reload-config/);
    expect(run(['--bogus']).status).toBe(2);
    expect(run(['--rollback', '--reload-config']).status).toBe(2);
    expect(run(['--keep', '1']).status).toBe(2);
    expect(run(['--rollback', '--allow-dirty']).status).toBe(2);
    expect(run(['--reload-config', '--keep', '3']).status).toBe(2);
    const root = run(['--rollback'], { DEPLOY_DIR: '/' });
    expect(root.status).toBe(1);
    expect(root.stderr).toMatch(/DEPLOY_DIR/);
    expect(run(['--rollback'], { DEPLOY_DIR: 'relativ' }).status).toBe(1);
    const transport = run(['--rollback'], { DEPLOY_TRANSPORT: 'ftp' });
    expect(transport.status).toBe(1);
    expect(transport.stderr).toMatch(/DEPLOY_TRANSPORT/);
  });
});
