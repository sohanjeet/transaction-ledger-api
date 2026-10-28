// Runs only against an explicitly isolated PostgreSQL database in TEST_DATABASE_URL.
// It only touches accounts it creates and deletes exactly those rows afterwards; it never resets data.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

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
  if (!databaseReachable) console.warn("Skipping PostgreSQL integration tests: test database not reachable");
} else {
  console.warn("Skipping PostgreSQL integration tests: TEST_DATABASE_URL must be set to an isolated database");
}

const createdAccountIds: string[] = [];

async function createAccount(): Promise<string> {
  const response = await request(app).post("/api/accounts").send({ name: "integration-test" });
  expect(response.status).toBe(201);
  createdAccountIds.push(response.body.id);
  return response.body.id;
}

function postTransaction(accountId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/accounts/${accountId}/transactions`).send({ description: "test", ...body });
}

async function balanceOf(accountId: string): Promise<string> {
  const response = await request(app).get(`/api/accounts/${accountId}/balance`);
  expect(response.status).toBe(200);
  return response.body.balance;
}

async function ledgerOf(accountId: string) {
  return prisma.transaction.findMany({ where: { accountId }, orderBy: { createdAt: "asc" } });
}

function countStatuses(responses: { status: number }[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { status } of responses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** Runs the next interactive transaction with one tx delegate method replaced, to simulate failures mid-transaction. */
function injectIntoNextTransaction(model: "account" | "transaction", method: string, impl: (...args: unknown[]) => unknown) {
  const original = prisma.$transaction.bind(prisma) as (fn: (tx: object) => unknown, options?: unknown) => Promise<unknown>;
  const bindTo = (target: object, prop: PropertyKey) => {
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: object) => unknown, options?: unknown) =>
    original(
      (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop !== model) return bindTo(target, prop);
              const delegate = Reflect.get(target, prop) as object;
              return new Proxy(delegate, { get: (d, p) => (p === method ? impl : bindTo(d, p)) });
            },
          }),
        ),
      options,
    )) as never);
}

describe.skipIf(!databaseReachable)("transactions API (PostgreSQL)", () => {
  afterAll(async () => {
    if (createdAccountIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { accountId: { in: createdAccountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    }
    await disconnectPrisma();
  });

  it("credits an account and returns the ledger entry", async () => {
    const accountId = await createAccount();
    const response = await postTransaction(accountId, { type: "credit", amount: "100.5", description: "Salary", reference_id: "c-1" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      account_id: accountId,
      type: "credit",
      amount: "100.50",
      description: "Salary",
      reference_id: "c-1",
      created_at: expect.any(String),
      balance: "100.50",
    });
    expect(await balanceOf(accountId)).toBe("100.50");
  });

  it("debits an account", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "100.00", reference_id: "c-1" });
    const response = await postTransaction(accountId, { type: "debit", amount: "40.25", reference_id: "d-1" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ type: "debit", amount: "40.25", balance: "59.75" });
    expect(await balanceOf(accountId)).toBe("59.75");
  });

  it("allows a debit of the exact balance", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "12.34", reference_id: "c-1" });
    const response = await postTransaction(accountId, { type: "debit", amount: "12.34", reference_id: "d-1" });
    expect(response.status).toBe(201);
    expect(await balanceOf(accountId)).toBe("0.00");
  });

  it("rejects insufficient funds without modifying data", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "10.00", reference_id: "c-1" });
    const response = await postTransaction(accountId, { type: "debit", amount: "10.01", reference_id: "d-1" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: "INSUFFICIENT_FUNDS", message: "Insufficient funds" } });
    expect(await balanceOf(accountId)).toBe("10.00");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  });

  it("returns 404 for a nonexistent account and writes nothing", async () => {
    const missingId = randomUUID();
    const response = await postTransaction(missingId, { type: "credit", amount: "1.00", reference_id: "c-1" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(await ledgerOf(missingId)).toHaveLength(0);
  });

  it("rejects a duplicate reference_id on the same account without changing the balance", async () => {
    const accountId = await createAccount();
    const first = await postTransaction(accountId, { type: "credit", amount: "5.00", reference_id: "dup" });
    const replay = await postTransaction(accountId, { type: "credit", amount: "5.00", reference_id: "dup" });
    const reused = await postTransaction(accountId, { type: "debit", amount: "1.00", reference_id: "dup" });

    expect(first.status).toBe(201);
    for (const response of [replay, reused]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("DUPLICATE_REFERENCE");
    }
    expect(await balanceOf(accountId)).toBe("5.00");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  });

  it("allows the same reference_id on different accounts", async () => {
    const [a, b] = await Promise.all([createAccount(), createAccount()]);
    const [ra, rb] = await Promise.all([
      postTransaction(a, { type: "credit", amount: "1.00", reference_id: "shared-ref" }),
      postTransaction(b, { type: "credit", amount: "2.00", reference_id: "shared-ref" }),
    ]);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(await balanceOf(a)).toBe("1.00");
    expect(await balanceOf(b)).toBe("2.00");
  });

  it("keeps decimal amounts exact", async () => {
    const accountId = await createAccount();
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    await postTransaction(accountId, { type: "credit", amount: "0.1", reference_id: "c-1" });
    await postTransaction(accountId, { type: "credit", amount: "0.2", reference_id: "c-2" });
    expect(await balanceOf(accountId)).toBe("0.30");

    const big = await postTransaction(accountId, { type: "credit", amount: "90071992547409.93", reference_id: "c-3" });
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ amount: "90071992547409.93", balance: "90071992547410.23" });
  });

  it("rejects a credit that would overflow the BIGINT balance", async () => {
    const accountId = await createAccount();
    const max = await postTransaction(accountId, { type: "credit", amount: "92233720368547758.07", reference_id: "c-1" });
    expect(max.status).toBe(201);
    expect(max.body.balance).toBe("92233720368547758.07");

    const over = await postTransaction(accountId, { type: "credit", amount: "0.01", reference_id: "c-2" });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  });

  it("serializes concurrent debits so the balance never goes negative", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "100.00", reference_id: "seed" });

    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => postTransaction(accountId, { type: "debit", amount: "10.00", reference_id: `d-${i}` })),
    );

    expect(countStatuses(responses)).toEqual({ 201: 10, 422: 15 });
    expect(await balanceOf(accountId)).toBe("0.00");
    const ledger = await ledgerOf(accountId);
    expect(ledger.filter((entry) => entry.type === "debit")).toHaveLength(10);
  }, 30_000);

  it("does not lose concurrent credits and debits", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "50.00", reference_id: "seed" });

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        postTransaction(accountId, { type: i % 2 === 0 ? "credit" : "debit", amount: "1.01", reference_id: `m-${i}` }),
      ),
    );

    expect(countStatuses(responses)).toEqual({ 201: 30 });
    expect(await balanceOf(accountId)).toBe("50.00");
    const ledger = await ledgerOf(accountId);
    const ledgerSum = ledger.reduce((sum, e) => sum + (e.type === "credit" ? e.amountMinor : -e.amountMinor), 0n);
    expect(ledgerSum).toBe(5000n);
  }, 30_000);

  it("records concurrent duplicate submissions exactly once", async () => {
    const accountId = await createAccount();
    const responses = await Promise.all(
      Array.from({ length: 15 }, () => postTransaction(accountId, { type: "credit", amount: "7.77", reference_id: "same" })),
    );

    expect(countStatuses(responses)).toEqual({ 201: 1, 409: 14 });
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body).toEqual({
        error: { code: "DUPLICATE_REFERENCE", message: "A transaction with this reference_id already exists for this account" },
      });
    }
    expect(await balanceOf(accountId)).toBe("7.77");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  }, 30_000);

  it("maps a unique-constraint race to 409 and rolls back the balance update", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "3.00", reference_id: "race" });

    // Skip the in-transaction duplicate check so the insert hits the database unique index.
    const skippedCheck = vi.fn(async () => null);
    const spy = injectIntoNextTransaction("transaction", "findUnique", skippedCheck);
    const response = await postTransaction(accountId, { type: "credit", amount: "3.00", reference_id: "race" });
    spy.mockRestore();

    expect(skippedCheck).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DUPLICATE_REFERENCE");
    expect(await balanceOf(accountId)).toBe("3.00");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  });

  it("maps an exhausted connection pool (maxWait elapsed) to 503 and writes nothing", async () => {
    const accountId = await createAccount();

    // Occupy every connection of the pg Pool (default max: 10) so the next transaction cannot start.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holders = Array.from({ length: 10 }, () => prisma.$transaction(() => gate, { maxWait: 20_000, timeout: 20_000 }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await postTransaction(accountId, { type: "credit", amount: "1.00", reference_id: "c-1" });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("TRANSACTION_RETRYABLE");
    } finally {
      release();
      await Promise.all(holders);
    }

    expect(await balanceOf(accountId)).toBe("0.00");
    expect(await ledgerOf(accountId)).toHaveLength(0);
  }, 30_000);

  it("rolls back the ledger entry when the balance update fails", async () => {
    const accountId = await createAccount();
    await postTransaction(accountId, { type: "credit", amount: "8.00", reference_id: "c-1" });

    const failingUpdate = vi.fn(async () => {
      throw new Error("injected failure after ledger insert");
    });
    const spy = injectIntoNextTransaction("account", "update", failingUpdate);
    const response = await postTransaction(accountId, { type: "debit", amount: "2.00", reference_id: "d-1" });
    spy.mockRestore();

    expect(failingUpdate).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(await balanceOf(accountId)).toBe("8.00");
    expect(await ledgerOf(accountId)).toHaveLength(1);
  });
});
