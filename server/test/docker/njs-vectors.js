// A közös vektorok (@chromygabor/media-sdk/test-vectors.json) a konténer njs CLI-jén (implementációs terv WP3,
// kockázatok: „a WP3 ugyanazokat a vektorokat a konténeren is lefuttatja”; az ES256: aszimmetrikus terv WP52). njs
// 1.0.2-részhalmaz, mindkét motorral. A verify aszinkron: Promise-lánc, a kiírás a `then`-ben.
//
//   njs [-n QuickJS] -q -m -p /etc/nginx/njs <ez a fájl> <vectors.json>
//
// Kimenet: egy JSON-sor { engine, verify, es256Verify, sign, es256Tokens, fails }; a docker-spec értékeli.

import fs from 'fs';
import media from 'media.js';

var file = process.argv[process.argv.length - 1];
var v = JSON.parse(fs.readFileSync(file, 'utf8'));
var fails = [];
var jobs = [];

function same(r, e) {
  if (r.ok) {
    return (
      e.status === 200 &&
      r.app === e.app &&
      r.kid === e.kid &&
      (r.u === undefined ? undefined : r.u) === e.u &&
      r.kind === e.kind &&
      r.contentType === e.contentType
    );
  }
  return r.status === e.status && r.reason === e.reason;
}

function verifyCase(label, c) {
  return media.verify(c.requestUri, c.keys, c.now).then(function (r) {
    if (!same(r, c.expected)) fails.push(label + ' ' + c.name + ': ' + JSON.stringify(r));
  });
}

/** Egy aláírt útvonal a lejáratkor elfogadva, utána 410. */
function roundTrip(label, name, urlPath, keys, expires) {
  return media.verify(urlPath, keys, expires).then(function (okNow) {
    if (!okNow.ok) fails.push(label + ' ' + name + ': a lejáratkor nem fogadja el: ' + JSON.stringify(okNow));
    return media.verify(urlPath, keys, expires + 1).then(function (late) {
      if (late.ok || late.status !== 410) fails.push(label + ' ' + name + ': lejárat után nem 410: ' + JSON.stringify(late));
    });
  });
}

for (var i = 0; i < v.verify.length; i++) jobs.push(verifyCase('verify', v.verify[i]));
for (var e = 0; e < v.es256.verify.length; e++) jobs.push(verifyCase('es256.verify', v.es256.verify[e]));

for (var j = 0; j < v.sign.length; j++) {
  var s = v.sign[j];
  var keys = {};
  var k = {};
  k[s.params.kid] = s.key;
  keys[s.path.split('/')[1]] = { keys: k, contentKeys: k };
  jobs.push(roundTrip('sign', s.name, s.expectedUrlPath, keys, s.expires));
}

for (var t = 0; t < v.es256.tokens.length; t++) {
  var tok = v.es256.tokens[t];
  var pub = {};
  var cpub = {};
  pub[v.es256.kid] = v.es256.publicKey;
  cpub[v.es256.contentKid] = v.es256.contentPublicKey;
  var esKeys = {};
  esKeys[tok.path.split('/')[1]] = { keys: {}, contentKeys: {}, publicKeys: pub, contentPublicKeys: cpub };
  jobs.push(roundTrip('es256.tokens', tok.name, tok.urlPath, esKeys, tok.expires));
}

// oxlint-disable-next-line typescript/no-floating-promises
Promise.all(jobs).then(function () {
  console.log(
    JSON.stringify({
      engine: typeof njs === 'object' ? njs.engine : 'njs',
      verify: v.verify.length,
      es256Verify: v.es256.verify.length,
      sign: v.sign.length,
      es256Tokens: v.es256.tokens.length,
      fails: fails,
    }),
  );
});
