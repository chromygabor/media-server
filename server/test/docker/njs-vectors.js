// A közös vektorok (@chromygabor/media-sdk/test-vectors.json) a konténer njs CLI-jén (implementációs terv WP3,
// kockázatok: „a WP3 ugyanazokat a vektorokat a konténeren is lefuttatja”). njs 1.0.2-részhalmaz, mindkét motorral:
//
//   njs [-n QuickJS] -q -m -p /etc/nginx/njs <ez a fájl> <vectors.json>
//
// Kimenet: egy JSON-sor { engine, verify, sign, fails }; a docker-spec értékeli.

import fs from 'fs';
import media from 'media.js';

var file = process.argv[process.argv.length - 1];
var v = JSON.parse(fs.readFileSync(file, 'utf8'));
var fails = [];

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

for (var i = 0; i < v.verify.length; i++) {
  var c = v.verify[i];
  var r = media.verify(c.requestUri, c.keys, c.now);
  if (!same(r, c.expected)) fails.push('verify ' + c.name + ': ' + JSON.stringify(r));
}

for (var j = 0; j < v.sign.length; j++) {
  var s = v.sign[j];
  var app = s.path.split('/')[1];
  var keys = {};
  var k = {};
  k[s.params.kid] = s.key;
  keys[app] = { keys: k, contentKeys: k };
  var okNow = media.verify(s.expectedUrlPath, keys, s.expires);
  var late = media.verify(s.expectedUrlPath, keys, s.expires + 1);
  if (!okNow.ok) fails.push('sign ' + s.name + ': a lejáratkor nem fogadja el: ' + JSON.stringify(okNow));
  if (late.ok || late.status !== 410) fails.push('sign ' + s.name + ': lejárat után nem 410: ' + JSON.stringify(late));
}

console.log(
  JSON.stringify({ engine: typeof njs === 'object' ? njs.engine : 'njs', verify: v.verify.length, sign: v.sign.length, fails: fails }),
);
