import { Router } from "express";
import { z } from "zod";
import { getAccountBalanceController, postAccount } from "../controllers/accounts.controller.js";
import { listTransactionsController, postTransactionController } from "../controllers/transactions.controller.js";
import { parseAmountToMinor } from "../lib/money.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";

const router = Router();
// PostgreSQL TEXT cannot store NUL bytes; reject them here instead of failing in the database.
const withoutNul = (schema: z.ZodString) => schema.regex(/^[^\u0000]*$/, "Must not contain NUL characters");
const createAccountSchema = z.object({ name: withoutNul(z.string().trim().min(1)) }).strict();
const accountParamsSchema = z.object({ id: z.string().uuid() });
const ledgerText = (max: number) => withoutNul(z.string().trim().min(1).max(max));
// Query values arrive as strings; only plain positive integers are accepted (no "1e2", "+1", "1.0", arrays).
const positiveInt = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,9}$/, "Must be a positive integer")
    .transform(Number)
    .pipe(z.number().max(max, `Must be at most ${max}`));

const listTransactionsQuerySchema = z
  .object({
    type: z.enum(["credit", "debit"]).optional(),
    page: positiveInt(1_000_000_000).default(1),
    limit: positiveInt(100).default(10),
  })
  .strict();

const createTransactionSchema = z
  .object({
    type: z.enum(["credit", "debit"]),
    // Amounts must be decimal strings: JSON numbers are already floats by the time they are parsed.
    amount: z.string().transform((value, ctx) => {
      const minor = parseAmountToMinor(value);
      if (minor === null) {
        ctx.addIssue({ code: "custom", message: "Amount must be a positive decimal string with at most 2 fractional digits" });
        return z.NEVER;
      }
      return minor;
    }),
    description: ledgerText(500),
    reference_id: ledgerText(255),
  })
  .strict();

router.post("/", validateBody(createAccountSchema), postAccount);
router.get("/:id/balance", validateParams(accountParamsSchema), getAccountBalanceController);
router.get(
  "/:id/transactions",
  validateParams(accountParamsSchema),
  validateQuery(listTransactionsQuerySchema),
  listTransactionsController,
);
router.post(
  "/:id/transactions",
  validateParams(accountParamsSchema),
  validateBody(createTransactionSchema),
  postTransactionController,
);

export default router;
