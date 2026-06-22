import { describe, it, expect } from 'vitest';
import {
	digitsOnly,
	dedupeByDigits,
	hasExtension,
	isExcludedEntry,
	buildPhoneOrder,
} from '../src/phone-merge.js';

// --- fixtures, shaped from real Apollo webhook payloads ---

const mobileUS = { type_cd: 'mobile', raw_number: '+1 301-555-0163', sanitized_number: '+13015550163' };
const otherUS = { type_cd: 'other', raw_number: '+1 415-555-0142', sanitized_number: '+14155550142' };
const homeUS = { type_cd: 'home', raw_number: '+1 212-555-0188', sanitized_number: '+12125550188' };
const workDirectUS = { type_cd: 'work_direct', raw_number: '+1 703-555-0153', sanitized_number: '+17035550153' };
const extNumber = { type_cd: 'mobile', raw_number: '+1 415-555-0170 ext 3', sanitized_number: '+14155550170ext3' };

describe('digitsOnly / dedupeByDigits', () => {
	it('strips non-digits', () => {
		expect(digitsOnly('+1 301-555-0163')).toBe('13015550163');
		expect(digitsOnly(null)).toBe('');
	});

	it('dedupes by digits, preserving first-seen order and format', () => {
		expect(dedupeByDigits(['+13015550163', '+1 301-555-0163', '+14155550142'])).toEqual([
			'+13015550163',
			'+14155550142',
		]);
	});
});

describe('exclusion rules', () => {
	it('detects extensions in raw or sanitized number', () => {
		expect(hasExtension(extNumber)).toBe(true);
		expect(hasExtension(mobileUS)).toBe(false);
	});

	it('excludes any work_* type and any extension number, keeps mobile/home/other', () => {
		expect(isExcludedEntry(workDirectUS)).toBe(true);
		expect(isExcludedEntry({ type_cd: 'work_hq' })).toBe(true);
		expect(isExcludedEntry({ type_cd: 'work_mobile' })).toBe(true);
		expect(isExcludedEntry(extNumber)).toBe(true);
		expect(isExcludedEntry(mobileUS)).toBe(false);
		expect(isExcludedEntry(homeUS)).toBe(false);
		expect(isExcludedEntry(otherUS)).toBe(false);
	});

	it('excludes Apollo-flagged invalid_number but not valid/verified ones', () => {
		expect(isExcludedEntry({ type_cd: 'mobile', sanitized_number: '+10000000000', status_cd: 'invalid_number' })).toBe(true);
		expect(isExcludedEntry({ type_cd: 'mobile', sanitized_number: '+13015550163', status_cd: 'valid_number' })).toBe(false);
	});
});

describe('buildPhoneOrder — single mobile (the common case)', () => {
	const result = buildPhoneOrder({ existingNumbers: [], apolloEntries: [mobileUS] });
	it('stores the one number', () => {
		expect(result.ordered).toEqual(['+13015550163']);
		expect(result.droppedUnnormalizable).toEqual([]);
	});
});

describe('buildPhoneOrder — multiple numbers ranked by type', () => {
	const result = buildPhoneOrder({
		existingNumbers: [],
		// deliberately out of order: other, then home, then mobile
		apolloEntries: [otherUS, homeUS, mobileUS],
	});
	it('orders mobile > home > other', () => {
		expect(result.ordered).toEqual(['+13015550163', '+12125550188', '+14155550142']);
	});
});

describe('buildPhoneOrder — excludes work_direct + extension entirely', () => {
	const result = buildPhoneOrder({ existingNumbers: [], apolloEntries: [workDirectUS, extNumber] });
	it('stores nothing', () => {
		expect(result.ordered).toEqual([]);
	});
});

describe('buildPhoneOrder — pre-existing manual numbers stay at the top', () => {
	const result = buildPhoneOrder({
		existingNumbers: ['+19785551234'], // hand-entered, not from enrichment
		apolloEntries: [mobileUS],
	});
	it('keeps the manual number at [0] and appends the enriched one', () => {
		expect(result.ordered).toEqual(['+19785551234', '+13015550163']);
	});
});

describe('buildPhoneOrder — a manual number Apollo also returns is deduped, not duplicated', () => {
	const result = buildPhoneOrder({
		existingNumbers: ['+13015550163'],
		apolloEntries: [mobileUS],
	});
	it('keeps a single copy', () => {
		expect(result.ordered).toEqual(['+13015550163']);
	});
});

describe('buildPhoneOrder — preserves existing non-E.164 numbers (no silent data loss)', () => {
	const result = buildPhoneOrder({
		existingNumbers: ['0151234567'], // a number RF stored in a non-E.164 shape
		apolloEntries: [mobileUS],
	});
	it('keeps the original existing string and appends the enriched one', () => {
		expect(result.ordered).toEqual(['0151234567', '+13015550163']);
	});
});

describe('buildPhoneOrder — un-normalizable Apollo number is surfaced, not silently lost', () => {
	const unprefixed = { type_cd: 'mobile', raw_number: '015123456789', sanitized_number: '015123456789' };
	const result = buildPhoneOrder({ existingNumbers: [], apolloEntries: [unprefixed] });
	it('reports it via droppedUnnormalizable and stores nothing', () => {
		expect(result.ordered).toEqual([]);
		expect(result.droppedUnnormalizable).toEqual(['015123456789']);
	});
});
