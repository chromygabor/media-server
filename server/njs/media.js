// A médiaszerver token-ellenőrzése (terv 4.1–4.4; implementációs terv WP2).
// A `@chromygabor/media-sdk` `verifySignedPath`-jának önálló megvalósítása: ugyanarra a nyers kérés-URI-ra
// ugyanazt a `status`-t és `reason`-t adja (közös vektorok: @chromygabor/media-sdk/test-vectors.json,
// teszt: ../test/njs.spec.ts). Az njs 1.0.2 alapmotorja (`njs`) ÉS a Node alatt is futnia kell, ezért szűk
// JS-részhalmaz: nincs destrukturálás, spread, class, for…of, Buffer; csak `crypto.createHmac` és string-műveletek.
//
//   token        = "HS256-" + Base64URL(HMAC-SHA256(kulcs, token_path + expires + signing_data))
//   signing_data = "kid=<kid>&token_path=<előtag>[&u=<u>]" (rendezett, kódolatlan)
//   URL-útvonal  = /bcdn_token=<token>&kid=…&token_path=<kódolt>[&u=…]&expires=<n>/<app>/<assetKey>
//
// A HMAC kulcsa a kulcs szövege UTF-8-ként (Bunny-szerint); az `apps.json` értékét nem dekódoljuk.
// Az `apps.json`-t az nginx a `js_preload_object apps from …` direktívával tölti be (globális `apps`). A JSON
// szintaktikai hibájánál az `nginx -t` / reload elbukik; a tartalmi hibát (validateApps) az nginx konfigtöltéskor
// nem futtatja, ezért (1) a check-apps.js a reload előtt ellenőrzi, (2) kérésenként hibás apps.json → minden kérés
// 403 `apps-invalid` (kivétel nélkül: az error_log sorában a kérés-sor, benne a token, megjelenne).

import crypto from 'crypto';

var TOKEN_PREFIX = 'HS256-';
var TOKEN_RE = /^HS256-[A-Za-z0-9_-]{43}$/;
var EXPIRES_RE = /^(0|[1-9][0-9]{0,11})$/;
var ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
var SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Kulcs az `apps.json`-ban: base64 / base64url szöveg, legalább 43 jel (≈ 32 bájt entrópia). */
var KEY_RE = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;
var SEGMENT_START = '/bcdn_token=';
var ALLOWED_PARAMS = ['kid', 'token_path', 'u'];

/** A backend `MEDIA_CONTENT_TYPES`-ának megfelelője (terv 4.4); a media.conf `types` táblája ugyanez. */
var MEDIA_CONTENT_TYPES = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg' };
var CONTENT_DIR = '_content';
var CONTENT_FILE_EXT = '.json.gz';
var CONTENT_FILE_TYPE = 'application/gzip';
var CORP_VALUES = ['same-site', 'same-origin', 'cross-origin'];
var CACHE_BROWSER = 'private, max-age=3600';
var CACHE_NONE = 'no-store';
/** A naplóba írt útvonal felső hossza (a token nélküli rész). */
var LOG_PATH_MAX = 512;

