// Az apps.json tartalmi ellenőrzése a konténerben, az njs CLI-vel (reload előtt; implementációs terv WP2, WP4; a
// nyilvános kulcsok görbe-ellenőrzése: aszimmetrikus terv WP52, 3.2).
// Az nginx konfigtöltéskor csak a JSON alakját nézi, a validateApps-ot nem (lásd media.js fejkomment).
//
//   docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js [apps.json]
//
// Előbb a validateApps (alak), majd minden publicKeys / contentPublicKeys érték WebCrypto-importja (a pont a P-256
// görbén van-e; aszinkron, Promise-lánc, a kiírás a `then`-ben). Hibánál elutasított Promise-szal (nem nulla
// kilépési kóddal) áll le; a kulcsokat nem írja ki.

import fs from 'fs';
import media from 'media.js';

var file = process.argv.length > 2 ? process.argv[process.argv.length - 1] : '/etc/nginx/secrets/apps.json';
var apps = null;
var errors;
try {
  apps = JSON.parse(fs.readFileSync(file, 'utf8'));
  errors = media.validateApps(apps);
  // oxlint-disable-next-line no-unused-vars
} catch (e) {
  // Az `e.message` nélkül: a QuickJS `JSON.parse`-üzenete a bemenetből (a kulcsból) idéz (javítási terv P10, WP39).
  errors = ['nem olvasható JSON'];
}
if (errors.length > 0) throw new Error(file + ' hibás:\n  ' + errors.join('\n  '));

var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A 87 jeles (a validateApps által már ellenőrzött) base64url → 65 bájt. */
function bytes(s) {
  var out = new Uint8Array(Math.floor((s.length * 6) / 8));
  var acc = 0;
  var bits = 0;
  var j = 0;
  for (var i = 0; i < s.length; i++) {
    acc = ((acc << 6) | B64URL.indexOf(s.charAt(i))) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Egy nyilvános kulcs importja; a hiba szövege a helyet adja (app sorszáma, mező, kid), a kulcsot nem. */
function check(where, value) {
  return crypto.subtle.importKey('raw', bytes(value), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).then(
    function () {
      return null;
    },
    // oxlint-disable-next-line no-unused-vars
    function (_e) {
      return where + ': a nyilvános kulcs nem egy P-256 görbepont';
    },
  );
}

var checks = [];
var names = Object.keys(apps);
for (var i = 0; i < names.length; i++) {
  var fields = ['publicKeys', 'contentPublicKeys'];
  for (var f = 0; f < fields.length; f++) {
    var map = apps[names[i]][fields[f]];
    if (map === undefined) continue;
    var kids = Object.keys(map);
    for (var k = 0; k < kids.length; k++) {
      checks.push(check('apps["' + names[i] + '"].' + fields[f] + '["' + kids[k] + '"]', map[kids[k]]));
    }
  }
}

// A lánc vége: egy elutasítás (a hibák) az njs CLI-t nem nulla kilépési kóddal állítja le.
// oxlint-disable-next-line typescript/no-floating-promises
Promise.all(checks).then(function (results) {
  var bad = results.filter(function (x) {
    return x !== null;
  });
  if (bad.length > 0) throw new Error(file + ' hibás:\n  ' + bad.join('\n  '));
  console.log(file + ': rendben (' + names.length + ' app, ' + checks.length + ' nyilvános kulcs)');
});
