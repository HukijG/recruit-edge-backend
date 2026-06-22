import { describe, it, expect } from 'vitest';
import {
	digitsOnly,
	dedupeByDigits,
	hasExtension,
	isExcludedEntry,
	attributeSource,
	isApolloLikeSource,
	regionFor,
	buildPhoneOrder,
} from '../src/phone-merge.js';

// --- realistic fixtures, shaped from real 2026-06-18 Apollo webhook payloads ---

const mobileUS = { type_cd: 'mobile', raw_number: '+1 301-555-0163', sanitized_number: '+5555550100' };
const otherUS = { type_cd: 'other', raw_number: '+1 415-555-0142', sanitized_number: '+14155550142' };
const homeUS = { type_cd: 'home', raw_number: '+1 212-555-0188', sanitized_number: '+12125550188' };
const workDirectUS = { type_cd: 'work_direct', raw_number: '+1 703-555-0153', sanitized_number: '+17035550153' };
const extNumber = { type_cd: 'mobile', raw_number: '+1 415-555-0170 ext 3', sanitized_number: '+14155550170ext3' };
const mobileDE = { type_cd: 'mobile', raw_number: '+49 151 23456789', sanitized_number: '+4915123456789' };

function apolloWaterfall(producedRaw, vendorName = 'Apollo') {
	return {
		phone_numbers: [
			{ vendors: [{ id: 'contactout-1', name: 'ContactOut', status: 'SKIPPED', phone_numbers: [] }] },
			{
				vendors: [
					{ id: 'apollo-1', name: vendorName, status: 'VERIFIED', phone_numbers: [producedRaw] },
					{ id: 'clearout-1', name: 'Clearout Phone', status: 'validated', usedForVerification: true },
				],
			},
		],
	};
}

function contactOutWaterfall(producedRaw) {
	return {
		phone_numbers: [
			{ vendors: [{ id: 'apollo-1', name: 'Apollo', status: 'SKIPPED', statusCode: 'request_already_fulfilled', phone_numbers: [] }] },
			{ vendors: [{ id: 'contactout-1', name: 'ContactOut', status: 'VERIFIED', phone_numbers: [producedRaw] }] },
		],
	};
}

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

describe('attributeSource', () => {
	it('matches a delivered number to its waterfall vendor by digits', () => {
		const wf = apolloWaterfall('+1 301-555-0163');
		expect(attributeSource('+5555550100', wf)).toBe('Apollo');
	});

	it('attributes ContactOut-sourced numbers', () => {
		const wf = contactOutWaterfall('+49 151 23456789');
		expect(attributeSource('+4915123456789', wf)).toBe('ContactOut');
	});

	it('returns "unknown" when no vendor produced the number', () => {
		expect(attributeSource('+19999999999', apolloWaterfall('+1 301-555-0163'))).toBe('unknown');
		expect(attributeSource('+5555550100', null)).toBe('unknown');
	});

	it('isApolloLikeSource treats Apollo and unknown as apollo-like, ContactOut as not', () => {
		expect(isApolloLikeSource('Apollo')).toBe(true);
		expect(isApolloLikeSource('unknown')).toBe(true);
		expect(isApolloLikeSource('')).toBe(true);
		expect(isApolloLikeSource('ContactOut')).toBe(false);
	});
});

describe('regionFor', () => {
	it('classifies US/Canada as apollo_strong', () => {
		expect(regionFor('United States', null)).toBe('apollo_strong');
		expect(regionFor('Canada', null)).toBe('apollo_strong');
	});
	it('classifies other countries as apollo_weak', () => {
		expect(regionFor('Germany', null)).toBe('apollo_weak');
	});
	it('falls back to the number country code when country is missing', () => {
		expect(regionFor('', '+4915123456789')).toBe('apollo_weak');
		expect(regionFor('', '+5555550100')).toBe('apollo_strong');
	});
});

describe('buildPhoneOrder — single US mobile (the common case)', () => {
	const result = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		apolloEntries: [mobileUS],
		waterfall: apolloWaterfall('+1 301-555-0163'),
		candidateCountry: 'United States',
	});

	it('stores the one number, region strong, best is Apollo', () => {
		expect(result.ordered).toEqual(['+5555550100']);
		expect(result.region).toBe('apollo_strong');
		expect(result.best.source).toBe('Apollo');
		expect(result.survivorsCount).toBe(1);
		expect(result.producedSomethingNew).toBe(true);
	});
});

describe('buildPhoneOrder — multiple numbers in one webhook, ranked by type', () => {
	const result = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		// deliberately out of order: other before mobile
		apolloEntries: [otherUS, mobileUS],
		waterfall: { phone_numbers: [{ vendors: [{ name: 'Apollo', phone_numbers: ['+1 415-555-0142', '+1 301-555-0163'] }] }] },
		candidateCountry: 'United States',
	});

	it('ranks mobile ahead of other (mobile becomes [0])', () => {
		expect(result.ordered[0]).toBe('+5555550100');
		expect(result.ordered).toContain('+14155550142');
		expect(result.ordered).toHaveLength(2);
	});
});

describe('buildPhoneOrder — excludes work_direct + extension entirely', () => {
	const result = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		apolloEntries: [workDirectUS, extNumber],
		waterfall: apolloWaterfall('+1 703-555-0153'),
		candidateCountry: 'United States',
	});

	it('stores nothing, signals zero survivors (handler will re-run)', () => {
		expect(result.ordered).toEqual([]);
		expect(result.survivorsCount).toBe(0);
		expect(result.producedSomethingNew).toBe(true);
	});
});

