import { describe, expect, it } from "vitest";
import { formatMinor, MAX_MINOR_UNITS, parseAmountToMinor } from "./money.js";

describe("parseAmountToMinor", () => {
  it.each([
    ["1", 100n],
    ["1.5", 150n],
    ["1.50", 150n],
    ["0.01", 1n],
    ["0.1", 10n],
    ["0.29", 29n],
    ["1.13", 113n],
    ["90071992547409.93", 9007199254740993n],
    ["92233720368547758.07", MAX_MINOR_UNITS],
  ])("parses %s exactly as %s minor units", (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  it.each([
    "0", "0.00", "-1", "+1", "1.001", "1.", ".5", "01", "1e2", " 1", "1 ", "1,00", "", "abc",
    "NaN", "Infinity", "92233720368547758.08", "1".repeat(40),
  ])("rejects %j", (input) => {
    expect(parseAmountToMinor(input)).toBeNull();
  });
});

describe("formatMinor", () => {
  it.each([
    [0n, "0.00"],
    [1n, "0.01"],
    [150n, "1.50"],
    [-205n, "-2.05"],
    [MAX_MINOR_UNITS, "92233720368547758.07"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatMinor(input)).toBe(expected);
  });
});