function hasOwn(o, k) {
  return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

function isSafeSegment(s) {
  return SAFE_SEGMENT.test(s);
}

function isSafeMediaPath(path) {
  if (path.charAt(0) !== '/') return false;
  var segs = path.slice(1).split('/');
  if (segs.length < 2) return false;
  for (var i = 0; i < segs.length; i++) if (!isSafeSegment(segs[i])) return false;
  return true;
}

function isSafeTokenPath(tp) {
  if (tp.charAt(0) !== '/') return false;
  var body = tp.endsWith('/') ? tp.slice(1, -1) : tp.slice(1);
  if (body === '') return false;
  var segs = body.split('/');
  for (var i = 0; i < segs.length; i++) if (!isSafeSegment(segs[i])) return false;
  return true;
}

function isPrefixOf(tp, path) {
  if (tp === '') return false;
  return tp.endsWith('/') ? path.startsWith(tp) : path === tp;
}

/** Kiterjesztés-tábla (terv 4.4): { app, assetKey, kind, contentType } vagy null (→ 404). */
function classifyMediaPath(path) {
  if (!isSafeMediaPath(path)) return null;
  var segs = path.slice(1).split('/');
  var app = segs[0];
  var rest = segs.slice(1);
  var assetKey = rest.join('/');
  var file = rest[rest.length - 1];
  if (rest[0].charAt(0) === '_') {
    if (
      rest[0] === CONTENT_DIR &&
      rest.length === 2 &&
      file.endsWith(CONTENT_FILE_EXT) &&
      file.length > CONTENT_FILE_EXT.length
    ) {
      return { app: app, assetKey: assetKey, kind: 'content', contentType: CONTENT_FILE_TYPE };
    }
    return null;
  }
  var dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  var ext = file.slice(dot);
  if (!hasOwn(MEDIA_CONTENT_TYPES, ext)) return null;
  return { app: app, assetKey: assetKey, kind: 'browser', contentType: MEDIA_CONTENT_TYPES[ext] };
}

/** Időállandó összehasonlítás (azonos hosszra), saját XOR-ciklussal (terv 4.1). */
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function computeToken(key, tokenPath, expires, kid, u) {
  // A rendezett signing_data: kid < token_path < u.
  var signingData = 'kid=' + kid + '&token_path=' + tokenPath + (u === undefined ? '' : '&u=' + u);
  var digest = crypto
    .createHmac('sha256', key)
    .update(tokenPath + expires + signingData)
    .digest('base64url');
  return TOKEN_PREFIX + digest.replace(/=+$/, '');
}

/** A nyers URI szigorú szétszedése; { error } vagy { token, kid, tokenPath, u, expires, expiresStr, path }. */
function parseSignedPath(rawUri) {
  var q = rawUri.indexOf('?');
  var uri = q === -1 ? rawUri : rawUri.slice(0, q);
  if (!uri.startsWith(SEGMENT_START)) return { error: 'missing-token' };
  var slash = uri.indexOf('/', 1);
  if (slash === -1) return { error: 'malformed' };
  var parts = uri.slice(1, slash).split('&');
  var path = uri.slice(slash);
  if (parts.length < 2) return { error: 'malformed' };

  var token = parts[0].slice('bcdn_token='.length);
  if (!TOKEN_RE.test(token)) return { error: 'malformed-token' };

  var last = parts[parts.length - 1];
  if (!last.startsWith('expires=')) return { error: 'malformed-expires' };
  var expiresStr = last.slice('expires='.length);
  if (!EXPIRES_RE.test(expiresStr)) return { error: 'malformed-expires' };

  var params = {};
  for (var i = 1; i < parts.length - 1; i++) {
    var part = parts[i];
    var eq = part.indexOf('=');
    if (eq <= 0) return { error: 'malformed' };
    var name = part.slice(0, eq);
    var raw = part.slice(eq + 1);
    if (ALLOWED_PARAMS.indexOf(name) === -1) return { error: 'unknown-param' };
    if (hasOwn(params, name)) return { error: 'duplicate-param' };
    var value;
    try {
      value = decodeURIComponent(raw);
      // A paraméter nélküli `catch {}`-ot az njs nem ismeri.
      // oxlint-disable-next-line no-unused-vars
    } catch (_e) {
      return { error: 'malformed-param' };
    }
    if (value === '' || encodeURIComponent(value) !== raw) return { error: 'malformed-param' };
    params[name] = value;
  }
  if (!hasOwn(params, 'kid') || !hasOwn(params, 'token_path')) return { error: 'missing-param' };
  var u = hasOwn(params, 'u') ? params.u : undefined;
  if (!ID_RE.test(params.kid) || (u !== undefined && !ID_RE.test(u))) return { error: 'malformed-param' };
  return {
    token: token,
    kid: params.kid,
    tokenPath: params.token_path,
    u: u,
    expires: Number(expiresStr),
    expiresStr: expiresStr,
    path: path,
  };
}

function tokenPathProblem(tp, path, app, kind, u) {
  if (!tp.startsWith('/' + app + '/')) return 'token-path-app';
  if (!isSafeTokenPath(tp)) return 'token-path-shape';
  if (kind === 'browser' && !tp.endsWith('/')) return 'token-path-shape';
  if (kind === 'content') {
    if (tp !== path) return 'token-path-shape';
    if (u !== undefined) return 'u-not-allowed';
  }
  if (!isPrefixOf(tp, path)) return 'outside-token-path';
  return null;
}

function keyOf(map, kid) {
  if (!hasOwn(map, kid)) return undefined;
  var key = map[kid];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

function fail(status, reason) {
  return { ok: false, status: status, reason: reason };
}

/**
 * Ellenőrzés a terv 4.4 sorrendjében (= `verifySignedPath`): alak 403 → kiterjesztés-tábla 404 → app → kid →
 * kulcsfajta → HMAC (időállandó) → token_path 403 → lejárat 410. `apps`: { <app>: { keys, contentKeys, … } };
 * `now` unix-másodperc. A fájl létezését az nginx nézi.
 */
function verify(rawUri, apps, now) {
  var p = parseSignedPath(rawUri);
  if (hasOwn(p, 'error')) return fail(403, p.error);
  if (!isSafeMediaPath(p.path)) return fail(403, 'unsafe-path');
  var info = classifyMediaPath(p.path);
  if (info === null) return fail(404, 'not-servable');

  var appCfg = hasOwn(apps, info.app) ? apps[info.app] : undefined;
  if (appCfg === undefined || appCfg === null || typeof appCfg !== 'object') return fail(403, 'unknown-app');
  var browserKey = keyOf(appCfg.keys, p.kid);
  var contentKey = keyOf(appCfg.contentKeys, p.kid);
  var key = info.kind === 'content' ? contentKey : browserKey;
  if (key === undefined) {
    var other = info.kind === 'content' ? browserKey : contentKey;
    return fail(403, other === undefined ? 'unknown-kid' : 'wrong-key-kind');
  }

  var expected = computeToken(key, p.tokenPath, p.expiresStr, p.kid, p.u);
  if (!timingSafeEqualStr(expected, p.token)) return fail(403, 'bad-signature');

  var problem = tokenPathProblem(p.tokenPath, p.path, info.app, info.kind, p.u);
  if (problem !== null) return fail(403, problem);
  if (now > p.expires) return fail(410, 'expired');

  return {
    ok: true,
    app: info.app,
    kid: p.kid,
    u: p.u,
    path: p.path,
    assetKey: info.assetKey,
    kind: info.kind,
    contentType: info.contentType,
  };
}

/** Az `apps.json` ellenőrzése (terv 4.3); a hibák listája (üres, ha rendben). */
function validateApps(obj) {
  var errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return ['a gyökér nem objektum'];
  var names = Object.keys(obj);
  if (names.length === 0) errors.push('nincs egy app sem');
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var a = obj[name];
    var at = 'apps["' + name + '"]';
    if (!isSafeSegment(name) || name.charAt(0) === '_') errors.push(at + ': érvénytelen app-név');
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      errors.push(at + ': nem objektum');
      continue;
    }
    if (typeof a.dir !== 'string' || !isSafeDir(a.dir)) errors.push(at + '.dir: érvénytelen könyvtár');
    // Prototípus nélküli halmaz: egy sima objektumon a `kids['__proto__'] = true` a prototípust állítaná, saját
    // mezőt nem, és a `__proto__` kid ütközése elveszne (javítási terv P16).
    var kids = Object.create(null);
    var maps = ['keys', 'contentKeys'];
    for (var m = 0; m < maps.length; m++) {
      var map = a[maps[m]];
      if (map === null || typeof map !== 'object' || Array.isArray(map)) {
        errors.push(at + '.' + maps[m] + ': nem objektum');
        continue;
      }
      var ks = Object.keys(map);
      for (var k = 0; k < ks.length; k++) {
        var kid = ks[k];
        if (!ID_RE.test(kid)) errors.push(at + '.' + maps[m] + ': érvénytelen kid: ' + kid);
        if (typeof map[kid] !== 'string' || !KEY_RE.test(map[kid])) {
          errors.push(at + '.' + maps[m] + '["' + kid + '"]: a kulcs nem legalább 43 jeles base64(url) szöveg');
        }
        if (kid in kids) errors.push(at + ': a kid a keys-ben és a contentKeys-ben is szerepel: ' + kid);
        kids[kid] = true;
      }
    }
    if (a.origins !== undefined) {
      if (!Array.isArray(a.origins)) errors.push(at + '.origins: nem tömb');
      else {
        for (var o = 0; o < a.origins.length; o++) {
          var orig = a.origins[o];
          if (typeof orig !== 'string' || !/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(orig)) {
            errors.push(at + '.origins: érvénytelen origin: ' + String(orig));
          }
        }
      }
    }
    if (a.corp !== undefined && CORP_VALUES.indexOf(a.corp) === -1) errors.push(at + '.corp: érvénytelen érték');
  }
  return errors;
}

