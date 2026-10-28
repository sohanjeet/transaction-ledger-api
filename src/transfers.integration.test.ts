// Runs only against an explicitly isolated PostgreSQL database in TEST_DATABASE_URL.
// It deletes only rows belonging to accounts created here and never resets either database.
import "dotenv/config";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const isolatedTestDatabaseConfigured = Boolean(testDatabaseUrl && testDatabaseUrl !== process.env.DATABASE_URL);
if (isolatedTestDatabaseConfigured) process.env.DATABASE_URL = testDatabaseUrl;

let app: typeof import("./app.js").app;
let prisma: typeof import("./lib/prisma.js").prisma;
let disconnectPrisma: typeof import("./lib/prisma.js").disconnectPrisma;
let databaseReachable = false;
if (isolatedTestDatabaseConfigured) {
  ({ app } = await import("./app.js"));
  ({ prisma, disconnectPrisma } = await import("./lib/prisma.js"));
  databaseReachable = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
  if (!databaseReachable) console.warn("Skipping transfer integration tests: test database not reachable");
} else {
  console.warn("Skipping transfer integration tests: TEST_DATABASE_URL must be set to an isolated database");
}

const createdAccountIds: string[] = [];

async function createAccount(): Promise<string> {
  const response = await request(app).post("/api/accounts").send({ name: "transfer-integration-test" });
  expect(response.status).toBe(201);
  createdAccountIds.push(response.body.id);
  return response.body.id;
}

function postTransaction(accountId: string, amount: string, referenceId: string) {
  return request(app).post(`/api/accounts/${accountId}/transactions`).send({
    type: "credit",
    amount,
    description: "transfer test seed",
    reference_id: referenceId,
  });
}

function postTransfer(source: string, destination: string, amount: string, referenceId: string) {
  return request(app).post("/api/transfers").send({
    source_account_id: source,
    destination_account_id: destination,
    amount,
    reference_id: referenceId,
  });
}

async function balanceOf(accountId: string): Promise<string> {
  const response = await request(app).get(`/api/accounts/${accountId}/balance`);
  expect(response.status).toBe(200);
  return response.body.balance;
}

function countStatuses(responses: { status: number }[]): Record<number, number> {
  const result: Record<number, number> = {};
  for (const response of responses) result[response.status] = (result[response.status] ?? 0) + 1;
  return result;
}

describe.skipIf(!databaseReachable)("transfers API (PostgreSQL)", () => {
  afterAll(async () => {
    if (createdAccountIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { accountId: { in: createdAccountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    }
    await disconnectPrisma();
  });

  it("atomically transfers funds and creates one immutable ledger row per account", async () => {
    const [source, destination] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(source, "25.00", "seed");

    const response = await postTransfer(source, destination, "10.5", "transfer-1");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      source_account_id: source,
      destination_account_id: destination,
      amount: "10.50",
      reference_id: "transfer-1",
      source_balance: "14.50",
      destination_balance: "10.50",
    });
    expect(response.body.transactions).toEqual([
      expect.objectContaining({ account_id: source, type: "debit", amount: "10.50", reference_id: "transfer-1" }),
      expect.objectContaining({ account_id: destination, type: "credit", amount: "10.50", reference_id: "transfer-1" }),
    ]);
    expect(await balanceOf(source)).toBe("14.50");
    expect(await balanceOf(destination)).toBe("10.50");
  });

  it("serializes concurrent opposite-direction transfers without deadlocks or lost updates", async () => {
    const [a, b] = await Promise.all([createAccount(), createAccount()]);
    await Promise.all([postTransaction(a, "100.00", "seed-a"), postTransaction(b, "100.00", "seed-b")]);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? postTransfer(a, b, "1.00", `opposite-${index}`)
          : postTransfer(b, a, "1.00", `opposite-${index}`),
      ),
    );

    expect(countStatuses(responses)).toEqual({ 201: 20 });
    expect(await balanceOf(a)).toBe("100.00");
    expect(await balanceOf(b)).toBe("100.00");
  }, 30_000);

  it("makes concurrent duplicate retries safe on both account-scoped references", async () => {
    const [source, destination] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(source, "20.00", "seed");

    const responses = await Promise.all(Array.from({ length: 12 }, () => postTransfer(source, destination, "3.00", "same-transfer")));

    expect(countStatuses(responses)).toEqual({ 201: 1, 409: 11 });
    expect(await balanceOf(source)).toBe("17.00");
    expect(await balanceOf(destination)).toBe("3.00");
    expect(await prisma.transaction.count({ where: { referenceId: "same-transfer", accountId: { in: [source, destination] } } })).toBe(2);
  }, 30_000);

  it("rejects insufficient funds and writes neither side", async () => {
    const [source, destination] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(source, "2.00", "seed");

    const response = await postTransfer(source, destination, "2.01", "too-much");

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: "INSUFFICIENT_FUNDS", message: "Insufficient funds" } });
    expect(await balanceOf(source)).toBe("2.00");
    expect(await balanceOf(destination)).toBe("0.00");
    expect(await prisma.transaction.count({ where: { referenceId: "too-much", accountId: { in: [source, destination] } } })).toBe(0);
  });

  it("rejects destination overflow and rolls back both ledger rows", async () => {
    const [source, destination] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(source, "1.00", "seed-source");
    await postTransaction(destination, "92233720368547758.07", "seed-destination");

    const response = await postTransfer(source, destination, "0.01", "overflow");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(await balanceOf(source)).toBe("1.00");
    expect(await balanceOf(destination)).toBe("92233720368547758.07");
    expect(await prisma.transaction.count({ where: { referenceId: "overflow", accountId: { in: [source, destination] } } })).toBe(0);
  });

  it("rolls back both ledger rows and balances after a mid-transfer failure", async () => {
    const [source, destination] = await Promise.all([createAccount(), createAccount()]);
    await postTransaction(source, "8.00", "seed");

    const original = prisma.$transaction.bind(prisma) as (fn: (tx: object) => unknown, options?: unknown) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: object) => unknown, options?: unknown) =>
      original(
        (tx) => {
          const account = Reflect.get(tx, "account") as object;
          const wrappedAccount = new Proxy(account, {
            get(target, prop) {
              const value = Reflect.get(target, prop);
              if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
              return async (args: { where: { id: string } }) => {
                if (args.where.id === destination) throw new Error("injected destination update failure");
                return value.call(target, args);
              };
            },
          });
          return fn(new Proxy(tx, {
            get(target, prop) {
              if (prop === "account") return wrappedAccount;
              const value = Reflect.get(target, prop);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }));
        },
        options,
      )) as never);

    const response = await postTransfer(source, destination, "3.00", "rollback");
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(await balanceOf(source)).toBe("8.00");
    expect(await balanceOf(destination)).toBe("0.00");
    expect(await prisma.transaction.count({ where: { referenceId: "rollback", accountId: { in: [source, destination] } } })).toBe(0);
  });
});
