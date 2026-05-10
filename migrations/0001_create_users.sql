CREATE TABLE users (
  email          TEXT    PRIMARY KEY
                         CHECK (email = LOWER(email))
                         CHECK (email LIKE '%@%.%'),
  rf_user_id     INTEGER NOT NULL,
  dialpad_id     TEXT    NOT NULL,
  first_name     TEXT    NOT NULL CHECK (length(first_name) > 0),
  calendar_mode  TEXT    NOT NULL DEFAULT 'outlook'
                         CHECK (calendar_mode IN ('outlook', 'gcal', 'both')),
  aliases        TEXT,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE UNIQUE INDEX users_dialpad_id  ON users(dialpad_id);
CREATE UNIQUE INDEX users_rf_user_id  ON users(rf_user_id);
CREATE UNIQUE INDEX users_first_name  ON users(first_name);