/** `dir`: `.` vagy biztonságos szegmensekből álló relatív útvonal. */
function isSafeDir(dir) {
  if (dir === '.') return true;
  if (dir === '') return false;
  var segs = dir.split('/');
  for (var i = 0; i < segs.length; i++) if (!isSafeSegment(segs[i])) return false;
  return true;
}

// --- nginx-bekötés (js_set változók) ------------------------------------------------------------------------

/* global apps */
var APPS = typeof apps === 'undefined' ? null : apps;
/** Az apps.json érvényessége (a VM-enként egyszer számolva; njs-ben a VM kérésenkénti). */
var appsValid = null;

function appsOk() {
  if (appsValid === null) appsValid = APPS !== null && validateApps(APPS).length === 0;
  return appsValid;
}

/** A kérés eredménye egyszer számolva (a js_set változók ugyanazt használják). */
var memo = { id: null, res: null };

function result(r) {
  var id = r.variables.request_id;
  if (memo.id !== id || memo.res === null) {
    memo.id = id;
    try {
      memo.res = appsOk()
        ? verify(r.variables.request_uri, APPS, Math.floor(Date.now() / 1000))
        : fail(403, 'apps-invalid');
      // oxlint-disable-next-line no-unused-vars
    } catch (e) {
      // Kivétel nem mehet az error_logba: a naplósor a kérés-sort (benne a tokent) is tartalmazná.
      memo.res = fail(403, 'internal-error');
    }
  }
  return memo.res;
}

