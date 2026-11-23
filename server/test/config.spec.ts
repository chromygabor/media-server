// A konfigfájlok összhangja (implementációs terv WP2 7.): a kiterjesztés-tábla a backend MEDIA_CONTENT_TYPES-ának
// itt tartott másolatával egyezik (a backendből nem importálunk); a compose minden változója a .env.example-ben;
// rögzített image; a napló nem tartalmazhat tokent.

import { readFileSync } from 'node:fs';
import { MEDIA_CONTENT_TYPES as TOKEN_TYPES, CONTENT_FILE_TYPE } from '@workspace/media-token';
import { describe, expect, it } from 'vitest';
import media from '../njs/media.js';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** A backend táblájának MÁSOLATA: a fogyasztó backend media-store-ja `MEDIA_CONTENT_TYPES` (terv 4.4, P7). */
const BACKEND_MEDIA_CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

const compose = read('compose.yaml');
const envExample = read('.env.example');
const nginxConf = read('nginx/nginx.conf');
const mediaConf = read('nginx/media.conf');

describe('kiterjesztés-tábla', () => {
  it('njs = media-token = a backend másolata', () => {
    expect(media.MEDIA_CONTENT_TYPES).toEqual(BACKEND_MEDIA_CONTENT_TYPES);
    expect(TOKEN_TYPES).toEqual(BACKEND_MEDIA_CONTENT_TYPES);
  });

  it('az nginx types táblája pontosan ezeket és a .gz-t adja', () => {
    const block = /types\s*\{([^}]*)\}/.exec(nginxConf)?.[1] ?? '';
    const table = Object.fromEntries(
      block
        .split(';')
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length === 2)
        .map(([type, ext]) => [`.${ext}`, type]),
    );
    expect(table).toEqual({ ...BACKEND_MEDIA_CONTENT_TYPES, '.gz': CONTENT_FILE_TYPE });
  });
});

describe('compose.yaml és .env.example', () => {
  const composeVars = [...compose.matchAll(/\$\{([A-Z_]+)[:}?-]/g)].map((m) => m[1] as string);
  const envVars = new Map(
    envExample
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );

  it('a compose minden változója a .env.example-ben', () => {
    expect(composeVars.length).toBeGreaterThan(0);
    for (const v of new Set(composeVars)) expect(envVars.has(v), v).toBe(true);
  });

  it('a compose alapértékei = a .env.example értékei (BIND, PORT, NET_*)', () => {
    for (const v of ['BIND', 'PORT', 'NET_SUBNET', 'NET_GATEWAY', 'COMPOSE_PROJECT_NAME']) {
      const def = new RegExp(`\\$\\{${v}:-([^}]+)\\}`).exec(compose)?.[1];
      expect(def, v).toBe(envVars.get(v));
    }
    expect(envVars.get('BIND')).toBe('127.0.0.1');
    expect(envVars.get('PORT')).toBe('10090');
  });

  it('a .env.example-ben nincs kulcs', () => {
    expect(envExample).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
  });

  it('rögzített image tag + digest (WP0)', () => {
    expect(compose).toMatch(/image: nginx:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}\n/);
  });

  it('csak olvasható gyökér és kötetek', () => {
    expect(compose).toMatch(/read_only: true/);
    const block = /\n {4}volumes:\n((?: {6}- .*\n)+)/.exec(compose)?.[1] ?? '';
    const mounts = block.trimEnd().split('\n');
    expect(mounts.length).toBe(4);
    for (const mnt of mounts) expect(mnt.endsWith(':ro'), mnt).toBe(true);
  });

  it('a real_ip az átjárót bízza meg (envsubst-sablon)', () => {
    expect(read('nginx/templates/realip.conf.template')).toMatch(/^set_real_ip_from\s+\$\{NET_GATEWAY\};$/m);
    expect(nginxConf).toMatch(/real_ip_header\s+X-Forwarded-For;/);
    expect(nginxConf).toMatch(/real_ip_recursive\s+off;/);
  });
});

describe('napló: token nélkül', () => {
  const logFormat = /log_format media_json[\s\S]*?';/.exec(mediaConf)?.[0] ?? '';
  it('a log_format létezik, és nem tartalmazza a nyers URI-t, a query-t vagy a kérés-sort', () => {
    expect(logFormat).toContain('$media_path');
    for (const v of ['$request_uri', '$request ', '$request"', '$args', '$query_string', '$uri', '$http_referer']) {
      expect(logFormat, v).not.toContain(v);
    }
  });
  it('a limit_* elutasítások a warn szint alatt naplóznak (a kérés-sorban token van)', () => {
    expect(nginxConf).toMatch(/error_log\s+\/dev\/stderr\s+warn;/);
    expect(mediaConf).toMatch(/limit_conn_log_level\s+info;/);
    expect(mediaConf).toMatch(/limit_req_log_level\s+info;/);
  });
});

describe('deploy: host-nginx blokk és deploy.sh (WP4)', () => {
  const host = read('deploy/host-nginx.conf.example');
  const deploy = read('deploy/deploy.sh');
  const port = /^PORT=(\d+)$/m.exec(envExample)?.[1];

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

  it('a deploy.sh csak a compose.yaml-t, az nginx/-t és az njs/-t szinkronizálja, sudo nélkül', () => {
    expect(deploy).toMatch(/^set -euo pipefail$/m);
    expect(deploy).toMatch(/for d in nginx njs; do/);
    expect(deploy).not.toMatch(/\bsudo\s+(?!install -d)/);
    const rsyncTargets = [...deploy.matchAll(/"\$TARGET:\$DEPLOY_DIR\/([^"]*)"/g)].map((m) => m[1]);
    expect(rsyncTargets).toEqual(['compose.yaml', '$d/']);
  });
});
