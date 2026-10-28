-- Harden ledger invariants without changing existing migration history.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balance_minor_nonnegative"
  CHECK ("balance_minor" >= 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_minor_positive"
  CHECK ("amount_minor" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_type_allowed"
  CHECK ("type" IN ('credit', 'debit'));
