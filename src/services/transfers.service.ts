import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { MAX_MINOR_UNITS } from "../lib/money.js";
import { HttpError } from "../middleware/error-handler.js";

interface PostTransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  referenceId: string;
}

function duplicateReferenceError(): HttpError {
  return new HttpError(409, "A transaction with this reference_id already exists for this account", "DUPLICATE_REFERENCE");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2024" || error.code === "P2034") return true;
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

const MAX_ATTEMPTS = 3;

export async function postTransfer(input: PostTransferInput) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptTransfer(input);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw duplicateReferenceError();
        }
        if (isRetryableTransactionError(error)) {
          throw new HttpError(503, "Transaction temporarily unavailable; retry the request", "TRANSACTION_RETRYABLE");
        }
        throw error;
      }
      // Jittered backoff; the failed attempt rolled back completely, so retrying is safe.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
    }
  }
}

async function attemptTransfer(input: PostTransferInput) {
  const { sourceAccountId, destinationAccountId, amountMinor, referenceId } = input;
  const [firstAccountId, secondAccountId] = [sourceAccountId, destinationAccountId].sort();

  {
    return await prisma.$transaction(
      async (tx) => {
        // Every transfer acquires both row locks in UUID order. Opposite-direction
        // transfers therefore use the same lock order and cannot deadlock each other.
        const lockedAccounts = await tx.$queryRaw<{ id: string; balance: string }[]>`
          SELECT id, balance_minor::text AS balance
          FROM accounts
          WHERE id IN (${firstAccountId}, ${secondAccountId})
          ORDER BY id
          FOR UPDATE`;

        if (lockedAccounts.length !== 2) {
          throw new HttpError(404, "Account not found", "ACCOUNT_NOT_FOUND");
        }

        // This check happens after both locks, so a retry sees any reference committed
        // by the preceding writer. The unique index is still the final race backstop.
        const existing = await tx.transaction.findFirst({
          where: { accountId: { in: [sourceAccountId, destinationAccountId] }, referenceId },
          select: { id: true },
        });
        if (existing) throw duplicateReferenceError();

        const balances = new Map(lockedAccounts.map((account) => [account.id, BigInt(account.balance)]));
        const sourceBalance = balances.get(sourceAccountId)!;
        const destinationBalance = balances.get(destinationAccountId)!;
        if (sourceBalance < amountMinor) {
          throw new HttpError(422, "Insufficient funds", "INSUFFICIENT_FUNDS");
        }
        if (destinationBalance > MAX_MINOR_UNITS - amountMinor) {
          throw new HttpError(422, "Transfer would exceed the maximum destination balance", "BALANCE_LIMIT_EXCEEDED");
        }

        const sourceBalanceMinor = sourceBalance - amountMinor;
        const destinationBalanceMinor = destinationBalance + amountMinor;
        const createdAt = new Date();
        const debit = await tx.transaction.create({
          data: {
            id: randomUUID(),
            accountId: sourceAccountId,
            type: "debit",
            amountMinor,
            description: `Transfer to ${destinationAccountId}`,
            referenceId,
            createdAt,
          },
        });
        const credit = await tx.transaction.create({
          data: {
            id: randomUUID(),
            accountId: destinationAccountId,
            type: "credit",
            amountMinor,
            description: `Transfer from ${sourceAccountId}`,
            referenceId,
            createdAt,
          },
        });

        await tx.account.update({ where: { id: sourceAccountId }, data: { balanceMinor: sourceBalanceMinor } });
        await tx.account.update({ where: { id: destinationAccountId }, data: { balanceMinor: destinationBalanceMinor } });

        return { transactions: [debit, credit], sourceBalanceMinor, destinationBalanceMinor };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 15000, timeout: 15000 },
    );
  }
}
