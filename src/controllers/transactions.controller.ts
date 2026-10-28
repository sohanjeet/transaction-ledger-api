import type { RequestHandler } from "express";
import { formatMinor } from "../lib/money.js";
import { listTransactions, postTransaction, type TransactionType } from "../services/transactions.service.js";

export const postTransactionController: RequestHandler = async (_req, res) => {
  const { id } = res.locals.validatedParams as { id: string };
  const { type, amount, description, reference_id } = res.locals.validatedBody as {
    type: TransactionType;
    amount: bigint;
    description: string;
    reference_id: string;
  };
  const { transaction, balanceMinor } = await postTransaction({
    accountId: id,
    type,
    amountMinor: amount,
    description,
    referenceId: reference_id,
  });
  res.status(201).json({
    id: transaction.id,
    account_id: transaction.accountId,
    type: transaction.type,
    amount: formatMinor(transaction.amountMinor),
    description: transaction.description,
    reference_id: transaction.referenceId,
    created_at: transaction.createdAt.toISOString(),
    balance: formatMinor(balanceMinor),
  });
};

export const listTransactionsController: RequestHandler = async (_req, res) => {
  const { id } = res.locals.validatedParams as { id: string };
  const { type, page, limit } = res.locals.validatedQuery as { type?: TransactionType; page: number; limit: number };
  const result = await listTransactions({ accountId: id, type, page, limit });
  res.json({
    transactions: result.transactions.map((t) => ({
      id: t.id,
      account_id: t.accountId,
      type: t.type,
      amount: formatMinor(t.amountMinor),
      description: t.description,
      reference_id: t.referenceId,
      created_at: t.createdAt.toISOString(),
    })),
    pagination: { page, limit, totalRecords: result.totalRecords, totalPages: result.totalPages },
  });
};
