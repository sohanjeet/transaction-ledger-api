import type { RequestHandler } from "express";
import { createAccount, getAccountBalance } from "../services/accounts.service.js";
import { formatMinor } from "../lib/money.js";

export const postAccount: RequestHandler = async (_req, res) => {
  const { name } = res.locals.validatedBody as { name: string };
  const account = await createAccount(name);
  res.status(201).json({
    id: account.id,
    name: account.name,
    balance: formatMinor(account.balanceMinor),
    created_at: account.createdAt.toISOString(),
  });
};

export const getAccountBalanceController: RequestHandler = async (_req, res) => {
  const { id } = res.locals.validatedParams as { id: string };
  res.json(await getAccountBalance(id));
};
