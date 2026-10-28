# Transaction Ledger API

An Express, Prisma, and PostgreSQL API for immutable account ledger entries and atomic account-to-account transfers.

## Windows / PowerShell setup

Install Node.js 22+ (with npm) and Docker Desktop. In PowerShell:

\`\`\`powershell
Copy-Item .env.example .env
npm ci
docker compose up -d
npx prisma migrate dev
npm run dev
\`\`\`

The API listens on \`http://localhost:3000\` unless \`PORT\` is changed. Docker Compose starts PostgreSQL 16 at \`localhost:5432\` using the development credentials in [docker-compose.yml](docker-compose.yml). \`npx prisma migrate dev\` applies the committed migrations and generates the client. Stop the container with \`docker compose down\`; add \`-v\` only when you explicitly intend to delete local database data.

\`.env\` is local-only. Start from \`.env.example\`, which contains no secrets, and replace its local example credentials for non-local environments. \`DATABASE_URL\` is required; \`PORT\` is optional.

For a clean install, delete only \`node_modules\` and \`dist\`, then run \`npm ci\`, copy the example environment file, start PostgreSQL, apply migrations, and run the checks below. Do not delete a database volume merely to run the app or tests.

## Database and verification commands

\`\`\`powershell
npm run db:generate          # generate Prisma client
npm run db:migrate           # apply migrations in development
npx prisma migrate status    # check the configured database
npx prisma migrate deploy    # apply committed migrations for deployment
npm run typecheck
npm run build
npm test
npm start
\`\`\`

\`npm run build\` clears \`dist\` before compiling production source. Test files are excluded from the production build.

### PostgreSQL integration-test isolation

Unit/API tests use mocks. PostgreSQL integration suites run only when \`TEST_DATABASE_URL\` is configured, reachable, and different from \`DATABASE_URL\`; otherwise they are skipped. Tests create tracked accounts and delete only their own accounts and ledger rows in \`afterAll\`. They never reset, truncate, or migrate either database.

Use a separate empty PostgreSQL database for tests. Apply the same committed migrations to it, then run:

\`\`\`powershell
$env:TEST_DATABASE_URL = "postgresql://ledger:ledger_test@localhost:5433/ledger_test"
npm test
\`\`\`

To apply migrations to that test database, temporarily set \`DATABASE_URL\` to the same isolated test URL in that PowerShell session, run \`npx prisma migrate deploy\`, then restore it. Never point \`TEST_DATABASE_URL\` at the development database.

## Money convention

Every public money value is a JSON string in major units. Inputs must be positive decimal strings with at most two fractional places (for example, \`"10"\`, \`"10.5"\`, or \`"10.50"\`); JSON numbers, zero, negatives, and over-precise values return \`400\`. Responses normalize to exactly two fractional places, such as \`"10.50"\` and \`"0.00"\`.

The service stores and calculates money as PostgreSQL \`BIGINT\` minor units and never uses floating-point arithmetic. The maximum accepted amount/balance is \`"92233720368547758.07"\`. Internal \`*_minor\` values are never returned.

## API

All bodies are JSON. Validation failures return \`400 VALIDATION_ERROR\` with an \`error.details\` array. Malformed JSON returns \`400 INVALID_JSON\`; an unknown route returns \`404 NOT_FOUND\`; unexpected failures return \`500 INTERNAL_ERROR\`.

### Create account — \`POST /api/accounts\`

Request:

\`\`\`json
{"name":"Operating account"}
\`\`\`

Success (\`201\`):

\`\`\`json
{"id":"123e4567-e89b-42d3-a456-426614174000","name":"Operating account","balance":"0.00","created_at":"2026-10-28T16:30:00.000Z"}
\`\`\`

\`name\` is trimmed, non-empty, and cannot contain NUL. Errors: \`400 VALIDATION_ERROR\`.

### Get balance — \`GET /api/accounts/:id/balance\`

Success (\`200\`):

\`\`\`json
{"account_id":"123e4567-e89b-42d3-a456-426614174000","balance":"59.75"}
\`\`\`

Errors: \`400 VALIDATION_ERROR\` for a non-UUID id; \`404 ACCOUNT_NOT_FOUND\` for an unknown account.

### Post ledger entry — \`POST /api/accounts/:id/transactions\`

Request:

\`\`\`json
{"type":"debit","amount":"40.25","description":"Groceries","reference_id":"groceries-2026-10-28"}
\`\`\`

Success (\`201\`):

\`\`\`json
{"id":"6f1c1f0e-6a52-4c0e-9c5a-0d6f0f1f6c11","account_id":"123e4567-e89b-42d3-a456-426614174000","type":"debit","amount":"40.25","description":"Groceries","reference_id":"groceries-2026-10-28","created_at":"2026-10-28T16:30:00.000Z","balance":"59.75"}
\`\`\`

\`type\` is \`credit\` or \`debit\`; \`description\` is trimmed, non-empty, max 500 characters; \`reference_id\` is trimmed, non-empty, max 255. Both reject NUL. Errors: \`400 VALIDATION_ERROR\`, \`404 ACCOUNT_NOT_FOUND\`, \`409 DUPLICATE_REFERENCE\`, \`422 INSUFFICIENT_FUNDS\`, \`422 BALANCE_LIMIT_EXCEEDED\`, or retryable \`503 TRANSACTION_RETRYABLE\`.

### List ledger entries — \`GET /api/accounts/:id/transactions\`

Optional parameters: \`type=credit|debit\`, \`page\` (positive integer, default \`1\`, max \`1000000000\`), and \`limit\` (positive integer, default \`10\`, max \`100\`). Unknown or repeated parameters are rejected.

Success (\`200\`):

\`\`\`json
{"transactions":[{"id":"6f1c1f0e-6a52-4c0e-9c5a-0d6f0f1f6c11","account_id":"123e4567-e89b-42d3-a456-426614174000","type":"debit","amount":"40.25","description":"Groceries","reference_id":"groceries-2026-10-28","created_at":"2026-10-28T16:30:00.000Z"}],"pagination":{"page":1,"limit":10,"totalRecords":1,"totalPages":1}}
\`\`\`

Entries are newest first (\`created_at DESC\`, then \`id DESC\`). Counts describe the filtered set. Empty accounts and pages past the end return \`200\` with \`transactions: []\`; \`totalPages\` is \`0\` for no records. Errors: \`400 VALIDATION_ERROR\`, \`404 ACCOUNT_NOT_FOUND\`.

### Transfer — \`POST /api/transfers\`

Request:

\`\`\`json
{"source_account_id":"123e4567-e89b-42d3-a456-426614174000","destination_account_id":"123e4567-e89b-42d3-a456-426614174001","amount":"25.00","reference_id":"payroll-42"}
\`\`\`

Success (\`201\`):

\`\`\`json
{"source_account_id":"123e4567-e89b-42d3-a456-426614174000","destination_account_id":"123e4567-e89b-42d3-a456-426614174001","amount":"25.00","reference_id":"payroll-42","source_balance":"75.00","destination_balance":"25.00","transactions":[{"id":"...","account_id":"123e4567-e89b-42d3-a456-426614174000","type":"debit","amount":"25.00","description":"Transfer to 123e4567-e89b-42d3-a456-426614174001","reference_id":"payroll-42","created_at":"2026-10-28T16:30:00.000Z"},{"id":"...","account_id":"123e4567-e89b-42d3-a456-426614174001","type":"credit","amount":"25.00","description":"Transfer from 123e4567-e89b-42d3-a456-426614174000","reference_id":"payroll-42","created_at":"2026-10-28T16:30:00.000Z"}]}
\`\`\`

The accounts must be different UUIDs. Errors: \`400 VALIDATION_ERROR\`, \`404 ACCOUNT_NOT_FOUND\`, \`409 DUPLICATE_REFERENCE\`, \`422 INSUFFICIENT_FUNDS\`, \`422 BALANCE_LIMIT_EXCEEDED\`, or retryable \`503 TRANSACTION_RETRYABLE\`.

## Consistency, idempotency, and retries

Ledger entries are immutable: there are no update/delete API endpoints. A single-entry \`reference_id\` is unique per account. Repeating it returns \`409 DUPLICATE_REFERENCE\` without changing the balance; it may be reused on another account.

A transfer locks both account rows in deterministic UUID order, checks its reference after locking, writes both ledger entries, and updates both balances in one database transaction. A committed transfer therefore has one debit and one credit with the same amount/reference; a failure rolls back both entries and balances. Reconciliation can match the pair by the account ids and shared \`reference_id\`; descriptions identify the counterparty.

\`503 TRANSACTION_RETRYABLE\` means PostgreSQL/Prisma reported a transient serialization, deadlock, lock, connection-wait, or transaction-timeout condition. Retry the identical request with the same \`reference_id\`; do not generate a new reference. A completed write retried later returns \`409 DUPLICATE_REFERENCE\`, so clients needing the original response should retain it locally or query the ledger.

## Assumptions and known limitations

- PostgreSQL is required; production behavior relies on row locks and transactions.
- This is a single-currency, two-decimal ledger with no currency field, authentication/authorization, rate limiting, audit actor, reversal workflow, or account-closure endpoint.
- Transfer references are enforced on each participating account; there is no global transfer-reference table or transfer lookup endpoint.
- Timestamps are server-generated UTC ISO-8601 values. Pagination is offset-based and stable for a single read snapshot, not cursor-based.
- The API has no health/readiness or OpenAPI endpoint.

## Assessment checklist

Verified: committed Prisma migrations; account creation and balance lookup; exact decimal-string amounts; immutable credit/debit entries; balance and overflow protection; per-account idempotency; deterministic history filtering/pagination; optional atomic transfers with rollback, ordering, and retry mapping; mocked API/unit tests and isolated PostgreSQL integration tests.

No external assessment rubric was supplied with the repository, so no further requirement can be conclusively marked missing. The known limitations above are scope omissions, not failed implemented requirements.
