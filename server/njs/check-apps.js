// Az apps.json tartalmi ellenőrzése a konténerben, az njs CLI-vel (reload előtt; implementációs terv WP2, WP4).
// Az nginx konfigtöltéskor csak a JSON alakját nézi, a validateApps-ot nem (lásd media.js fejkomment).
//
//   docker compose exec -T media njs -q -m -p /etc/nginx/njs /etc/nginx/njs/check-apps.js [apps.json]
//
// Hibánál kivétellel (nem nulla kilépési kóddal) áll le; a kulcsokat nem írja ki.

import fs from 'fs';
import media from 'media.js';

var file = process.argv.length > 2 ? process.argv[process.argv.length - 1] : '/etc/nginx/secrets/apps.json';
var errors;
try {
  errors = media.validateApps(JSON.parse(fs.readFileSync(file, 'utf8')));
} catch (e) {
  errors = ['nem olvasható JSON: ' + e.message];
}
if (errors.length > 0) throw new Error(file + ' hibás:\n  ' + errors.join('\n  '));
console.log(file + ': rendben (' + Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length + ' app)');