/** A nyers URI token nélküli útvonala (napló, CORS): a query és a `/bcdn_token=…` szegmens levágva. */
function plainPath(rawUri) {
  var q = rawUri.indexOf('?');
  var uri = q === -1 ? rawUri : rawUri.slice(0, q);
  if (uri.startsWith(SEGMENT_START)) {
    var slash = uri.indexOf('/', 1);
    uri = slash === -1 ? '' : uri.slice(slash);
  }
  return uri;
}

/** Az útvonal első szegmenséből az app beállítása (hitelesítés nélkül: CORS, CORP). */
function appConfigOf(r) {
  var path = plainPath(r.variables.request_uri);
  var app = path.split('/')[1] || '';
  if (!appsOk() || !isSafeSegment(app) || !hasOwn(APPS, app)) return null;
  return APPS[app];
}

function status(r) {
  var res = result(r);
  return res.ok ? 'ok' : String(res.status);
}

function reason(r) {
  var res = result(r);
  return res.ok ? '' : res.reason;
}

/** A kiszolgálandó fájl a `/srv/media` alatt: `/<dir>/<assetKey>` (`dir` = `.` → `/<assetKey>`). */
function file(r) {
  var res = result(r);
  if (!res.ok) return '';
  var dir = APPS[res.app].dir;
  return '/' + (dir === '.' ? '' : dir + '/') + res.assetKey;
}

function app(r) {
  var res = result(r);
  return res.ok ? res.app : '';
}

function kid(r) {
  var res = result(r);
  return res.ok ? res.kid : '';
}

function user(r) {
  var res = result(r);
  return res.ok && res.u !== undefined ? res.u : '';
}

/** A felhasználónkénti limit_conn kulcsa; `u` nélkül üres (→ nem korlátoz). */
function userKey(r) {
  var res = result(r);
  return res.ok && res.u !== undefined ? res.app + ' ' + res.u : '';
}

