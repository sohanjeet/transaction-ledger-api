import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { MAX_MINOR_UNITS } from "../lib/money.js";
import { HttpError } from "../middleware/error-handler.js";

export type TransactionType = "credit" | "debit";

export interface PostTransactionInput {
  accountId: string;
  type: TransactionType;
  amountMinor: bigint;
  description: string;
  referenceId: string;
}

function duplicateReferenceError(): HttpError {
  return new HttpError(409, "A transaction with this reference_id already exists for this account", "DUPLICATE_REFERENCE");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2024" || error.code === "P2034") return true;
    // Covers both an expired transaction and maxWait elapsing before a connection was available.
    if (error.code === "P2028") {
      return /timed out|timeout|expired|transaction.*closed|unable to start a transaction/i.test(error.message);
    }
  }

  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "40001" || candidate.code === "40P01" || candidate.code === "55P03") return true;
    current = candidate.cause;
  }
  return false;
}

export async function postTransaction(input: PostTransactionInput) {
  const { accountId, type, amountMinor, description, referenceId } = input;
  try {
    return await prisma.$transaction(
      async (tx) => {
        // Row lock serializes every ledger write for this account until commit/rollback.
        // Balance is read as text so it is converted to BigInt without any float step.
        const [locked] = await tx.$queryRaw<{ balance: string }[]>`
          SELECT balance_minor::text AS balance FROM accounts WHERE id = ${accountId} FOR UPDATE`;
        if (!locked) throw new HttpError(404, "Account not found", "ACCOUNT_NOT_FOUND");

        // READ COMMITTED gives each statement a fresh snapshot, so this sees rows committed
        // by whichever transaction held the lock before us.
        const existing = await tx.transaction.findUnique({
          where: { accountId_referenceId: { accountId, referenceId } },
          select: { id: true },
        });
        if (existing) throw duplicateReferenceError();

        const balance = BigInt(locked.balance);
        const newBalance = type === "credit" ? balance + amountMinor : balance - amountMinor;
        if (newBalance < 0n) throw new HttpError(422, "Insufficient funds", "INSUFFICIENT_FUNDS");
        if (newBalance > MAX_MINOR_UNITS) {
          throw new HttpError(422, "Transaction would exceed the maximum balance", "BALANCE_LIMIT_EXCEEDED");
        }

        const transaction = await tx.transaction.create({
          data: { id: randomUUID(), accountId, type, amountMinor, description, referenceId, createdAt: new Date() },
        });
        await tx.account.update({ where: { id: accountId }, data: { balanceMinor: newBalance } });
        return { transaction, balanceMinor: newBalance };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10000 },
    );
  } catch (error) {
    // Backstop for the (accountId, referenceId) unique index; the whole transaction has rolled back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw duplicateReferenceError();
    }
    if (isRetryableTransactionError(error)) {
      throw new HttpError(503, "Transaction temporarily unavailable; retry the request", "TRANSACTION_RETRYABLE");
    }
    throw error;
  }
}

export interface ListTransactionsInput {
  accountId: string;
  type?: TransactionType | undefined;
  page: number;
  limit: number;
}

export async function listTransactions({ accountId, type, page, limit }: ListTransactionsInput) {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw new HttpError(404, "Account not found", "ACCOUNT_NOT_FOUND");

  const where = { accountId, ...(type ? { type } : {}) };
  // REPEATABLE READ gives both statements one snapshot, so totals always match the returned page
  // even while entries are being posted; under READ COMMITTED each statement sees a fresh snapshot.
  const [totalRecords, transactions] = await prisma.$transaction(
    [
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return { transactions, totalRecords, totalPages: Math.ceil(totalRecords / limit) };
}
