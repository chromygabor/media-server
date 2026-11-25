#!/usr/bin/env bash
# A @chromygabor/media-sdk önállóságának ellenőrzése (csomagterv WP30): a csomag a repóból
# kiemelhető, vagyis a becsomagolt tarball egy üres projektben, a monorepó nélkül is működik.
#
#   pnpm --filter @chromygabor/media-sdk check:standalone
#
# 1. Statikus ellenőrzés: a csomag neve `@chromygabor/media-sdk` (D90); a `src/` alatt a `@chromygabor/`-on kívül nincs
#    más csomaghatókör (`@<scope>/`, így a régi `@cry/` sem), és nincs a csomagkönyvtárból kilépő relatív import; a
#    tsconfig nem örököl (`extends` nincs); a
#    package.json-ban nincs `workspace:` / `link:` / `file:` (helyi) függőség, és futásidejű függőség (`dependencies`, `peerDependencies`, `optionalDependencies`) sincs.
# 2. Build, majd `pnpm pack` egy ideiglenes könyvtárba (mktemp -d; a végén törlődik).
# 3. Ott egy üres projekt, `npm install <tarball>`.
# 4. Egy ESM és egy CJS próba: minden alútvonal (SUBPATHS) betölthető, és a `test-vectors.json` első `sign` vektora
#    bájtra reprodukálható (`signToken`, `buildSignedPath`); az ESM-próba a `./testing` hamis szerverét is elindítja,
#    és egy `testKeys`-szel aláírt linket kér le (WP35).
# 5. Minden `bin` (BINS) `--help`-je 0-val lép ki.
#
# Bővítés: új alútvonalnál a SUBPATHS, új parancsnál a BINS listába kell felvenni (a package.json `exports` / `bin`
# mezőjével együtt). A szkript ellenőrzi, hogy a SUBPATHS pontosan az `exports` kulcsait tartalmazza.

set -euo pipefail

# --- Bővíthető listák --------------------------------------------------------------------------------------------
# Az `exports` minden kulcsa; a `.json` végűek JSON-ként töltődnek be, a többi modulként.
SUBPATHS=(
  "."
  "./apps-config"
  "./testing"
  "./test-vectors.json"
)
# A `bin` mező parancsai.
BINS=(
  "media-keys"
  "media-sign"
)
# -------------------------------------------------------------------------------------------------------------------

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
PKG_NAME="$(node -p "require('./package.json').name")"

fail() {
  echo "✗ check:standalone: $*" >&2
  exit 1
}

echo "▸ $PKG_NAME önállósági ellenőrzés ($PKG_DIR)"

# --- 1. Statikus ellenőrzés --------------------------------------------------------------------------------------
if grep -rnoE --include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.json' '@[A-Za-z0-9._-]+/' src/ \
  | grep -vE ':@chromygabor/$'; then
  fail "a src/ alatt @chromygabor/-on kívüli csomaghatókör-hivatkozás van (fent)"
fi
[ "$PKG_NAME" = "@chromygabor/media-sdk" ] || fail "a csomag neve $PKG_NAME, nem @chromygabor/media-sdk (D90)"

# Relatív import, export, require, dinamikus import és `new URL(…, import.meta.url)`: a feloldott útvonal a
# csomagkönyvtáron belül kell maradjon.
node --input-type=module - "$PKG_DIR" <<'EOF'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const pkgDir = process.argv[2];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(c|m)?[jt]s$/.test(name)) files.push(p);
  }
};
walk(join(pkgDir, 'src'));

const patterns = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
];
const bad = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      if (target !== pkgDir && !target.startsWith(pkgDir + sep)) bad.push(`${file.slice(pkgDir.length + 1)}: ${spec}`);
    }
  }
}
if (bad.length > 0) {
  console.error('A csomagkönyvtárból kilépő import(ok):\n  ' + bad.join('\n  '));
  process.exit(1);
}
EOF

export BINS_LIST="${BINS[*]:-}"
grep -q '"extends"' tsconfig.json && fail "a tsconfig.json örököl (extends); önállónak kell lennie"

node - "${SUBPATHS[@]}" <<'EOF'
const pkg = require('./package.json');
const problems = [];
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length > 0) problems.push(`futásidejű függőség (${field}): ${Object.keys(pkg[field]).join(', ')}`);
}
for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
  if (/^(workspace|link|file):/.test(String(spec))) problems.push(`devDependency: ${name}@${spec}`);
}
const exported = Object.keys(pkg.exports ?? {}).sort();
const listed = process.argv.slice(2).sort();
if (JSON.stringify(exported) !== JSON.stringify(listed)) {
  problems.push(`a SUBPATHS (${listed.join(', ')}) nem egyezik az exports kulcsaival (${exported.join(', ')})`);
}
const bins = typeof pkg.bin === 'string' ? [pkg.name.split('/').pop()] : Object.keys(pkg.bin ?? {});
const listedBins = (process.env.BINS_LIST ?? '').split(' ').filter(Boolean);
if (JSON.stringify(bins.sort()) !== JSON.stringify(listedBins.sort())) {
  problems.push(`a BINS (${listedBins.join(', ') || '–'}) nem egyezik a bin mezővel (${bins.join(', ') || '–'})`);
}
if (problems.length > 0) {
  console.error('package.json:\n  ' + problems.join('\n  '));
  process.exit(1);
}
EOF
echo "  ✓ statikus ellenőrzés (src/, tsconfig.json, package.json)"

# --- 2. Build és pack --------------------------------------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/media-sdk-standalone.XXXXXX")"
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

