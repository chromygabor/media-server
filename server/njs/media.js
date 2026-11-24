// A médiaszerver token-ellenőrzése (terv 4.1–4.4; implementációs terv WP2; az ES256 séma és a
// kapu: aszimmetrikus terv WP52, D111–D119).
// A `@chromygabor/media-sdk` `verifySignedPath`-jának önálló megvalósítása: ugyanarra a nyers kérés-URI-ra
// ugyanazt a `status`-t és `reason`-t adja (közös vektorok: @chromygabor/media-sdk/test-vectors.json, az ES256-ra
// az `es256.verify`; teszt: ../test/njs.spec.ts). Az njs 1.0.2 mindkét motorja (`njs`, QuickJS) ÉS a Node alatt is
// futnia kell, ezért szűk JS-részhalmaz: nincs destrukturálás, spread, class, for…of, Buffer; `crypto.createHmac`
// (a `crypto` modul `hmacCrypto` néven), a WebCrypto (`crypto.subtle`, globális) és string-műveletek.
//
//   token        = "HS256-" + Base64URL(HMAC-SHA256(kulcs, M))
//                | "ES256-" + Base64URL(r ‖ s)       (ECDSA P-256 + SHA-256 az M-en, 32+32 bájt, low-S)
//   M            = token_path + expires + signing_data
//   signing_data = "kid=<kid>&token_path=<előtag>[&u=<u>]" (rendezett, kódolatlan)
//   URL-útvonal  = /bcdn_token=<token>&kid=…&token_path=<kódolt>[&u=…]&expires=<n>/<app>/<assetKey>
//
// A séma a `kid`-ből jön (`keys`/`contentKeys` → HS256, `publicKeys`/`contentPublicKeys` → ES256), soha nem a
// tokenből. A HMAC kulcsa a kulcs szövege UTF-8-ként (Bunny-szerint); az `apps.json` értékét nem dekódoljuk. Az ES256
// nyilvános kulcsa a tömörítetlen P-256 pont base64url-ben (`importKey('raw')`).
// Az `apps.json`-t az nginx a `js_preload_object apps from …` direktívával tölti be (globális `apps`). A JSON
// szintaktikai hibájánál az `nginx -t` / reload elbukik; a tartalmi hibát (validateApps) az nginx konfigtöltéskor
// nem futtatja, ezért (1) a check-apps.js a reload előtt ellenőrzi (a nyilvános kulcsok görbéjét is), (2)
// kérésenként hibás apps.json → minden kérés 403 `apps-invalid` (kivétel nélkül: az error_log sorában a kérés-sor,
// benne a token, megjelenne).
//
// A kapu (D112): a fő location `js_content`-je (`gate`) aszinkron ellenőriz, az eredményt `js_var`-okba írja, és
// sikernél `r.internalRedirect('@serve')`, hibánál `r.return(<státusz>)` törzs nélkül (az `error_page` a named
// location-ökre visz). Aszimmetrikus kid-re IP-nkénti hibaszámláló (D116): `FAILS_LIMIT` hibás aláírás
// `FAILS_WINDOW_MS` alatt → 429 (`reason: blocked`, csak a naplóban).

// Az `import crypto from 'crypto'` a globális WebCryptót (crypto.subtle) elfedné (terv P4): más néven.
import hmacCrypto from 'crypto';

var TOKEN_PREFIX = 'HS256-';
var ES256_PREFIX = 'ES256-';
/** `HS256-` + 32 bájt, vagy `ES256-` + 64 bájt Base64URL-ben (a 86. jel kanonikus: 4 kitöltő bit nulla). */
var TOKEN_RE = /^(HS256-[A-Za-z0-9_-]{43}|ES256-[A-Za-z0-9_-]{85}[AQgw])$/;
var EXPIRES_RE = /^(0|[1-9][0-9]{0,11})$/;
var ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
var SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Kulcs az `apps.json`-ban: base64 / base64url szöveg, legalább 43 jel (≈ 32 bájt entrópia). */
var KEY_RE = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;
/** ES256 nyilvános kulcs: a tömörítetlen P-256 pont (65 bájt, `0x04` ‖ X ‖ Y) kanonikus base64url-ben, 87 jel. */
var PUBLIC_KEY_RE = /^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/;
var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A P-256 rendjének fele (`n/2`, lefelé kerekítve), 32 bájt big-endian: a low-S szabályhoz (BigInt nélkül). */
var P256_HALF_N = hexBytes('7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8');
var ECDSA_IMPORT = { name: 'ECDSA', namedCurve: 'P-256' };
var ECDSA_VERIFY = { name: 'ECDSA', hash: 'SHA-256' };
/** Hibaszámláló (D116): ennyi hibás ES256-aláírás egy IP-ről az ablakon belül → 429; csak aszimmetrikus kid-re. */
var FAILS_LIMIT = 50;
var FAILS_WINDOW_MS = 10000;
/** A `js_shared_dict_zone` neve (nginx.conf). */
var FAILS_ZONE = 'media_fails';
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

