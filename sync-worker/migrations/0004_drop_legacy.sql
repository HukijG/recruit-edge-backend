-- 0004_drop_legacy.sql — drops the legacy fat-cache tables at cutover step 6.
-- Spec: the thin-immutable cache design (2026-05-11).
--
-- DO NOT register this migration in sync-worker/test/helpers/migrate.js until
-- after cutover step 6 ships in production AND the dual-write code paths
-- (writeCandidatesAndLinks, writeJobs, writeJobPipeline, tailSync, fetchCandidatesUpdatedSince)
-- are removed from the codebase. The test harness needs both old and new tables
-- to exercise dual-seed test fixtures during the dual-write phase.
--
-- Pre-flight: take a fresh D1 export before applying:
--   npx wrangler d1 export RF_MCP_CACHE --remote --config wrangler.sync.jsonc \
--     --output=backups/rf-mcp-cache-pre-drop-$(date -I).sql
--
-- Per CLAUDE.md "D1 ownership", sync-worker is the only writer of RF_MCP_CACHE.

DROP TABLE IF EXISTS candidate_jobs;
DROP TABLE IF EXISTS job_pipelines;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS jobs;