pnpm run --silent build >/dev/null
pnpm pack --pack-destination "$TMP/pack" >/dev/null
TARBALL="$(ls "$TMP"/pack/*.tgz)"
[ -f "$TARBALL" ] || fail "a pnpm pack nem készített tarballt"
echo "  ✓ pack: $(basename "$TARBALL")"

# --- 3. Üres projekt, npm install ----------------------------------------------------------------------------------
mkdir -p "$TMP/probe"
cd "$TMP/probe"
printf '{ "name": "media-sdk-standalone-probe", "version": "0.0.0", "private": true }\n' > package.json
npm install --no-audit --no-fund --ignore-scripts --loglevel=error "$TARBALL" >/dev/null \
  || fail "az npm install a tarballból nem sikerült"
echo "  ✓ npm install egy üres projektbe"

# --- 4. ESM és CJS próba -------------------------------------------------------------------------------------------
SUBPATHS_JSON="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${SUBPATHS[@]}")"
export PKG_NAME SUBPATHS_JSON

cat > probe.mjs <<'EOF'
const name = process.env.PKG_NAME;
const subpaths = JSON.parse(process.env.SUBPATHS_JSON);
const spec = (s) => (s === '.' ? name : `${name}/${s.slice(2)}`);
const loaded = {};
for (const s of subpaths) {
  const mod = s.endsWith('.json') ? (await import(spec(s), { with: { type: 'json' } })).default : await import(spec(s));
  if (mod === null || typeof mod !== 'object' || Object.keys(mod).length === 0) throw new Error(`üres alútvonal: ${spec(s)}`);
  loaded[s] = mod;
}
const { signToken, buildSignedPath } = loaded['.'];
const v = loaded['./test-vectors.json'].sign[0];
const token = signToken({ key: v.key, tokenPath: v.tokenPath, expires: v.expires, params: v.params });
const path = buildSignedPath({ key: v.key, kid: v.params.kid, u: v.params.u, tokenPath: v.tokenPath, expires: v.expires, path: v.path });
if (token !== v.expectedToken) throw new Error(`ESM: a token eltér (${v.name})`);
if (path !== v.expectedUrlPath) throw new Error(`ESM: az URL-útvonal eltér (${v.name})`);
console.log(`  ✓ ESM: ${subpaths.length} alútvonal, a(z) „${v.name}” vektor bájtra egyezik`);

// A `./testing`: a hamis szerver a tarballból indul, és a `testKeys`-szel aláírt linket kiszolgálja (WP35). A
// médiagyökér a próbakönyvtárban van (az egész ideiglenes könyvtárral együtt törlődik).
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync('media-root/l', { recursive: true });
writeFileSync('media-root/l/v.mp4', 'video');
const { startFakeMediaServer, testKeys } = loaded['./testing'];
const fake = await startFakeMediaServer({ apps: testKeys.apps, root: 'media-root' });
try {
  const signer = loaded['.'].createUrlSigner({ ...testKeys, baseUrl: fake.url, maxTtlSeconds: 60 });
  const [r] = signer.signDirectory({ scopeDir: 'l/', userId: 'u', assets: [{ assetKey: 'l/v.mp4' }] }).results;
  const res = await fetch(r.url);
  if (res.status !== 200 || (await res.text()) !== 'video') throw new Error(`ESM: a hamis szerver nem adta a fájlt (${res.status})`);
} finally {
  await fake.close();
}
console.log('  ✓ ESM: ./testing – a hamis szerver a testKeys-szel aláírt linket kiszolgálja');
EOF

cat > probe.cjs <<'EOF'
const name = process.env.PKG_NAME;
const subpaths = JSON.parse(process.env.SUBPATHS_JSON);
const spec = (s) => (s === '.' ? name : `${name}/${s.slice(2)}`);
const loaded = {};
for (const s of subpaths) {
  const mod = require(spec(s));
  if (mod === null || typeof mod !== 'object' || Object.keys(mod).length === 0) throw new Error(`üres alútvonal: ${spec(s)}`);
  loaded[s] = mod;
}
const { signToken, buildSignedPath } = loaded['.'];
const v = loaded['./test-vectors.json'].sign[0];
const token = signToken({ key: v.key, tokenPath: v.tokenPath, expires: v.expires, params: v.params });
const path = buildSignedPath({ key: v.key, kid: v.params.kid, u: v.params.u, tokenPath: v.tokenPath, expires: v.expires, path: v.path });
if (token !== v.expectedToken) throw new Error(`CJS: a token eltér (${v.name})`);
if (path !== v.expectedUrlPath) throw new Error(`CJS: az URL-útvonal eltér (${v.name})`);
console.log(`  ✓ CJS: ${subpaths.length} alútvonal, a(z) „${v.name}” vektor bájtra egyezik`);
EOF

node probe.mjs || fail "az ESM-próba hibát adott"
node probe.cjs || fail "a CJS-próba hibát adott"

# --- 5. bin --help -----------------------------------------------------------------------------------------------
for bin in ${BINS[@]+"${BINS[@]}"}; do
  [ -x "node_modules/.bin/$bin" ] || fail "a(z) $bin parancs nincs telepítve (node_modules/.bin)"
  "node_modules/.bin/$bin" --help >/dev/null || fail "a(z) $bin --help nem 0-val lépett ki"
  echo "  ✓ $bin --help"
done

echo "✓ $PKG_NAME önálló: a tarball egy üres projektben, a monorepó nélkül működik"
