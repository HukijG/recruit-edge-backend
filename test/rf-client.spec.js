import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	isValidLinkedInUrl,
	normalizeLinkedInUrl,
	parseRetryAfter,
	classifyRFResponse,
	RFError,
	RFRateLimitedError,
	RFTransientError,
	getRFCandidate,
	fetchRFJobPipeline,
	searchCandidatesByIdsAndPredicate,
	searchCandidatesByPredicateOnly,
	updateRFCandidate,
	addCandidateToJob,
	searchRFCandidateByPhone,
	RFContactConflictUnresolvedError,
} from '../src/rf-client.js';

describe('isValidLinkedInUrl', () => {
	it('accepts a full https URL with www', () => {
		expect(isValidLinkedInUrl('https://www.linkedin.com/in/jamie-lin')).toBe(true);
	});

	it('accepts a full https URL without www', () => {
		expect(isValidLinkedInUrl('https://linkedin.com/in/jamie-lin')).toBe(true);
	});

	it('accepts a URL without protocol (lowercase)', () => {
		expect(isValidLinkedInUrl('linkedin.com/in/jamie-lin')).toBe(true);
	});

	it('accepts a URL without protocol (capital L) — Reclaim form input', () => {
		expect(isValidLinkedInUrl('Linkedin.com/in/erygweyrib')).toBe(true);
	});

	it('accepts a URL with www but no protocol', () => {
		expect(isValidLinkedInUrl('www.linkedin.com/in/jamie-lin')).toBe(true);
	});

	it('accepts a /pub/ URL without protocol', () => {
		expect(isValidLinkedInUrl('linkedin.com/pub/jamie-lin/1/2/3')).toBe(true);
	});

	it('accepts a URL with trailing slash and surrounding whitespace', () => {
		expect(isValidLinkedInUrl('  Linkedin.com/in/jamie-lin/  ')).toBe(true);
	});

	it('rejects a bare slug', () => {
		expect(isValidLinkedInUrl('jamie-lin')).toBe(false);
	});

	it('rejects empty / null / non-string', () => {
		expect(isValidLinkedInUrl('')).toBe(false);
		expect(isValidLinkedInUrl(null)).toBe(false);
		expect(isValidLinkedInUrl(undefined)).toBe(false);
		expect(isValidLinkedInUrl(123)).toBe(false);
	});

	it('rejects unrelated strings', () => {
		expect(isValidLinkedInUrl('some random text')).toBe(false);
		expect(isValidLinkedInUrl('https://example.com/in/foo')).toBe(false);
	});
});

describe('normalizeLinkedInUrl — canonical key for both protocol and protocol-less inputs', () => {
	it('produces the same key for full URL and protocol-less form', () => {
		const a = normalizeLinkedInUrl('https://www.linkedin.com/in/erygweyrib/');
		const b = normalizeLinkedInUrl('Linkedin.com/in/erygweyrib');
		expect(a).toBe(b);
		expect(a).toBe('linkedin.com/in/erygweyrib');
	});
});

// ---------------------------------------------------------------------------
// RF error-classifier surface
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

const TEST_ENV = { RF_API_KEY: 'test-key', RF_API_BASE_URL: 'https://rf.test/api' };

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
}

function errorResponse(status, body, headers = {}) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'text/plain', ...headers },
	});
}

describe('parseRetryAfter', () => {
	it('parses integer-seconds form into ms', () => {
		expect(parseRetryAfter('5')).toBe(5000);
	});

	it('parses "0" → 0ms', () => {
		expect(parseRetryAfter('0')).toBe(0);
	});

	it('caps seconds-form values above 60s at 60_000ms', () => {
		expect(parseRetryAfter('120')).toBe(60_000);
		expect(parseRetryAfter('99999')).toBe(60_000);
	});

	it('parses HTTP-date form relative to now', () => {
		// Build a future date 5s out. HTTP-date format is seconds-resolution —
		// toUTCString() truncates milliseconds, so the round-trip can lose up to
		// 1000ms in either direction. Allow generous slop.
		const future = new Date(Date.now() + 5000).toUTCString();
		const ms = parseRetryAfter(future);
		expect(ms).toBeGreaterThanOrEqual(3500);
		expect(ms).toBeLessThanOrEqual(5500);
	});

	it('caps HTTP-date form above 60s at 60_000ms', () => {
		const far = new Date(Date.now() + 5 * 60_000).toUTCString();
		expect(parseRetryAfter(far)).toBe(60_000);
	});

	it('returns 0 for HTTP-date in the past', () => {
		const past = new Date(Date.now() - 5000).toUTCString();
		expect(parseRetryAfter(past)).toBe(0);
	});

	it('returns undefined for invalid / garbage values', () => {
		expect(parseRetryAfter('not-a-date')).toBeUndefined();
		expect(parseRetryAfter('abc123')).toBeUndefined();
		expect(parseRetryAfter('-5')).toBeUndefined();
	});

	it('returns undefined for missing header (null/undefined/empty)', () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter(undefined)).toBeUndefined();
		expect(parseRetryAfter('')).toBeUndefined();
		expect(parseRetryAfter('   ')).toBeUndefined();
	});
});

