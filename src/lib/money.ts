// PostgreSQL BIGINT upper bound; balances and amounts are stored in minor units (cents).
export const MAX_MINOR_UNITS = 9223372036854775807n;

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/**
 * Parses a decimal string such as "12.5" into exact minor units (1250n) without
 * floating-point arithmetic. Returns null for malformed, non-positive or out-of-range input.
 */
export function parseAmountToMinor(value: string): bigint | null {
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) return null;
  const [, major = "0", fraction = ""] = match;
  // Bound the digit count before BigInt conversion so huge inputs fail cheaply.
  if (major.length > 19) return null;
  const minor = BigInt(major) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor <= 0n || minor > MAX_MINOR_UNITS) return null;
  return minor;
}

export function formatMinor(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
