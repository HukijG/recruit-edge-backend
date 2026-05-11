import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { listConsultants } from '../src/users-d1-read.js';

beforeAll(async () => {
  // Create the users table (no migrations_dir on sync-worker side; main worker owns schema).
  // Use prepare().run() — exec() has quirks with multi-line statements in this harness
  // (mirrors the approach in test/helpers/migrate.js).
  await env.USERS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      email          TEXT    PRIMARY KEY,
      rf_user_id     INTEGER NOT NULL,
      dialpad_id     TEXT    NOT NULL,
      first_name     TEXT    NOT NULL,
      calendar_mode  TEXT    NOT NULL DEFAULT 'outlook',
      aliases        TEXT,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`
  ).run();

  // Seed two test consultants in USERS_DB.
  await env.USERS_DB.prepare("DELETE FROM users WHERE email IN ('joel@test.local', 'user2@test.local')").run();
  await env.USERS_DB
    .prepare(`INSERT INTO users (email, rf_user_id, dialpad_id, first_name)
              VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
    .bind(
      'joel@test.local', 900001, '8000000000000001', 'Joel',
      'user2@test.local', 900002, '8000000000000002', 'Alice',
    ).run();
});

describe('listConsultants', () => {
  it('returns one record per row with normalized field names', async () => {
    const out = await listConsultants(env);
    expect(out).toEqual(expect.arrayContaining([
      { email: 'joel@test.local', dialpadId: '8000000000000001', rfUserId: 900001, firstName: 'Joel' },
      { email: 'user2@test.local', dialpadId: '8000000000000002', rfUserId: 900002, firstName: 'Alice' },
    ]));
    expect(out).toHaveLength(2);
  });

  it('throws when USERS_DB binding is absent', async () => {
    await expect(listConsultants({})).rejects.toThrow(/USERS_DB/);
  });
});
