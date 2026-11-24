# test/fixtures

`apps.test.json`: **CSAK TESZT kulcsok** (a szövegük is ezt mondja: `CSAK-TESZT-…-NEM-ELES-…`). Sehol nem
érvényesek, éles vagy próbaszerveren nem használhatók. A docker nélküli tesztek (`test/*.spec.ts`) és a WP3
docker-tesztje olvassa.

Vegyes fájl (aszimmetrikus terv WP52): az `elearning` app a HMAC-kulcsai mellett két ES256 nyilvános kulcsot is
visz (`publicKeys.t2026e`, `contentPublicKeys.t2026f`). Ezek a `@chromygabor/media-sdk` `test-vectors.json`
`es256` blokkjának CSAK TESZT kulcspárjai (a titkos párjuk ott van, a tesztek onnan írnak alá); a nyilvános kulcs
szövege nem hordozhat jelölést, a kulcspár a vektorfájlban jelölt.