describe('classifyRFResponse', () => {
	it('returns RFRateLimitedError for 429 with parsed Retry-After', () => {
		const res = new Response('too many', {
			status: 429,
			headers: { 'Retry-After': '7' },
		});
		const err = classifyRFResponse(res, 'too many');
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.status).toBe(429);
		expect(err.retryAfterMs).toBe(7000);
		expect(err.body).toBe('too many');
	});

	it('returns RFRateLimitedError with retryAfterMs undefined when no Retry-After header', () => {
		const res = new Response('rate', { status: 429 });
		const err = classifyRFResponse(res, 'rate');
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.retryAfterMs).toBeUndefined();
	});

	it('returns RFTransientError for 500/502/503/504/599', () => {
		for (const status of [500, 502, 503, 504, 599]) {
			const res = new Response('boom', { status });
			const err = classifyRFResponse(res, 'boom');
			expect(err).toBeInstanceOf(RFTransientError);
			expect(err.status).toBe(status);
		}
	});

	it('returns plain RFError for other non-2xx (400, 401, 403, 404)', () => {
		for (const status of [400, 401, 403, 404]) {
			const res = new Response('nope', { status });
			const err = classifyRFResponse(res, 'nope');
			expect(err).toBeInstanceOf(RFError);
			expect(err).not.toBeInstanceOf(RFRateLimitedError);
			expect(err).not.toBeInstanceOf(RFTransientError);
			expect(err.status).toBe(status);
		}
	});
});

