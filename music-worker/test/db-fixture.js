/**
 * Test-only USERS_DB seeding for music-worker. The real schema is owned by the
 * MAIN worker (migrations/0001_create_users.sql); here we materialise just the
 * columns the read-only identity gate touches (email PK lowercase + first_name)
 * into the test D1 instance, then seed rows.
 */
import { env } from 'cloudflare:test';

export async function resetUsersDb(rows = []) {
  await env.USERS_DB.exec('DROP TABLE IF EXISTS users');
  // Single-line DDL — env.USERS_DB.exec runs one statement per call and does not
  // accept multi-line whitespace-split input reliably.
  await env.USERS_DB.exec(
    "CREATE TABLE users (email TEXT PRIMARY KEY CHECK (email = LOWER(email)), first_name TEXT NOT NULL CHECK (length(first_name) > 0))",
  );
  for (const r of rows) {
    await env.USERS_DB.prepare('INSERT INTO users (email, first_name) VALUES (?, ?)')
      .bind(r.email, r.firstName)
      .run();
  }
}
