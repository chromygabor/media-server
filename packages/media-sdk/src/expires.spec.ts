import { describe, expect, it } from 'vitest';
import { bucketExpires } from './expires.js';

describe('bucketExpires (próbalink-lejárat)', () => {
  it('óra eleje + 6 óra', () => {
    // 2026-11-23T10:37:12Z → 10:00Z + 6 h = 16:00Z
    const now = Date.UTC(2026, 10, 23, 10, 37, 12) / 1000;
    expect(bucketExpires(now)).toBe(Date.UTC(2026, 10, 23, 16, 0, 0) / 1000);
  });
  it('pontosan óra elején: + 6 óra', () => {
    const now = Date.UTC(2026, 10, 23, 10) / 1000;
    expect(bucketExpires(now)).toBe(now + 6 * 3600);
  });
  it('hours opció (tartalomtokennél nem vödrözünk, ez csak a böngészős)', () => {
    expect(bucketExpires(7200 + 5, { hours: 1 })).toBe(3 * 3600);
  });
  it.each([0, -1, 1.5, Number.NaN])('rossz hours: %s', (h) => expect(() => bucketExpires(1000, { hours: h })).toThrow(RangeError));
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rossz időpont: %s', (n) => expect(() => bucketExpires(n)).toThrow(RangeError));
});