describe('getRFCandidate — error classification', () => {
	it('throws RFRateLimitedError on 429 with retryAfterMs populated from Retry-After: 5', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			errorResponse(429, 'rate-limited', { 'Retry-After': '5' }),
		);

		await expect(getRFCandidate(42, TEST_ENV)).rejects.toMatchObject({
			name: 'RFRateLimitedError',
			status: 429,
			retryAfterMs: 5000,
		});
		// 429 must NOT retry — exactly one fetch.
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('throws RFRateLimitedError on 429 with HTTP-date Retry-After', async () => {
		// HTTP-date format is seconds-resolution — toUTCString() drops millis, so
		// the round-trip can lose up to ~1000ms. Pick a 6s offset with generous
		// slop window.
		const future = new Date(Date.now() + 6000).toUTCString();
		globalThis.fetch = vi.fn().mockResolvedValue(
			errorResponse(429, 'rate', { 'Retry-After': future }),
		);

		const err = await getRFCandidate(42, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.retryAfterMs).toBeGreaterThanOrEqual(4500);
		expect(err.retryAfterMs).toBeLessThanOrEqual(6500);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('throws RFRateLimitedError on 429 with no Retry-After header → retryAfterMs undefined', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(429, 'rate'));

		const err = await getRFCandidate(42, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.retryAfterMs).toBeUndefined();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries once on 500 then throws RFTransientError', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(500, 'boom'))
			.mockResolvedValueOnce(errorResponse(500, 'boom'));

		await expect(getRFCandidate(42, TEST_ENV)).rejects.toMatchObject({
			name: 'RFTransientError',
			status: 500,
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries once on 502 (preserves existing behavior) then succeeds', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(502, 'gateway'))
			.mockResolvedValueOnce(jsonResponse({ candidate: { id: 42, first_name: 'Jerry' } }));

		const c = await getRFCandidate(42, TEST_ENV);
		expect(c).toEqual({ id: 42, first_name: 'Jerry' });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries once on 503 then throws RFTransientError', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(503, 'unavailable'))
			.mockResolvedValueOnce(errorResponse(503, 'unavailable'));

		await expect(getRFCandidate(42, TEST_ENV)).rejects.toMatchObject({
			name: 'RFTransientError',
			status: 503,
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('throws plain RFError on 400 (no retry, not RFTransient, not RFRateLimited)', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(400, 'bad request'));

		const err = await getRFCandidate(42, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFError);
		expect(err).not.toBeInstanceOf(RFTransientError);
		expect(err).not.toBeInstanceOf(RFRateLimitedError);
		expect(err.status).toBe(400);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('propagates original network error without wrapping (fetch() throws)', async () => {
		const netErr = new TypeError('Failed to fetch');
		globalThis.fetch = vi.fn().mockRejectedValue(netErr);

		const err = await getRFCandidate(42, TEST_ENV).catch(e => e);
		expect(err).toBe(netErr);
		expect(err).not.toBeInstanceOf(RFError);
	});
});

describe('fetchRFJobPipeline — error classification', () => {
	it('retries once on 502 then succeeds (preserves existing behavior)', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(502, 'gateway'))
			.mockResolvedValueOnce(jsonResponse({ summary: [], detail: [] }));

		const r = await fetchRFJobPipeline(TEST_ENV, 1234);
		expect(r).toEqual({ summary: [], detail: [] });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('throws RFRateLimitedError on 429, no retry', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			errorResponse(429, 'rate', { 'Retry-After': '3' }),
		);

		const err = await fetchRFJobPipeline(TEST_ENV, 1234).catch(e => e);
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.retryAfterMs).toBe(3000);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries once on 500 then throws RFTransientError', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(500, 'boom'))
			.mockResolvedValueOnce(errorResponse(500, 'boom'));

		await expect(fetchRFJobPipeline(TEST_ENV, 1234)).rejects.toMatchObject({
			name: 'RFTransientError',
			status: 500,
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});
});

describe('searchCandidatesByFilters (via searchCandidatesByIdsAndPredicate)', () => {
	it('retries once on 502 then succeeds on page 1', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(502, 'gateway'))
			.mockResolvedValueOnce(jsonResponse({
				data: [{ id: 1, first_name: 'A' }],
				total_items: 1,
			}));

		const r = await searchCandidatesByIdsAndPredicate(
			{ ids: [1, 2, 3], predicateFilters: [{ key: 'email', conjunction: 'in', values: ['a@b'] }] },
			TEST_ENV,
		);
		expect(r.candidates).toHaveLength(1);
		expect(r.totalItems).toBe(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries once on 500 then throws RFTransientError', async () => {
		globalThis.fetch = vi.fn()
			.mockResolvedValueOnce(errorResponse(500, 'oops'))
			.mockResolvedValueOnce(errorResponse(500, 'oops'));

		await expect(searchCandidatesByIdsAndPredicate(
			{ ids: [1], predicateFilters: [{ key: 'email', conjunction: 'in', values: ['x'] }] },
			TEST_ENV,
		)).rejects.toMatchObject({ name: 'RFTransientError', status: 500 });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('throws RFRateLimitedError on 429, no retry, fetch called exactly once', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			errorResponse(429, 'rate', { 'Retry-After': '10' }),
		);

		const err = await searchCandidatesByIdsAndPredicate(
			{ ids: [1, 2], predicateFilters: [{ key: 'email', conjunction: 'in', values: ['x'] }] },
			TEST_ENV,
		).catch(e => e);
		expect(err).toBeInstanceOf(RFRateLimitedError);
		expect(err.status).toBe(429);
		expect(err.retryAfterMs).toBe(10_000);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('throws plain RFError on 400 (no retry, not RFTransient, not RFRateLimited)', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(400, 'bad filter'));

		const err = await searchCandidatesByPredicateOnly(
			{ predicateFilters: [{ key: 'email', conjunction: 'in', values: ['x'] }] },
			TEST_ENV,
		).catch(e => e);
		expect(err).toBeInstanceOf(RFError);
		expect(err).not.toBeInstanceOf(RFTransientError);
		expect(err).not.toBeInstanceOf(RFRateLimitedError);
		expect(err.status).toBe(400);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('propagates original network error without wrapping', async () => {
		const netErr = new TypeError('connection refused');
		globalThis.fetch = vi.fn().mockRejectedValue(netErr);

		const err = await searchCandidatesByPredicateOnly(
			{ predicateFilters: [{ key: 'email', conjunction: 'in', values: ['x'] }] },
			TEST_ENV,
		).catch(e => e);
		expect(err).toBe(netErr);
	});
});

// ---------------------------------------------------------------------------
// addCandidateToJob — "already in pipeline" is a graceful signal, not an error
// ---------------------------------------------------------------------------

describe('addCandidateToJob — already-in-pipeline de-noise', () => {
	it('returns {status:"already_in_job"} on 409 "already present" without throwing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			errorResponse(409, { message: 'The candidate is already present in the job pipeline' }),
		);
		const res = await addCandidateToJob(1, 2, TEST_ENV);
		expect(res).toEqual({ status: 'already_in_job' });
	});

	it('still throws a typed RFError on genuine add-to-job failures', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(400, { message: 'bad request' }));
		const err = await addCandidateToJob(1, 2, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFError);
		expect(err.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// searchRFCandidateByPhone — digit-normalized owner lookup
// ---------------------------------------------------------------------------

describe('searchRFCandidateByPhone', () => {
	it('matches on digit-only equality across formatting / country code', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			jsonResponse({ candidates: [{ id: 1, phone_number: ['+1 (555) 111-2222'] }] }),
		);
		const c = await searchRFCandidateByPhone('5551112222', TEST_ENV);
		expect(c?.id).toBe(1);
	});

	it('filters out RF substring false-positives that do not truly match', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			jsonResponse({ candidates: [{ id: 9, phone_number: ['+1 555 000 0000'] }] }),
		);
		const c = await searchRFCandidateByPhone('5551112222', TEST_ENV);
		expect(c).toBeNull();
	});

	it('returns null for an empty / non-numeric input without calling RF', async () => {
		globalThis.fetch = vi.fn();
		expect(await searchRFCandidateByPhone('', TEST_ENV)).toBeNull();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// updateRFCandidate — universal non-destructive phone/email dedupe
// ---------------------------------------------------------------------------

function candidateGetResponse(body) {
	return jsonResponse({ candidate: body });
}

describe('updateRFCandidate — phone/email uniqueness dedupe', () => {
	it('resolves a phone conflict: strips the value from the other owner, then retries the target', async () => {
		const TARGET = 100, OWNER = 200;
		let targetUpdateCalls = 0;
		const updateBodies = [];

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;

			if (u.includes('/candidate/update')) {
				updateBodies.push(body);
				if (body.id === TARGET) {
					targetUpdateCalls++;
					// First attempt collides; retry (post-strip) succeeds.
					return targetUpdateCalls === 1
						? errorResponse(409, { message: 'A profile with this Phone Number already exists' })
						: jsonResponse({ ok: true });
				}
				// Owner strip-update.
				return jsonResponse({ ok: true });
			}
			if (u.includes('/candidate/get')) {
				const id = Number(new URL(u).searchParams.get('id'));
				if (id === TARGET) {
					return candidateGetResponse({ id: TARGET, name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', phone_number: [], jobs: [{ client_company_name: 'Acme' }], files: [{}], current_organization: 'Acme' });
				}
				// Owner is thin (no jobs, no resume) → should be flagged review_delete.
				return candidateGetResponse({ id: OWNER, name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', phone_number: [{ phone_number: '+1 (555) 111-2222', type: 1 }, { phone_number: '+1 555 999 0000' }], jobs: [], files: [], current_organization: '' });
			}
			if (u.includes('/candidate/search')) {
				return jsonResponse({ candidates: [{ id: OWNER, name: 'Jane Doe', phone_number: ['+15551112222'] }] });
			}
			throw new Error(`unexpected fetch ${u}`);
		});

		const res = await updateRFCandidate(TARGET, { phone_number: [{ phone_number: '555-111-2222', type: 1 }] }, TEST_ENV);

		expect(res).toEqual({ ok: true });
		expect(targetUpdateCalls).toBe(2); // initial 409 + post-strip retry

		// Owner-strip update removed the colliding phone, kept the other.
		const ownerStrip = updateBodies.find(b => b.id === OWNER);
		expect(ownerStrip).toBeTruthy();
		// Owner stores numbers with the +1 country code; the colliding one is
		// removed (tail-10 match) and the unrelated one is kept.
		const keptDigits = ownerStrip.phone_number.map(p => p.phone_number.replace(/\D/g, ''));
		expect(keptDigits).not.toContain('15551112222');
		expect(keptDigits).toContain('15559990000');
	});

	it('throws RFContactConflictUnresolvedError (no retry) when the other owner cannot be located', async () => {
		const TARGET = 100;
		let targetUpdateCalls = 0;

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			if (u.includes('/candidate/update')) {
				targetUpdateCalls++;
				return errorResponse(409, { message: 'A profile with this Email already exists' });
			}
			if (u.includes('/candidate/get')) {
				return candidateGetResponse({ id: TARGET, name: 'X', email: [], phone_number: [] });
			}
			if (u.includes('/candidate/search')) {
				return jsonResponse({ candidates: [] }); // owner not found
			}
			throw new Error(`unexpected fetch ${u}`);
		});

		const err = await updateRFCandidate(TARGET, { email: [{ email: 'dup@x.com', is_primary: 1 }] }, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFContactConflictUnresolvedError);
		expect(err.status).toBe(409);
		expect(targetUpdateCalls).toBe(1); // unresolved → no retry
	});

	it('does not trigger dedupe for an unrelated 409 — throws the raw RFError', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('/candidate/update')) {
				return errorResponse(409, { message: 'Some other conflict' });
			}
			throw new Error(`unexpected fetch ${u} — dedupe should not have searched`);
		});

		const err = await updateRFCandidate(100, { phone_number: [{ phone_number: '555' }] }, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFError);
		expect(err).not.toBeInstanceOf(RFContactConflictUnresolvedError);
		expect(err.status).toBe(409);
	});

	it('does not re-enter dedupe on the internal strip/retry updates (dedupe:false)', async () => {
		// Guard: with dedupe disabled, a 409 conflict must surface raw, never search.
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('/candidate/update')) {
				return errorResponse(409, { message: 'A profile with this Phone Number already exists' });
			}
			throw new Error(`unexpected fetch ${u} — should not search with dedupe:false`);
		});

		const err = await updateRFCandidate(100, { phone_number: [{ phone_number: '555' }] }, TEST_ENV, { dedupe: false }).catch(e => e);
		expect(err).toBeInstanceOf(RFError);
		expect(err.status).toBe(409);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// updateRFCandidate dedupe — review-hardening edge cases
// ---------------------------------------------------------------------------

describe('updateRFCandidate — dedupe edge cases', () => {
	it('skips a loose email search hit that does not actually hold the value (no wrong-record strip)', async () => {
		const TARGET = 100, FALSE_HIT = 300;
		const ownerUpdates = [];

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;
			if (u.includes('/candidate/update')) {
				if (body.id === TARGET) return errorResponse(409, { message: 'A profile with this Email already exists' });
				ownerUpdates.push(body);
				return jsonResponse({ ok: true });
			}
			if (u.includes('/candidate/get')) {
				const id = Number(new URL(u).searchParams.get('id'));
				if (id === TARGET) return candidateGetResponse({ id: TARGET, name: 'T', email: [], phone_number: [] });
				// Loose RF match: only substring-contains, exact value absent.
				return candidateGetResponse({ id: FALSE_HIT, name: 'Other', email: [{ email: 'dupe@example.com.au', is_primary: 1 }], phone_number: [] });
			}
			if (u.includes('/candidate/search')) return jsonResponse({ candidates: [{ id: FALSE_HIT, name: 'Other' }] });
			throw new Error(`unexpected fetch ${u}`);
		});

		const err = await updateRFCandidate(TARGET, { email: [{ email: 'dupe@example.com', is_primary: 1 }] }, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFContactConflictUnresolvedError);
		expect(ownerUpdates).toHaveLength(0); // never mutated the wrong record
	});

	it('promotes a surviving email to primary when the stripped one was primary', async () => {
		const TARGET = 100, OWNER = 400;
		let targetUpdateCalls = 0;
		let ownerStrip = null;

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;
			if (u.includes('/candidate/update')) {
				if (body.id === TARGET) {
					targetUpdateCalls++;
					return targetUpdateCalls === 1
						? errorResponse(409, { message: 'A profile with this Email already exists' })
						: jsonResponse({ ok: true });
				}
				ownerStrip = body;
				return jsonResponse({ ok: true });
			}
			if (u.includes('/candidate/get')) {
				const id = Number(new URL(u).searchParams.get('id'));
				if (id === TARGET) return candidateGetResponse({ id: TARGET, name: 'T', email: [], phone_number: [] });
				return candidateGetResponse({ id: OWNER, name: 'O', email: [{ email: 'dup@x.com', is_primary: 1 }, { email: 'second@x.com', is_primary: 0 }], phone_number: [] });
			}
			if (u.includes('/candidate/search')) return jsonResponse({ candidates: [{ id: OWNER, email: ['dup@x.com'] }] });
			throw new Error(`unexpected fetch ${u}`);
		});

		await updateRFCandidate(TARGET, { email: [{ email: 'dup@x.com', is_primary: 1 }] }, TEST_ENV);
		expect(ownerStrip.email).toEqual([{ email: 'second@x.com', is_primary: 1 }]);
	});

	it('resolves a record colliding on BOTH phone and email, and terminates', async () => {
		const TARGET = 100, OWNER = 500;
		let targetCalls = 0;
		const ownerUpdates = [];

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;
			if (u.includes('/candidate/update')) {
				if (body.id === TARGET) {
					targetCalls++;
					if (targetCalls === 1) return errorResponse(409, { message: 'A profile with this Phone Number already exists' });
					if (targetCalls === 2) return errorResponse(409, { message: 'A profile with this Email already exists' });
					return jsonResponse({ ok: true });
				}
				ownerUpdates.push(body);
				return jsonResponse({ ok: true });
			}
			if (u.includes('/candidate/get')) {
				const id = Number(new URL(u).searchParams.get('id'));
				if (id === TARGET) return candidateGetResponse({ id: TARGET, name: 'T', email: [], phone_number: [] });
				return candidateGetResponse({ id: OWNER, name: 'O', phone_number: [{ phone_number: '+15551112222' }], email: [{ email: 'dup@x.com', is_primary: 1 }] });
			}
			if (u.includes('/candidate/search')) return jsonResponse({ candidates: [{ id: OWNER, phone_number: ['+15551112222'], email: ['dup@x.com'] }] });
			throw new Error(`unexpected fetch ${u}`);
		});

		const res = await updateRFCandidate(TARGET, { phone_number: [{ phone_number: '5551112222' }], email: [{ email: 'dup@x.com', is_primary: 1 }] }, TEST_ENV);
		expect(res).toEqual({ ok: true });
		expect(targetCalls).toBe(3); // phone 409 → email 409 → success
		expect(ownerUpdates).toHaveLength(2); // phone strip + email strip
	});

	it('surfaces RFContactConflictUnresolvedError (not a raw RFError) when the target keeps colliding after strips', async () => {
		const TARGET = 100, OWNER = 600;
		let targetCalls = 0;

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;
			if (u.includes('/candidate/update')) {
				if (body.id === TARGET) { targetCalls++; return errorResponse(409, { message: 'A profile with this Phone Number already exists' }); }
				return jsonResponse({ ok: true });
			}
			if (u.includes('/candidate/get')) {
				const id = Number(new URL(u).searchParams.get('id'));
				if (id === TARGET) return candidateGetResponse({ id: TARGET, name: 'T', phone_number: [], email: [] });
				return candidateGetResponse({ id: OWNER, name: 'O', phone_number: [{ phone_number: '+15551112222' }], email: [] });
			}
			if (u.includes('/candidate/search')) return jsonResponse({ candidates: [{ id: OWNER, phone_number: ['+15551112222'] }] });
			throw new Error(`unexpected fetch ${u}`);
		});

		const err = await updateRFCandidate(TARGET, { phone_number: [{ phone_number: '5551112222' }] }, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFContactConflictUnresolvedError);
		expect(targetCalls).toBe(3); // depth 0,1,2 → typed throw, bounded
	});

	it('does not self-strip when the value is owned by the target itself', async () => {
		const TARGET = 100;
		const updates = [];

		globalThis.fetch = vi.fn(async (url, init) => {
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : null;
			if (u.includes('/candidate/update')) { updates.push(body); return errorResponse(409, { message: 'A profile with this Phone Number already exists' }); }
			if (u.includes('/candidate/get')) return candidateGetResponse({ id: TARGET, name: 'T', phone_number: [{ phone_number: '+15551112222' }], email: [] });
			if (u.includes('/candidate/search')) return jsonResponse({ candidates: [{ id: TARGET, phone_number: ['+15551112222'] }] });
			throw new Error(`unexpected fetch ${u}`);
		});

		const err = await updateRFCandidate(TARGET, { phone_number: [{ phone_number: '5551112222' }] }, TEST_ENV).catch(e => e);
		expect(err).toBeInstanceOf(RFContactConflictUnresolvedError);
		expect(updates.every(b => b.id === TARGET)).toBe(true); // never touched another record
	});
});
