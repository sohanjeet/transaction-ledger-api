// Runs only against an explicitly isolated PostgreSQL database in TEST_DATABASE_URL.
// It only touches accounts it creates and deletes exactly those rows afterwards; it never resets data.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const isolatedTestDatabaseConfigured = Boolean(testDatabaseUrl && testDatabaseUrl !== process.env.DATABASE_URL);
if (isolatedTestDatabaseConfigured) process.env.DATABASE_URL = testDatabaseUrl;

// Imported dynamically so the env override above is applied before the Prisma client is created.
let app: typeof import("./app.js").app;
let prisma: typeof import("./lib/prisma.js").prisma;
let disconnectPrisma: typeof import("./lib/prisma.js").disconnectPrisma;
let databaseReachable = false;
if (isolatedTestDatabaseConfigured) {
  ({ app } = await import("./app.js"));
  ({ prisma, disconnectPrisma } = await import("./lib/prisma.js"));
  databaseReachable = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
  if (!databaseReachable) console.warn("Skipping PostgreSQL history tests: test database not reachable");
} else {
  console.warn("Skipping PostgreSQL history tests: TEST_DATABASE_URL must be set to an isolated database");
}

const createdAccountIds: string[] = [];

async function createAccount(): Promise<string> {
  const response = await request(app).post("/api/accounts").send({ name: "history-test" });
  expect(response.status).toBe(201);
  createdAccountIds.push(response.body.id);
  return response.body.id;
}

function postTransaction(accountId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/accounts/${accountId}/transactions`).send({ description: "test", ...body });
}

const list = (accountId: string, query = "") => request(app).get(`/api/accounts/${accountId}/transactions${query}`);
const refs = (response: { body: { transactions: { reference_id: string }[] } }) => response.body.transactions.map((t) => t.reference_id);

/** Posts `count` entries sequentially: even indexes credit 2.00, odd indexes debit 1.00. */
async function seed(accountId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const credit = i % 2 === 0;
    const res = await postTransaction(accountId, {
      type: credit ? "credit" : "debit",
      amount: credit ? "2.00" : "1.00",
      reference_id: `h-${i}`,
    });
    expect(res.status).toBe(201);
  }
}

describe.skipIf(!databaseReachable)("transaction history API (PostgreSQL)", () => {
  afterAll(async () => {
    if (createdAccountIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { accountId: { in: createdAccountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    }
    await disconnectPrisma();
  });

  it("returns an empty page with zero totals for an account without transactions", async () => {
    const accountId = await createAccount();
    const response = await list(accountId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ transactions: [], pagination: { page: 1, limit: 10, totalRecords: 0, totalPages: 0 } });
  });

  it("returns 404 for a nonexistent account and 400 for malformed input", async () => {
    const missing = await list(randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await list("not-a-uuid")).status).toBe(400);
    const accountId = await createAccount();
    expect((await list(accountId, "?limit=101")).status).toBe(400);
    expect((await list(accountId, "?type=refund")).status).toBe(400);
  });

  it("paginates newest first with default and explicit page sizes", async () => {
    const accountId = await createAccount();
    await seed(accountId, 25);

    const first = await list(accountId);
    expect(first.body.pagination).toEqual({ page: 1, limit: 10, totalRecords: 25, totalPages: 3 });
    expect(refs(first)).toEqual(Array.from({ length: 10 }, (_, i) => `h-${24 - i}`));

    expect(refs(await list(accountId, "?page=3"))).toEqual(["h-4", "h-3", "h-2", "h-1", "h-0"]);

    const beyond = await list(accountId, "?page=4");
    expect(beyond.status).toBe(200);
    expect(beyond.body).toEqual({ transactions: [], pagination: { page: 4, limit: 10, totalRecords: 25, totalPages: 3 } });

    const small = await list(accountId, "?limit=7&page=2");
    expect(small.body.pagination).toEqual({ page: 2, limit: 7, totalRecords: 25, totalPages: 4 });
    expect(small.body.transactions).toHaveLength(7);
  }, 30_000);

  it("filters by type with counts and pages for the filtered set", async () => {
    const accountId = await createAccount();
    await seed(accountId, 9); // 5 credits, 4 debits

    const credits = await list(accountId, "?type=credit&limit=2");
    expect(credits.body.pagination).toEqual({ page: 1, limit: 2, totalRecords: 5, totalPages: 3 });
    expect(credits.body.transactions.every((t: { type: string }) => t.type === "credit")).toBe(true);

    const debits = await list(accountId, "?type=debit");
    expect(debits.body.pagination.totalRecords).toBe(4);
    expect(refs(debits)).toEqual(["h-7", "h-5", "h-3", "h-1"]);
  }, 30_000);

  it("breaks createdAt ties by id descending and stays stable across pages", async () => {
    const accountId = await createAccount();
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ];
    await prisma.transaction.createMany({
      data: ids.map((id, i) => ({ id, accountId, type: "credit", amountMinor: 100n, description: "tie", referenceId: `t-${i}`, createdAt })),
    });
    const oldId = "ffffffff-0000-4000-8000-000000000000";
    await prisma.transaction.create({
      data: { id: oldId, accountId, type: "credit", amountMinor: 100n, description: "old", referenceId: "old", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const page1 = await list(accountId, "?limit=2&page=1");
    const page2 = await list(accountId, "?limit=2&page=2");
    const order = [...page1.body.transactions, ...page2.body.transactions].map((t: { id: string }) => t.id);
    expect(order).toEqual([ids[1], ids[2], ids[0], oldId]);
  });

  it("keeps totals consistent with the returned page while entries are being posted", async () => {
    const accountId = await createAccount();
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 120; i += 1) {
        expect((await postTransaction(accountId, { type: "credit", amount: "1.00", reference_id: `w-${i}` })).status).toBe(201);
      }
    })().finally(() => (writing = false));

    const inconsistent: unknown[] = [];
    let reads = 0;
    const readers = Array.from({ length: 4 }, async () => {
      while (writing) {
        const response = await list(accountId, "?limit=100");
        reads += 1;
        const { totalRecords, totalPages } = response.body.pagination;
        if (response.body.transactions.length !== Math.min(100, totalRecords) || totalPages !== Math.ceil(totalRecords / 100)) {
          inconsistent.push({ returned: response.body.transactions.length, totalRecords });
        }
      }
    });
    await Promise.all([writer, ...readers]);

    expect(reads).toBeGreaterThan(0);
    expect(inconsistent).toEqual([]);
  }, 60_000);

  it("returns exact fixed 2-decimal money strings and isolates accounts", async () => {
    const [a, b] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(a, { type: "credit", amount: "92233720368547758.07", reference_id: "big" });
    await postTransaction(b, { type: "credit", amount: "5", reference_id: "other" });

    const response = await list(a);
    expect(response.body.transactions).toHaveLength(1);
    expect(response.body.transactions[0]).toEqual({
      id: expect.any(String),
      account_id: a,
      type: "credit",
      amount: "92233720368547758.07",
      description: "test",
      reference_id: "big",
      created_at: expect.any(String),
    });
    expect((await list(b)).body.transactions[0].amount).toBe("5.00");
  });
});