function path(r) {
  return plainPath(r.variables.request_uri).slice(0, LOG_PATH_MAX);
}

function cache(r) {
  var res = result(r);
  return res.ok && res.kind === 'browser' ? CACHE_BROWSER : CACHE_NONE;
}

function corp(r) {
  var cfg = appConfigOf(r);
  return cfg !== null && typeof cfg.corp === 'string' ? cfg.corp : 'same-site';
}

function corsOrigin(r) {
  try {
    var origin = r.headersIn.Origin;
    var cfg = appConfigOf(r);
    if (typeof origin !== 'string' || cfg === null || !Array.isArray(cfg.origins)) return '';
    // Az előtöltött (js_preload_object) tömbökön nincs Array.prototype-metódus (indexOf sem): kézi ciklus.
    for (var i = 0; i < cfg.origins.length; i++) if (cfg.origins[i] === origin) return origin;
    return '';
    // oxlint-disable-next-line no-unused-vars
  } catch (e) {
    return '';
  }
}

/** A sikeres választ adó állapotok: csak ezeken jár a böngésző-cache (terv 4.2, 4.4). */
var CACHEABLE_STATUS = { 200: true, 206: true, 304: true };
var CORS_EXPOSE = 'Content-Length, Content-Range, Accept-Ranges';
var CORS_METHODS = 'GET, HEAD, OPTIONS';
var CORS_HEADERS = 'Range, If-Range';
var CORS_MAX_AGE = '600';

/**
 * A fő location válaszfejlécei (js_header_filter; terv 4.4). BEÁLLÍT, nem hozzáfűz: a 416-ot az nginx a
 * fejlécszűrők második futásával küldi (a range-szűrő a 200-as fejlécek után dönt), így az `add_header … always`
 * minden fejlécet kétszer írt ki, és a Cache-Control a 200-asé maradt (WP3-ban talált hiba). Itt a második futás
 * a már meglévő értéket írja felül, és a Cache-Control a tényleges állapotból számol.
 */
function headers(r) {
  try {
    var h = r.headersOut;
    h['X-Content-Type-Options'] = 'nosniff';
    h['Content-Disposition'] = 'inline';
    h['Cross-Origin-Resource-Policy'] = corp(r);
    h['Cache-Control'] = hasOwn(CACHEABLE_STATUS, String(r.status)) ? cache(r) : CACHE_NONE;
    h['Vary'] = 'Origin';
    // RFC 9110: a 405 megnevezi az engedett metódusokat (D100). A `return 405` a fő location-ben van, a szűrő
    // lefut rá; `add_header` nincs, így a 416-os kettőzés sem jöhet vissza.
    if (r.status === 405) h['Allow'] = CORS_METHODS;
    var origin = corsOrigin(r);
    if (origin !== '') {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Expose-Headers'] = CORS_EXPOSE;
      h['Access-Control-Allow-Methods'] = CORS_METHODS;
      h['Access-Control-Allow-Headers'] = CORS_HEADERS;
      h['Access-Control-Max-Age'] = CORS_MAX_AGE;
    }
    // oxlint-disable-next-line no-unused-vars
  } catch (e) {
    // Kivétel nem mehet az error_logba (a kérés-sorban a token); a fejlécek nélkül is biztonságos a válasz.
  }
}

/** Érvénytelen token: a 403 a content-fázisban, hogy a @denied location limit_req-je előtte lefusson. */
function denied(r) {
  r.headersOut['Content-Type'] = 'text/plain';
  r.return(403, 'forbidden\n');
}

export default {
  // nginx (js_set)
  status: status,
  reason: reason,
  file: file,
  app: app,
  kid: kid,
  user: user,
  userKey: userKey,
  path: path,
  cache: cache,
  corp: corp,
  corsOrigin: corsOrigin,
  // nginx (js_header_filter)
  headers: headers,
  // nginx (js_content)
  denied: denied,
  // tesztekhez
  verify: verify,
  validateApps: validateApps,
  plainPath: plainPath,
  MEDIA_CONTENT_TYPES: MEDIA_CONTENT_TYPES,
};
