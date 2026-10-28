import { Router } from "express";
import { z } from "zod";
import { postTransferController } from "../controllers/transfers.controller.js";
import { parseAmountToMinor } from "../lib/money.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();
const withoutNul = (schema: z.ZodString) => schema.regex(/^[^\u0000]*$/, "Must not contain NUL characters");

const createTransferSchema = z
  .object({
    source_account_id: z.string().uuid(),
    destination_account_id: z.string().uuid(),
    amount: z.string().transform((value, ctx) => {
      const minor = parseAmountToMinor(value);
      if (minor === null) {
        ctx.addIssue({ code: "custom", message: "Amount must be a positive decimal string with at most 2 fractional digits" });
        return z.NEVER;
      }
      return minor;
    }),
    reference_id: withoutNul(z.string().trim().min(1).max(255)),
  })
  .strict()
  .refine((value) => value.source_account_id !== value.destination_account_id, {
    message: "Source and destination accounts must be different",
    path: ["destination_account_id"],
  });

router.post("/", validateBody(createTransferSchema), postTransferController);

export default router;
