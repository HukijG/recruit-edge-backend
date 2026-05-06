import { describe, it, expect } from 'vitest';
import { isValidLinkedInUrl, normalizeLinkedInUrl } from '../src/rf-client.js';

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
