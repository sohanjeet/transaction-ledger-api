import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { create, findUnique, $transaction } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("./lib/prisma.js", () => ({
  prisma: { account: { create, findUnique }, $transaction },
}));

const { app } = await import("./app.js");

describe("accounts API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an account with a zero balance", async () => {
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const response = await request(app).post("/api/accounts").send({ name: "  Main account  " });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: "Main account", balance: "0.00" });
    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.created_at).toEqual(expect.any(String));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ balanceMinor: 0n }),
    }));
  });

  it.each([
    [{ name: " " }],
    [{ name: "valid", balance: 10 }],
    [{ name: "valid", extra: true }],
    [{ name: "a\u0000b" }],
    [[]],
  ])("rejects invalid account bodies: %j", async (body) => {
    const response = await request(app).post("/api/accounts").send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await request(app).post("/api/accounts").set("Content-Type", "application/json").send('{"name":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized JSON body", async () => {
    const response = await request(app).post("/api/accounts").send({ name: "x".repeat(200_000) });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the balance as a decimal string", async () => {
    findUnique.mockResolvedValue({ id: "123e4567-e89b-42d3-a456-426614174000", balanceMinor: 9007199254740993n });
    const response = await request(app).get("/api/accounts/123e4567-e89b-42d3-a456-426614174000/balance");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ account_id: "123e4567-e89b-42d3-a456-426614174000", balance: "90071992547409.93" });
  });

  it("returns 404 for a missing account", async () => {
    findUnique.mockResolvedValue(null);
    const response = await request(app).get("/api/accounts/123e4567-e89b-42d3-a456-426614174000/balance");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("transactions API validation", () => {
  const accountId = "123e4567-e89b-42d3-a456-426614174000";
  const url = `/api/accounts/${accountId}/transactions`;
  const valid = { type: "credit", amount: "10.00", description: "Deposit", reference_id: "ref-1" };

  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["invalid type", { ...valid, type: "refund" }],
    ["uppercase type", { ...valid, type: "CREDIT" }],
    ["missing type", { amount: "1.00", description: "x", reference_id: "r" }],
    ["numeric amount", { ...valid, amount: 10 }],
    ["zero amount", { ...valid, amount: "0.00" }],
    ["negative amount", { ...valid, amount: "-5.00" }],
    ["three fractional digits", { ...valid, amount: "1.005" }],
    ["exponent amount", { ...valid, amount: "1e3" }],
    ["amount above BIGINT range", { ...valid, amount: "92233720368547758.08" }],
    ["blank description", { ...valid, description: "   " }],
    ["blank reference_id", { ...valid, reference_id: "" }],
    ["NUL in reference_id", { ...valid, reference_id: "a\u0000b" }],
    ["unknown field", { ...valid, balance: "5" }],
    ["array body", []],
  ])("rejects %s", async (_label, body) => {
    const response = await request(app).post(url).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON transaction body", async () => {
    const response = await request(app).post(url).set("Content-Type", "application/json").send('{"type":"credit",');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid account id", async () => {
    const response = await request(app).post("/api/accounts/not-a-uuid/transactions").send(valid);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect($transaction).not.toHaveBeenCalled();
  });

  it.each(["put", "patch", "delete"] as const)("exposes no %s endpoint for ledger entries", async (method) => {
    const response = await request(app)[method](`${url}/123e4567-e89b-42d3-a456-426614174001`).send(valid);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect($transaction).not.toHaveBeenCalled();
  });
});
