import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getUserByEmail } from '../src/users-d1-read.js';
import { resetUsersDb } from './db-fixture.js';

describe('users-d1-read getUserByEmail', () => {
  beforeEach(async () => {
    await resetUsersDb([
      { email: 'joel@cognatio.test', firstName: 'Joel' },
      { email: 'sam@cognatio.test', firstName: 'Sam' },
    ]);
  });

  it('returns {email, firstName} for a registered email', async () => {
    const u = await getUserByEmail(env, 'joel@cognatio.test');
    expect(u).toEqual({ email: 'joel@cognatio.test', firstName: 'Joel' });
  });

  it('normalizes the lookup email to lowercase', async () => {
    const u = await getUserByEmail(env, 'JOEL@Cognatio.TEST');
    expect(u).toEqual({ email: 'joel@cognatio.test', firstName: 'Joel' });
  });

  it('returns null for an unregistered email', async () => {
    const u = await getUserByEmail(env, 'stranger@cognatio.test');
    expect(u).toBeNull();
  });

  it('returns null for a non-string / empty email', async () => {
    expect(await getUserByEmail(env, '')).toBeNull();
    expect(await getUserByEmail(env, null)).toBeNull();
    expect(await getUserByEmail(env, '   ')).toBeNull();
  });

  it('reads per-request (no module cache): a row inserted after a read is visible', async () => {
    expect(await getUserByEmail(env, 'newbie@cognatio.test')).toBeNull();
    await env.USERS_DB.prepare('INSERT INTO users (email, first_name) VALUES (?, ?)')
      .bind('newbie@cognatio.test', 'Newbie')
      .run();
    // No cold start, no _resetCacheForTests — proves there is no module-level cache.
    expect(await getUserByEmail(env, 'newbie@cognatio.test')).toEqual({
      email: 'newbie@cognatio.test',
      firstName: 'Newbie',
    });
  });
});
