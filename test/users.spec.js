import { describe, it, expect } from 'vitest';
import {
	getUserByFirstName,
	getUserByDialpadId,
	getUserByRFUserId,
	resolveRFUserId,
	getRFUserIdByDialpadId,
	isMonitoredDialpadUser,
} from '../src/users.js';

describe('getUserByFirstName', () => {
	it('returns the record for a known first name', () => {
		const u = getUserByFirstName('Joel');
		expect(u).toEqual({ firstName: 'Joel', rfUserId: 900001, dialpadId: '8000000000000001' });
	});

	it('is case-insensitive and trims whitespace', () => {
		expect(getUserByFirstName('  joel  ')).toMatchObject({ rfUserId: 900001 });
		expect(getUserByFirstName('ALICE')).toMatchObject({ rfUserId: 900002 });
	});

	it('returns null for unknown name', () => {
		expect(getUserByFirstName('Nobody')).toBeNull();
	});

	it('returns null for empty / null / undefined input', () => {
		expect(getUserByFirstName('')).toBeNull();
		expect(getUserByFirstName(null)).toBeNull();
		expect(getUserByFirstName(undefined)).toBeNull();
	});
});

describe('getUserByDialpadId', () => {
	it('returns the record for a known dialpad id (string input)', () => {
		expect(getUserByDialpadId('8000000000000001')).toMatchObject({ firstName: 'Joel' });
	});

	it('coerces numeric input to string before lookup', () => {
		expect(getUserByDialpadId(8000000000000001)).toMatchObject({ firstName: 'Joel' });
	});

	it('returns null for unknown id', () => {
		expect(getUserByDialpadId('9999999999999999')).toBeNull();
	});
});

describe('getUserByRFUserId', () => {
	it('returns the record for a known RF user id', () => {
		expect(getUserByRFUserId(900001)).toMatchObject({ firstName: 'Joel' });
	});

	it('returns null for unknown id', () => {
		expect(getUserByRFUserId(0)).toBeNull();
	});
});

describe('resolveRFUserId', () => {
	it('returns the rfUserId for a known consultant', () => {
		expect(resolveRFUserId('Joel')).toBe(900001);
		expect(resolveRFUserId('Alice')).toBe(900002);
	});

	it('returns null for unknown / empty name', () => {
		expect(resolveRFUserId('Nobody')).toBeNull();
		expect(resolveRFUserId('')).toBeNull();
	});
});

describe('getRFUserIdByDialpadId', () => {
	it('returns the rfUserId for a known dialpad id', () => {
		expect(getRFUserIdByDialpadId('8000000000000001')).toBe(900001);
		expect(getRFUserIdByDialpadId('8000000000000002')).toBe(900002);
	});

	it('returns null for unknown id', () => {
		expect(getRFUserIdByDialpadId('9999999999999999')).toBeNull();
	});
});

describe('isMonitoredDialpadUser', () => {
	it('returns true for known dialpad ids', () => {
		expect(isMonitoredDialpadUser('8000000000000001')).toBe(true);
		expect(isMonitoredDialpadUser(8000000000000001)).toBe(true);
	});

	it('returns false for unknown ids', () => {
		expect(isMonitoredDialpadUser('9999999999999999')).toBe(false);
	});
});