function hexBytes(hex) {
  var out = new Uint8Array(hex.length / 2);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Base64URL (kitöltés nélkül) → bájtok; hibás jelnél `null`. A maradék bitek eldobva (a regexek kanonikusak). */
function base64urlBytes(s) {
  var out = new Uint8Array(Math.floor((s.length * 6) / 8));
  var acc = 0;
  var bits = 0;
  var j = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64URL.indexOf(s.charAt(i));
    if (v === -1) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** A szöveg UTF-8 bájtjai (a `node:crypto` `Buffer.from(s, 'utf8')`-jével azonos; Buffer és TextEncoder nélkül). */
function utf8Bytes(s) {
  var e = encodeURIComponent(s);
  var out = [];
  for (var i = 0; i < e.length; i++) {
    if (e.charAt(i) === '%') {
      out.push(parseInt(e.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(e.charCodeAt(i));
    }
  }
  return new Uint8Array(out);
}

/** Low-S-e az `r ‖ s` aláírás: az `s` (32 bájt big-endian) ≤ n/2, bájtonkénti összevetéssel. */
function isLowS(sig) {
  for (var i = 0; i < 32; i++) {
    var a = sig[32 + i];
    var b = P256_HALF_N[i];
    if (a !== b) return a < b;
  }
  return true;
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

/** Az aláírt szöveg: `M = token_path + expires + signing_data` (mindkét sémában ugyanaz). */
function signedMessage(tokenPath, expires, kid, u) {
  // A rendezett signing_data: kid < token_path < u.
  return tokenPath + expires + 'kid=' + kid + '&token_path=' + tokenPath + (u === undefined ? '' : '&u=' + u);
}

function computeToken(key, message) {
  var digest = hmacCrypto.createHmac('sha256', key).update(message).digest('base64url');
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

/** Egy kulcsfajta kulcsa a kid-hez, sémával: `{ scheme, key }` vagy `undefined`, ha a kid egyik térképben sincs. */
function schemeKeyOf(hmacMap, publicMap, kid) {
  var key = keyOf(hmacMap, kid);
  if (key !== undefined) return { scheme: 'HS256', key: key };
  var publicKey = keyOf(publicMap, kid);
  return publicKey === undefined ? undefined : { scheme: 'ES256', key: publicKey };
}

/**
 * Az ellenőrzés olcsó, szinkron része a SPEC 4. sorrendjében, az aláírásig (6b előtt): alak 403 → kiterjesztés-tábla
 * 404 → app → kid → kulcsfajta → séma (6a, `wrong-scheme`). Eredmény: `fail(…)` vagy
 * `{ ok: true, p, info, scheme, key }` (a `scheme` `HS256` vagy `ES256`, a `key` a HMAC-kulcs, illetve a nyilvános kulcs).
 */
function prepare(rawUri, apps) {
  var p = parseSignedPath(rawUri);
  if (hasOwn(p, 'error')) return fail(403, p.error);
  if (!isSafeMediaPath(p.path)) return fail(403, 'unsafe-path');
  var info = classifyMediaPath(p.path);
  if (info === null) return fail(404, 'not-servable');

  var appCfg = hasOwn(apps, info.app) ? apps[info.app] : undefined;
  if (appCfg === undefined || appCfg === null || typeof appCfg !== 'object') return fail(403, 'unknown-app');
  var browserKey = schemeKeyOf(appCfg.keys, appCfg.publicKeys, p.kid);
  var contentKey = schemeKeyOf(appCfg.contentKeys, appCfg.contentPublicKeys, p.kid);
  var sk = info.kind === 'content' ? contentKey : browserKey;
  if (sk === undefined) {
    var other = info.kind === 'content' ? browserKey : contentKey;
    return fail(403, other === undefined ? 'unknown-kid' : 'wrong-key-kind');
  }
  if (!p.token.startsWith(sk.scheme === 'HS256' ? TOKEN_PREFIX : ES256_PREFIX)) return fail(403, 'wrong-scheme');
  return { ok: true, p: p, info: info, scheme: sk.scheme, key: sk.key };
}

/**
 * Az aláírás (6b): HMAC időállandó összevetéssel (szinkron), ES256 low-S + WebCrypto `verify` (aszinkron). Mindig
 * Promise<boolean>; az ES256 kulcsimportjának hibája (görbén kívüli pont) elutasított Promise (→ `internal-error`).
 */
function checkSignature(prep) {
  var p = prep.p;
  var message = signedMessage(p.tokenPath, p.expiresStr, p.kid, p.u);
  if (prep.scheme === 'HS256') return Promise.resolve(timingSafeEqualStr(computeToken(prep.key, message), p.token));
  var sig = base64urlBytes(p.token.slice(ES256_PREFIX.length));
  if (sig === null || sig.length !== 64 || !isLowS(sig)) return Promise.resolve(false);
  var raw = base64urlBytes(prep.key);
  if (raw === null) return Promise.reject(new Error('nyilvános kulcs'));
  return crypto.subtle.importKey('raw', raw, ECDSA_IMPORT, false, ['verify']).then(function (key) {
    return crypto.subtle.verify(ECDSA_VERIFY, key, sig, utf8Bytes(message));
  });
}

/** Az aláírás utáni lépések: token_path 403 → lejárat 410 → siker. */
function finish(prep, now) {
  var p = prep.p;
  var info = prep.info;
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

/**
 * Ellenőrzés a SPEC 4. sorrendjében (= `verifySignedPath`): alak 403 → kiterjesztés-tábla 404 → app → kid →
 * kulcsfajta → séma (`wrong-scheme`) → aláírás (HMAC időállandóan; ES256 low-S + ECDSA) → token_path 403 →
 * lejárat 410. Aszinkron: `Promise<eredmény>`, amely nem utasít el (a belső hiba `403 internal-error`).
 * `apps`: { <app>: { keys, contentKeys, publicKeys?, contentPublicKeys?, … } }; `now` unix-másodperc. A fájl
 * létezését az nginx nézi.
 */
function verify(rawUri, apps, now) {
  var prep;
  try {
    prep = prepare(rawUri, apps);
    if (!prep.ok) return Promise.resolve(prep);
    return checkSignature(prep).then(
      function (good) {
        return good ? finish(prep, now) : fail(403, 'bad-signature');
      },
      // oxlint-disable-next-line no-unused-vars
      function (_e) {
        return fail(403, 'internal-error');
      },
    );
    // oxlint-disable-next-line no-unused-vars
  } catch (_e) {
    return Promise.resolve(fail(403, 'internal-error'));
  }
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
    var browserPublic = Object.create(null);
    var maps = ['keys', 'contentKeys', 'publicKeys', 'contentPublicKeys'];
    for (var m = 0; m < maps.length; m++) {
      var field = maps[m];
      var map = a[field];
      // A két nyilvános kulcstérkép elhagyható (a régi apps.json-ok érvényesek maradnak).
      var isPublic = field === 'publicKeys' || field === 'contentPublicKeys';
      if (isPublic && map === undefined) continue;
      if (map === null || typeof map !== 'object' || Array.isArray(map)) {
        errors.push(at + '.' + field + ': nem objektum');
        continue;
      }
      var ks = Object.keys(map);
      for (var k = 0; k < ks.length; k++) {
        var kid = ks[k];
        var value = map[kid];
        if (!ID_RE.test(kid)) errors.push(at + '.' + field + ': érvénytelen kid: ' + kid);
        if (!isPublic && (typeof value !== 'string' || !KEY_RE.test(value))) {
          errors.push(at + '.' + field + '["' + kid + '"]: a kulcs nem legalább 43 jeles base64(url) szöveg');
        }
        if (isPublic && (typeof value !== 'string' || !PUBLIC_KEY_RE.test(value))) {
          errors.push(at + '.' + field + '["' + kid + '"]: a nyilvános kulcs nem 87 jeles, tömörítetlen P-256 pont');
        }
        if (field === 'publicKeys' && typeof value === 'string') browserPublic[value] = true;
        if (field === 'contentPublicKeys' && typeof value === 'string' && value in browserPublic) {
          errors.push(at + '.' + field + '["' + kid + '"]: ugyanez a nyilvános kulcs a publicKeys-ben is szerepel');
        }
        if (kid in kids) errors.push(at + ': a kid több kulcstérképben is szerepel: ' + kid);
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

// --- nginx-bekötés (kapu, js_var-ok, fejlécszűrő) -------------------------------------------------------------

/* global apps, ngx */
var APPS = typeof apps === 'undefined' ? null : apps;
/** Az apps.json érvényessége (a VM-enként egyszer számolva; njs-ben a VM kérésenkénti). */
var appsValid = null;

function appsOk() {
  if (appsValid === null) appsValid = APPS !== null && validateApps(APPS).length === 0;
  return appsValid;
}

/** A hibaszámláló zónája (`js_shared_dict_zone`, nginx.conf); nginx nélkül (Node, njs CLI) `null`: nem számol. */
function failsZone() {
  if (typeof ngx !== 'object' || ngx === null || !ngx.shared) return null;
  var zone = ngx.shared[FAILS_ZONE];
  return zone === undefined ? null : zone;
}

/** Elérte-e az IP a küszöböt (az ellenőrzés előtt, csak aszimmetrikus kid-re; D116). */
function isBlocked(zone, ip) {
  var n = zone.get(ip);
  return typeof n === 'number' && n >= FAILS_LIMIT;
}

/** Egy hibás ES256-aláírás számolása; az explicit `timeout` nélkül a bejegyzés nem jár le (terv 1.5). */
function countFailure(zone, ip) {
  try {
    zone.incr(ip, 1, 0, FAILS_WINDOW_MS);
    // oxlint-disable-next-line no-unused-vars
  } catch (_e) {
    // A számláló hibája (pl. tele a zóna) nem változtat a döntésen (403).
  }
}

/**
 * A döntés a `js_var`-okba (a napló és a `@serve` olvassa; az átirányítás után is megmaradnak), majd siker:
 * `@serve`; hiba: `r.return(<státusz>)` törzs nélkül, így az `error_page` a named location-re visz (403 → `@denied`
 * a `limit_req`-jével, 404 → `@notfound`, 410 → `@gone`, 429 → `@toomany`).
 */
function decide(r, res) {
  var v = r.variables;
  v.media_status = res.ok ? 'ok' : String(res.status);
  v.media_reason = res.ok ? '' : res.reason;
  if (!res.ok) {
    r.return(res.status);
    return;
  }
  var dir = APPS[res.app].dir;
  v.media_file = '/' + (dir === '.' ? '' : dir + '/') + res.assetKey;
  v.media_app = res.app;
  v.media_kid = res.kid;
  v.media_u = res.u === undefined ? '' : res.u;
  // A felhasználónkénti limit_conn kulcsa; `u` nélkül üres (→ nem korlátoz).
  v.media_user_key = res.u === undefined ? '' : res.app + ' ' + res.u;
  v.media_kind = res.kind;
  r.internalRedirect('@serve');
}

/**
 * A kapu (js_content, D112): az ellenőrzés a SPEC 4. sorrendjében, aszimmetrikus kid-re a hibaszámlálóval (az
 * aláírás előtt `429 blocked`, hibás aláírás után számol). Minden kivétel és elutasított Promise itt elfogva
 * (`403 internal-error`): az error_log sora a kérés-sort, benne a tokent tartalmazná.
 */
async function gate(r) {
  try {
    var res;
    if (!appsOk()) {
      res = fail(403, 'apps-invalid');
    } else {
      var prep = prepare(r.variables.request_uri, APPS);
      if (!prep.ok) {
        res = prep;
      } else {
        var zone = prep.scheme === 'ES256' ? failsZone() : null;
        var ip = r.variables.remote_addr;
        if (zone !== null && isBlocked(zone, ip)) {
          res = fail(429, 'blocked');
        } else {
          var good = null;
          try {
            good = await checkSignature(prep);
            // oxlint-disable-next-line no-unused-vars
          } catch (_e) {
            good = null;
          }
          if (good === null) {
            res = fail(403, 'internal-error');
          } else if (!good) {
            if (zone !== null) countFailure(zone, ip);
            res = fail(403, 'bad-signature');
          } else {
            res = finish(prep, Math.floor(Date.now() / 1000));
          }
        }
      }
    }
    decide(r, res);
    // oxlint-disable-next-line no-unused-vars
  } catch (_e) {
    try {
      r.variables.media_status = '403';
      r.variables.media_reason = 'internal-error';
      r.return(403);
      // oxlint-disable-next-line no-unused-vars
    } catch (_e2) {
      // Már döntött (átirányított vagy válaszolt): nincs mit tenni.
    }
  }
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

function path(r) {
  return plainPath(r.variables.request_uri).slice(0, LOG_PATH_MAX);
}

/** A sikeres válasz Cache-Control-ja a kapu döntéséből (`$media_kind`; az átirányítás után új VM fut, memó nincs). */
function cache(r) {
  return r.variables.media_kind === 'browser' ? CACHE_BROWSER : CACHE_NONE;
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
 * A válaszfejlécek (js_header_filter; terv 4.4): a `@serve` (fájlválasz) és a fő location (`OPTIONS` 204, `405`). BEÁLLÍT, nem hozzáfűz: a 416-ot az nginx a
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
  // nginx (js_content: a fő location kapuja, a @denied törzse)
  gate: gate,
  denied: denied,
  // nginx (js_set: token nélküli útvonal a naplóhoz)
  path: path,
  // nginx (js_header_filter)
  headers: headers,
  // tesztekhez
  cache: cache,
  corp: corp,
  corsOrigin: corsOrigin,
  verify: verify,
  validateApps: validateApps,
  plainPath: plainPath,
  isLowS: isLowS,
  MEDIA_CONTENT_TYPES: MEDIA_CONTENT_TYPES,
  FAILS_LIMIT: FAILS_LIMIT,
  FAILS_WINDOW_MS: FAILS_WINDOW_MS,
};
