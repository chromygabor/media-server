# secrets/

Gitignore-olt könyvtár (csak ez a README van a repóban). Ide a helyi `apps.json` kerül (terv 4.3):

- `apps.local.json` – helyi futtatás és próbalink-aláírás (a mintamédia `demo` appja, `"dir": "demo"`, fejlesztői kulcs).

Egy telepítés `apps.json`-ja nem itt van, hanem a telepítési cél könyvtárában: `../../deploy/<cél>/secrets/apps.json`
(gitignore-olt; a célgép éles `apps.json`-jának helyi példánya), a célgépen `<DEPLOY_DIR>/secrets/apps.json`,
`chmod 0400`. Lásd `deploy/README.md`.

Kulcsot a `pnpm keys <app> [--content] [--kid <id>] [--write <apps.json>]` generál. A kulcs 32 véletlen
bájt base64url-szövege (43 jel); a HMAC kulcsa ez a **szöveg** UTF-8-ként (Bunny-szerint), nem dekódoljuk.
