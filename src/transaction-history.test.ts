import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { findUnique, $transaction, txCount, txFindMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  $transaction: vi.fn(),
  txCount: vi.fn(),
  txFindMany: vi.fn(),
}));

vi.mock("./lib/prisma.js", () => ({
  prisma: { account: { findUnique }, transaction: { count: txCount, findMany: txFindMany }, $transaction },
}));

const { app } = await import("./app.js");

describe("transaction history API", () => {
  const accountId = "123e4567-e89b-42d3-a456-426614174000";
  const url = `/api/accounts/${accountId}/transactions`;

  beforeEach(() => vi.resetAllMocks());

  it.each([
    "type=refund",
    "type=CREDIT",
    "type=credit&type=debit",
    "page=0",
    "page=-1",
    "page=1.5",
    "page=abc",
    "page=",
    "page=1e2",
    "page=+1",
    "page=01",
    "page=99999999999",
    "page=1&page=2",
    "limit=0",
    "limit=101",
    "limit=-5",
    "limit=ten",
    "unknown=1",
    "sort=asc",
  ])("rejects query %s", async (query) => {
    const response = await request(app).get(`${url}?${query}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid account id", async () => {
    const response = await request(app).get("/api/accounts/not-a-uuid/transactions");
    expect(response.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing account without querying transactions", async () => {
    findUnique.mockResolvedValue(null);
    const response = await request(app).get(url);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("applies defaults and ordering and formats money as 2-decimal strings", async () => {
    findUnique.mockResolvedValue({ id: accountId });
    $transaction.mockResolvedValue([
      1,
      [
        {
          id: "id-1",
          accountId,
          type: "credit",
          amountMinor: 9007199254740993n,
          description: "d",
          referenceId: "r",
          createdAt: new Date("2026-01-02T03:04:05.000Z"),
        },
      ],
    ]);

    const response = await request(app).get(url);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactions: [
        {
          id: "id-1",
          account_id: accountId,
          type: "credit",
          amount: "90071992547409.93",
          description: "d",
          reference_id: "r",
          created_at: "2026-01-02T03:04:05.000Z",
        },
      ],
      pagination: { page: 1, limit: 10, totalRecords: 1, totalPages: 1 },
    });
    expect(txCount).toHaveBeenCalledWith({ where: { accountId } });
    // Count and page must share one snapshot (see the PostgreSQL consistency test).
    expect($transaction).toHaveBeenCalledWith(expect.any(Array), { isolationLevel: "RepeatableRead" });
    expect(txFindMany).toHaveBeenCalledWith({
      where: { accountId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 0,
      take: 10,
    });
  });

  it("passes type, page and limit to Prisma and computes totalPages", async () => {
    findUnique.mockResolvedValue({ id: accountId });
    $transaction.mockResolvedValue([250, []]);

    const response = await request(app).get(`${url}?type=debit&page=3&limit=100`);

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({ page: 3, limit: 100, totalRecords: 250, totalPages: 3 });
    expect(txCount).toHaveBeenCalledWith({ where: { accountId, type: "debit" } });
    expect(txFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId, type: "debit" }, skip: 200, take: 100 }));
  });

  it("reports zero pages for an account with no transactions", async () => {
    findUnique.mockResolvedValue({ id: accountId });
    $transaction.mockResolvedValue([0, []]);
    const response = await request(app).get(url);
    expect(response.body).toEqual({ transactions: [], pagination: { page: 1, limit: 10, totalRecords: 0, totalPages: 0 } });
  });
});
