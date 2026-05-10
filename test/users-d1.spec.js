import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { applyUsersMigration } from './helpers/users-migrate.js';
import {
  getUserByEmail,
  getUserByFirstName,
  getUserByDialpadId,
  getUserByRFUserId,
  resolveRFUserId,
  getRFUserIdByDialpadId,
  isMonitoredDialpadUser,
  _resetCacheForTests,
} from '../src/users.js';

beforeEach(async () => {
  await applyUsersMigration(env);
  _resetCacheForTests();
});

describe('getUserByEmail', () => {
  it('returns the record for a known email (case-insensitive)', async () => {
    const u = await getUserByEmail(env, 'JOEL@test.local');
    expect(u).toMatchObject({
      email: 'joel@test.local',
      firstName: 'Joel',
      rfUserId: 900001,
      dialpadId: '8000000000000001',
      calendarMode: 'outlook',
    });
  });

  it('returns null for unknown email', async () => {
    expect(await getUserByEmail(env, 'nobody@test.local')).toBeNull();
  });

  it('returns null for null/undefined/empty input', async () => {
    expect(await getUserByEmail(env, null)).toBeNull();
    expect(await getUserByEmail(env, undefined)).toBeNull();
    expect(await getUserByEmail(env, '')).toBeNull();
  });
});

describe('getUserByFirstName', () => {
  it('returns the record for a known first name (case-insensitive)', async () => {
    expect(await getUserByFirstName(env, 'Joel')).toMatchObject({ rfUserId: 900001 });
    expect(await getUserByFirstName(env, '  ALICE  ')).toMatchObject({ rfUserId: 900002 });
  });

  it('resolves an alias (Bobby → Bob)', async () => {
    const u = await getUserByFirstName(env, 'Bobby');
    expect(u).toMatchObject({ firstName: 'Bob', rfUserId: 900003 });
  });

  it('returns null for unknown / null / empty', async () => {
    expect(await getUserByFirstName(env, 'Nobody')).toBeNull();
    expect(await getUserByFirstName(env, null)).toBeNull();
    expect(await getUserByFirstName(env, '')).toBeNull();
  });
});

describe('getUserByDialpadId', () => {
  it('returns the record for a known dialpad id (string input)', async () => {
    expect(await getUserByDialpadId(env, '8000000000000001')).toMatchObject({ firstName: 'Joel' });
  });

  it('coerces numeric input to string', async () => {
    expect(await getUserByDialpadId(env, 8000000000000001)).toMatchObject({ firstName: 'Joel' });
  });

  it('returns null for unknown / null', async () => {
    expect(await getUserByDialpadId(env, '0000')).toBeNull();
    expect(await getUserByDialpadId(env, null)).toBeNull();
  });
});

describe('getUserByRFUserId / resolveRFUserId / isMonitoredDialpadUser', () => {
  it('round-trips RF user id', async () => {
    expect(await getUserByRFUserId(env, 900001)).toMatchObject({ firstName: 'Joel' });
    expect(await resolveRFUserId(env, 'Joel')).toBe(900001);
    expect(await getRFUserIdByDialpadId(env, '8000000000000001')).toBe(900001);
    expect(await isMonitoredDialpadUser(env, '8000000000000001')).toBe(true);
    expect(await isMonitoredDialpadUser(env, 'unknown')).toBe(false);
  });
});

describe('cache behavior', () => {
  it('reads D1 once across multiple sequential lookups', async () => {
    let queryCount = 0;
    const originalPrepare = env.USERS_DB.prepare.bind(env.USERS_DB);
    env.USERS_DB.prepare = (sql) => { queryCount++; return originalPrepare(sql); };
    try {
      await getUserByEmail(env, 'joel@test.local');
      await getUserByDialpadId(env, '8000000000000001');
      await getUserByFirstName(env, 'Alice');
      expect(queryCount).toBe(1); // single warm-up read; subsequent calls hit cache
    } finally {
      env.USERS_DB.prepare = originalPrepare;
    }
  });

  it('collapses concurrent cold-start callers to a single D1 read', async () => {
    let queryCount = 0;
    const originalPrepare = env.USERS_DB.prepare.bind(env.USERS_DB);
    env.USERS_DB.prepare = (sql) => { queryCount++; return originalPrepare(sql); };
    try {
      // All three fire from a clean cache; in-flight Promise memoization
      // should collapse them to one read.
      await Promise.all([
        getUserByEmail(env, 'joel@test.local'),
        getUserByDialpadId(env, '8000000000000001'),
        getUserByFirstName(env, 'Alice'),
      ]);
      expect(queryCount).toBe(1);
    } finally {
      env.USERS_DB.prepare = originalPrepare;
    }
  });

  it('retries after a rejected first load (does not poison the cache)', async () => {
    const originalPrepare = env.USERS_DB.prepare.bind(env.USERS_DB);
    let attempt = 0;
    env.USERS_DB.prepare = (sql) => {
      attempt++;
      if (attempt === 1) {
        return { all: async () => { throw new Error('transient D1 error'); } };
      }
      return originalPrepare(sql);
    };
    try {
      await expect(getUserByEmail(env, 'joel@test.local')).rejects.toThrow(/transient D1 error/);
      // Second call should retry cleanly (cache stays null, inflight cleared).
      const u = await getUserByEmail(env, 'joel@test.local');
      expect(u).toMatchObject({ firstName: 'Joel' });
      expect(attempt).toBe(2);
    } finally {
      env.USERS_DB.prepare = originalPrepare;
    }
  });
});

describe('byFirstName collision semantics', () => {
  it('a primary firstName wins over a colliding alias on another record', async () => {
    // Inject a deliberate collision: a teammate primary-named "Bobby" alongside
    // Bob who has alias ["Bobby"]. Primary should win.
    await env.USERS_DB.prepare(
      "INSERT INTO users (email, rf_user_id, dialpad_id, first_name) VALUES ('user6@test.local', 9999, '9999999999999999', 'Bobby')"
    ).run();
    _resetCacheForTests();

    const u = await getUserByFirstName(env, 'Bobby');
    expect(u).toMatchObject({ email: 'user6@test.local', rfUserId: 9999 });
    expect(u.firstName).toBe('Bobby');
  });
});
