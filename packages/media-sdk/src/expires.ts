// Vödrözött lejárat (terv 4.2): az aktuális óra eleje + 6 óra, hogy egy órán belül
// ugyanarra a könyvtárra bájtra azonos URL jöjjön ki (böngésző-cache). Minden idő unix-másodperc.

const HOUR = 3600;

export interface BucketOptions {
  /** Az óra elejéhez adott órák száma (alap: 6; legalább 1, egész). */
  hours?: number;
}

/** `floor(now / 1 óra) · 1 óra + hours · 1 óra`; így `now + (hours − 1) óra < eredmény ≤ now + hours óra`. */
export function bucketExpires(nowSeconds: number, options: BucketOptions = {}): number {
  const hours = options.hours ?? 6;
  if (!Number.isInteger(hours) || hours < 1) {
    throw new RangeError(`bucketExpires: a hours pozitív egész legyen (kapott: ${hours})`);
  }
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new RangeError(`bucketExpires: érvénytelen időpont: ${nowSeconds}`);
  }
  return Math.floor(nowSeconds / HOUR) * HOUR + hours * HOUR;
}
