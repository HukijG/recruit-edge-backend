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
