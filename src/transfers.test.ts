import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { $transaction } = vi.hoisted(() => ({ $transaction: vi.fn() }));

vi.mock("./lib/prisma.js", () => ({
  prisma: { $transaction },
}));

const { app } = await import("./app.js");

describe("transfers API validation", () => {
  const source = "123e4567-e89b-42d3-a456-426614174000";
  const destination = "123e4567-e89b-42d3-a456-426614174001";
  const valid = { source_account_id: source, destination_account_id: destination, amount: "10.00", reference_id: "transfer-1" };

  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["missing source", { destination_account_id: destination, amount: "10.00", reference_id: "r" }],
    ["invalid source UUID", { ...valid, source_account_id: "not-a-uuid" }],
    ["invalid destination UUID", { ...valid, destination_account_id: "not-a-uuid" }],
    ["same account", { ...valid, destination_account_id: source }],
    ["numeric amount", { ...valid, amount: 10 }],
    ["zero amount", { ...valid, amount: "0.00" }],
    ["negative amount", { ...valid, amount: "-1.00" }],
    ["too precise amount", { ...valid, amount: "1.001" }],
    ["overflowing amount", { ...valid, amount: "92233720368547758.08" }],
    ["blank reference", { ...valid, reference_id: "  " }],
    ["NUL reference", { ...valid, reference_id: "bad\u0000ref" }],
    ["unknown field", { ...valid, description: "not accepted" }],
    ["array body", []],
  ])("rejects %s", async (_label, body) => {
    const response = await request(app).post("/api/transfers").send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("uses the standard malformed JSON error", async () => {
    const response = await request(app).post("/api/transfers").set("Content-Type", "application/json").send('{"amount":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    expect($transaction).not.toHaveBeenCalled();
  });
});
