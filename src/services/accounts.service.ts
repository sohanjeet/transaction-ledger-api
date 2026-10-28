import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { formatMinor } from "../lib/money.js";
import { HttpError } from "../middleware/error-handler.js";

export async function createAccount(name: string) {
  return prisma.account.create({
    data: { id: randomUUID(), name, balanceMinor: 0n, createdAt: new Date() },
    select: { id: true, name: true, balanceMinor: true, createdAt: true },
  });
}

export async function getAccountBalance(id: string) {
  const account = await prisma.account.findUnique({
    where: { id },
    select: { id: true, balanceMinor: true },
  });
  if (!account) throw new HttpError(404, "Account not found", "ACCOUNT_NOT_FOUND");
  return { account_id: account.id, balance: formatMinor(account.balanceMinor) };
}
