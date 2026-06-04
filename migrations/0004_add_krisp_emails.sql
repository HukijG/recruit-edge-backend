-- DEPLOY CHECKLIST: this migration is a hard dependency for Krisp note
-- attribution. The owner fallback in processKrispMeetingNotes resolves Joel via
-- OWNER_EMAIL ('owner@example.com'), which only maps to a teammate
-- through the Joel UPDATE below. If this file is not applied to remote
-- USERS_DB, EVERY unregistered-consultant Krisp note is silently skipped.
-- Apply + verify (see the Joel UPDATE note) before relying on the integration.
--
-- Alternate "Krisp account" emails per consultant. Krisp participant emails are
-- often a personal address distinct from the team `email` PK; folding them into
-- the byEmail map (src/users.js) lets getUserByEmail() resolve Krisp
-- participants to the right teammate, which drives Krisp note attribution.
-- Value is a JSON array of lowercase emails (same shape/convention as `aliases`).
ALTER TABLE users ADD COLUMN krisp_emails TEXT;

-- Joel's Krisp account email. Keyed on rf_user_id (stable, unique index) so we
-- do not depend on the team `email` PK value (the 0002 seed left those as
-- placeholders). NOTE: this is an UPDATE, not an upsert — D1 reports no error
-- if it matches 0 rows. After applying, verify with:
--   wrangler d1 execute USERS_DB --remote \
--     --command "SELECT email, krisp_emails FROM users WHERE rf_user_id = 900001;"
-- and confirm krisp_emails is populated. Redeploy (or wait for a cold start)
-- for the running Worker isolate to pick up the change.
UPDATE users SET krisp_emails = '["owner@example.com"]', updated_at = strftime('%s','now')
WHERE rf_user_id = 900001;

-- TODO: populate the other consultants' Krisp account emails when they start
-- using Krisp. One UPDATE per consultant, keyed on rf_user_id. Until then, a
-- Krisp call hosted by them attributes the note to the owner (Joel) with a
-- warning log (see processKrispMeetingNotes). Store emails lowercase.
--   UPDATE users SET krisp_emails = '["<ALICE_KRISP_EMAIL>"]',  updated_at = strftime('%s','now') WHERE rf_user_id = 900002; -- Alice
--   UPDATE users SET krisp_emails = '["<BOB_KRISP_EMAIL>"]', updated_at = strftime('%s','now') WHERE rf_user_id = 900003; -- Bob
--   UPDATE users SET krisp_emails = '["<CAROL_KRISP_EMAIL>"]',  updated_at = strftime('%s','now') WHERE rf_user_id = 900004; -- Carol
--   UPDATE users SET krisp_emails = '["<DAVE_KRISP_EMAIL>"]',    updated_at = strftime('%s','now') WHERE rf_user_id = 900005; -- Dave
--   UPDATE users SET krisp_emails = '["<ERIN_KRISP_EMAIL>"]',   updated_at = strftime('%s','now') WHERE rf_user_id = 900006; -- Erin
