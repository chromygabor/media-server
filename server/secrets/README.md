# secrets/

Gitignore-olt könyvtár (csak ez a README van a repóban). Ide kerülnek az `apps.json`-ok (terv 4.3):

- `apps.local.json` – helyi futtatás és próbalink-aláírás (`elearning` app, `"dir": "."`, fejlesztői kulcs);
- `apps.prod.json` – a szerver próbakulcsainak helyi másolata az aláíráshoz (WP4);
- a szerveren: `/srv/media-server/secrets/apps.json`, `chmod 0400`.

Kulcsot a `pnpm media-server:keys <app> [--content] [--kid <id>] [--write <apps.json>]` generál. A kulcs 32 véletlen
bájt base64url-szövege (43 jel); a HMAC kulcsa ez a **szöveg** UTF-8-ként (Bunny-szerint), nem dekódoljuk.
