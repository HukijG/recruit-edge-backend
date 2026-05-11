-- Drop legacy thin-cache tables at cutover step 6.
--
-- This migration is INTENTIONALLY staged in sync-worker/migrations-pending/ and
-- NOT in sync-worker/migrations/ so that `wrangler d1 migrations apply` does NOT
-- pick it up alongside 0003 at cutover step 1. Applying 0004 before the dual-write
-- code is removed (step 6) would drop the legacy tables while main-worker MCP
-- handlers and the legacy `tailSync` writer are still consuming them — production
-- would 5xx instantly.
--
-- At cutover step 6 (per the thin-immutable-cache merge handover):
--   1. Take fresh D1 export per docs/security.md § D1 PITR rollback.
--   2. Remove dual-write code (legacy tailSync call site + legacy writers + legacy
--      reads in main worker — see the cutover step 6 PR for the exact list).
--   3. Deploy.
--   4. `git mv sync-worker/migrations-pending/0004_drop_legacy.sql sync-worker/migrations/`
--   5. `cd sync-worker && npx wrangler d1 migrations apply RF_MCP_CACHE --remote --config wrangler.sync.jsonc`
--
-- DO NOT register this migration in sync-worker/test/helpers/migrate.js — that's the test harness for the dual-write phase.

DROP TABLE IF EXISTS candidate_jobs;
DROP TABLE IF EXISTS job_pipelines;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS jobs;