describe('buildPhoneOrder — pre-existing manual numbers stay at the top', () => {
	const result = buildPhoneOrder({
		existingNumbers: ['+19785551234'], // hand-entered, not from enrichment
		state: {},
		apolloEntries: [mobileUS],
		waterfall: apolloWaterfall('+1 301-555-0163'),
		candidateCountry: 'United States',
	});

	it('keeps the manual number at [0] and appends the enriched one', () => {
		expect(result.ordered).toEqual(['+19785551234', '+5555550100']);
	});
});

describe('buildPhoneOrder — EU re-run sequence (Apollo then ContactOut)', () => {
	// Pass 1: Germany candidate, Apollo returns a number → best is apollo-like → handler re-runs.
	const pass1 = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		apolloEntries: [{ type_cd: 'mobile', raw_number: '+49 30 1111111', sanitized_number: '+49301111111' }],
		waterfall: apolloWaterfall('+49 30 1111111'),
		candidateCountry: 'Germany',
	});

	it('pass 1: region weak, stores the Apollo number but flags it for re-run', () => {
		expect(pass1.region).toBe('apollo_weak');
		expect(pass1.ordered).toEqual(['+49301111111']);
		expect(pass1.bestIsApolloLike).toBe(true);
		expect(pass1.survivorsCount).toBe(1);
	});

	// Pass 2: re-run lands a ContactOut number; prior Apollo number carried in via state.
	const pass2 = buildPhoneOrder({
		existingNumbers: ['+49301111111'], // the apollo number we stored in pass 1
		state: pass1.nextState,
		apolloEntries: [mobileDE],
		waterfall: contactOutWaterfall('+49 151 23456789'),
		candidateCountry: 'Germany',
	});

	it('pass 2: ContactOut number takes [0], Apollo number drops below it', () => {
		expect(pass2.ordered[0]).toBe('+4915123456789');
		expect(pass2.ordered).toContain('+49301111111');
		expect(pass2.best.source).toBe('ContactOut');
		expect(pass2.bestIsApolloLike).toBe(false);
	});
});

describe('buildPhoneOrder — a manual number Apollo also returns is deduped, not duplicated', () => {
	const result = buildPhoneOrder({
		existingNumbers: ['+5555550100'], // hand-entered, and Apollo returns the same number
		state: {},
		apolloEntries: [mobileUS],
		waterfall: apolloWaterfall('+1 301-555-0163'),
		candidateCountry: 'United States',
	});

	it('keeps a single copy (it moves from manual into the ranked pool)', () => {
		expect(result.ordered).toEqual(['+5555550100']);
	});
});

describe('buildPhoneOrder — US multi-source tie-break prefers the extra (non-Apollo) source', () => {
	const apolloMobile = { type_cd: 'mobile', raw_number: '+1 301-555-0163', sanitized_number: '+5555550100' };
	const contactOutMobile = { type_cd: 'mobile', raw_number: '+1 415-555-0142', sanitized_number: '+14155550142' };
	const waterfall = {
		phone_numbers: [
			{ vendors: [{ name: 'Apollo', status: 'VERIFIED', phone_numbers: ['+1 301-555-0163'] }] },
			{ vendors: [{ name: 'ContactOut', status: 'VERIFIED', phone_numbers: ['+1 415-555-0142'] }] },
		],
	};
	const result = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		apolloEntries: [apolloMobile, contactOutMobile],
		waterfall,
		candidateCountry: 'United States',
	});

	it('two same-type US mobiles: the ContactOut one wins [0]', () => {
		expect(result.region).toBe('apollo_strong');
		expect(result.ordered[0]).toBe('+14155550142');
		expect(result.ordered).toHaveLength(2);
	});
});

describe('buildPhoneOrder — un-normalizable kept number is surfaced, not silently lost', () => {
	const unprefixed = { type_cd: 'mobile', raw_number: '015123456789', sanitized_number: '015123456789' };
	const result = buildPhoneOrder({
		existingNumbers: [],
		state: {},
		apolloEntries: [unprefixed],
		waterfall: { phone_numbers: [{ vendors: [{ name: 'ContactOut', phone_numbers: ['015123456789'] }] }] },
		candidateCountry: 'Germany',
	});

	it('reports it via droppedUnnormalizable and still counts as new (so re-run logic is not blinded)', () => {
		expect(result.ordered).toEqual([]);
		expect(result.survivorsCount).toBe(0);
		expect(result.droppedUnnormalizable).toEqual(['015123456789']);
		expect(result.producedSomethingNew).toBe(true);
	});
});

describe('regionFor — robust to US/Canada string variants', () => {
	it('classifies common variants as apollo_strong', () => {
		expect(regionFor('USA', null)).toBe('apollo_strong');
		expect(regionFor('United States of America', null)).toBe('apollo_strong');
		expect(regionFor('U.S.', null)).toBe('apollo_strong');
		expect(regionFor('Canada', null)).toBe('apollo_strong');
	});
});

describe('buildPhoneOrder — waterfall exhaustion (re-run yields nothing new)', () => {
	const state = { seen: ['5555550100'], added: [{ digits: '5555550100', e164: '+5555550100', source: 'Apollo', typeRank: 0 }], rerunCount: 1 };
	const result = buildPhoneOrder({
		existingNumbers: ['+5555550100'],
		state,
		apolloEntries: [mobileUS], // same number returned again
		waterfall: apolloWaterfall('+1 301-555-0163'),
		candidateCountry: 'United States',
	});

	it('reports producedSomethingNew=false so the handler stops re-running', () => {
		expect(result.producedSomethingNew).toBe(false);
		expect(result.ordered).toEqual(['+5555550100']);
	});
});
