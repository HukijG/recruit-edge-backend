CREATE TABLE sms_templates (
  sub        TEXT NOT NULL,
  id         TEXT NOT NULL CHECK (length(id) > 0),
  name       TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 80),
  body       TEXT NOT NULL CHECK (length(body) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sub, id)
);

CREATE INDEX sms_templates_sub_updated ON sms_templates(sub, updated_at DESC);
