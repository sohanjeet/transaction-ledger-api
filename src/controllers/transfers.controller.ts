import type { RequestHandler } from "express";
import { formatMinor } from "../lib/money.js";
import { postTransfer } from "../services/transfers.service.js";

export const postTransferController: RequestHandler = async (_req, res) => {
  const { source_account_id, destination_account_id, amount, reference_id } = res.locals.validatedBody as {
    source_account_id: string;
    destination_account_id: string;
    amount: bigint;
    reference_id: string;
  };

  const result = await postTransfer({
    sourceAccountId: source_account_id,
    destinationAccountId: destination_account_id,
    amountMinor: amount,
    referenceId: reference_id,
  });

  res.status(201).json({
    source_account_id,
    destination_account_id,
    amount: formatMinor(amount),
    reference_id,
    source_balance: formatMinor(result.sourceBalanceMinor),
    destination_balance: formatMinor(result.destinationBalanceMinor),
    transactions: result.transactions.map((transaction) => ({
      id: transaction.id,
      account_id: transaction.accountId,
      type: transaction.type,
      amount: formatMinor(transaction.amountMinor),
      description: transaction.description,
      reference_id: transaction.referenceId,
      created_at: transaction.createdAt.toISOString(),
    })),
  });
};
