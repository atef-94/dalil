/**
 * The real, collectible value of a contract: its pre-discount price minus
 * whatever discount was actually applied. Anything that treats a contract
 * as "worth" its raw totalPrice — commission calculations, booking-value
 * reporting — must use this instead, since a discount is a real reduction
 * in what the company will actually collect.
 */
export function netContractValue(totalPrice: number, discountPercent?: number): number {
  return Math.round(totalPrice * (1 - (discountPercent ?? 0) / 100) * 100) / 100;
}
