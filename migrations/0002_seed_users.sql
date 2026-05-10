-- Seed: current six teammates from the in-memory USERS array in src/users.js.
-- Replace each <TODO_EMAIL_*> placeholder with the actual company email
-- for that person before applying this migration to the remote D1.
INSERT INTO users (email, rf_user_id, dialpad_id, first_name, calendar_mode, aliases) VALUES
  ('<TODO_EMAIL_JOEL>',   900001, '8000000000000001', 'Joel',   'outlook', NULL),
  ('<TODO_EMAIL_ALICE>',  900002, '8000000000000002', 'Alice',  'outlook', NULL),
  ('<TODO_EMAIL_BOB>', 900003, '8000000000000003', 'Bob', 'outlook', '["Bobby"]'),
  ('<TODO_EMAIL_CAROL>',  900004, '8000000000000004', 'Carol',  'outlook', NULL),
  ('<TODO_EMAIL_DAVE>',    900005, '8000000000000005', 'Dave',    'outlook', NULL),
  ('<TODO_EMAIL_ERIN>',   900006, '8000000000000006', 'Erin',   'outlook', NULL);
