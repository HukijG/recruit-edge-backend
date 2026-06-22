/**
 * Apollo API Client
 *
 * Provides people enrichment and search via the Apollo.io API.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Enrich a person via Apollo People Enrichment API.
 *
 * @param {Object} params - Lookup params: { linkedin_url, first_name, last_name, organization_name, id }
 * @param {Object} options - Optional: { reveal_phone_number, run_waterfall_phone, webhook_url }
 * @param {Object} env - Worker env with APOLLO_API_KEY
 * @returns {Object|null} The person object, or null if not found / error
 */
export async function enrichPerson(params, options, env) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const body = { ...params, ...options };
		const response = await fetch(`${APOLLO_BASE_URL}/people/match`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': env.APOLLO_API_KEY,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: `Apollo ${response.status}` });
			console.warn({ source: 'apollo', message: 'enrichPerson non-OK', status: response.status });
			return null;
		}

		const data = await response.json();
		return data.person || null;
	} catch (err) {
		console.error({ message: `Apollo enrichPerson error: ${err.message}`, source: 'apollo' });
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Search for people via Apollo People Search API.
 *
 * @param {Object} params - Search params: { q_keywords, person_titles, q_organization_domains_list, include_similar_titles }
 * @param {Object} env - Worker env with APOLLO_API_KEY
 * @returns {Array} Array of people objects, or [] on error
 */
export async function searchPeople(params, env) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const body = { ...params, page: 1, per_page: 25 };
		const response = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': env.APOLLO_API_KEY,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: `Apollo ${response.status}` });
			console.warn({ source: 'apollo', message: 'searchPeople non-OK', status: response.status });
			return [];
		}

		const data = await response.json();
		return data.people || [];
	} catch (err) {
		console.error({ message: `Apollo searchPeople error: ${err.message}`, source: 'apollo' });
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Normalize an organization name for comparison.
 * Lowercases, trims, and strips common corporate suffixes.
 *
 * @param {string|null|undefined} name
 * @returns {string} Normalized name, or empty string for null/undefined/empty/suffix-only
 */
export function normalizeOrgName(name) {
	if (!name || typeof name !== 'string') return '';
	const trimmed = name.trim().toLowerCase();
	if (!trimmed) return '';
	// Strip optional comma before suffix, suffix itself, optional trailing dot
	const stripped = trimmed.replace(/,?\s*\b(inc|ltd|llc|corp|co)\.?\s*$/i, '').trim();
	return stripped;
}

/**
 * Strip a leading middle initial (e.g. "N. Romero" → "Romero", "N Romero" → "Romero")
 * from a last name field. Only strips a single letter (with optional dot) followed by space.
 */
function stripMiddleInitial(lastName) {
	return lastName.replace(/^[a-z]\.?\s+/i, '');
}

/**
 * Case-insensitive last name comparison that tolerates middle initials
 * embedded in the last name field (e.g. RF "N. Romero" vs Apollo "Romero").
 */
function lastNamesMatch(a, b) {
	if (a === b) return true;
	return stripMiddleInitial(a) === stripMiddleInitial(b);
}

/**
 * Verify an Apollo person matches an RF candidate.
 *
 * @param {Object} apolloPerson - Apollo person object with first_name, last_name, organization.name
 * @param {Object} rfCandidate - RF candidate with first_name, last_name, current_organization
 * @returns {{ match: boolean, reasons: string[] }}
 */
export function verifyApolloMatch(apolloPerson, rfCandidate) {
	const reasons = [];

	// First name: case-insensitive exact match (required)
	const aFirst = (apolloPerson.first_name || '').trim().toLowerCase();
	const rFirst = (rfCandidate.first_name || '').trim().toLowerCase();
	if (aFirst !== rFirst) {
		reasons.push(`First name mismatch: Apollo "${apolloPerson.first_name}" vs RF "${rfCandidate.first_name}"`);
	}

	// Last name: case-insensitive match (tolerates middle initials), skip if RF last name is single char (with optional dot)
	const rfLast = (rfCandidate.last_name || '').trim();
	const singleCharLastName = /^[a-zA-Z]\.?$/.test(rfLast);
	if (!singleCharLastName) {
		const aLast = (apolloPerson.last_name || '').trim().toLowerCase();
		const rLast = rfLast.toLowerCase();
		if (!lastNamesMatch(aLast, rLast)) {
			reasons.push(`Last name mismatch: Apollo "${apolloPerson.last_name}" vs RF "${rfCandidate.last_name}"`);
		}
	}

	// Organization: normalizeOrgName on both, match required
	const aOrg = normalizeOrgName(apolloPerson.organization?.name);
	const rOrg = normalizeOrgName(rfCandidate.current_organization);
	if (aOrg !== rOrg) {
		reasons.push(`Organization mismatch: Apollo "${apolloPerson.organization?.name || null}" vs RF "${rfCandidate.current_organization || null}"`);
	}

	return { match: reasons.length === 0, reasons };
}

/**
 * Pre-filter People Search results before enrichment.
 * Filters by first name match and (for single-char last names) last_name_obfuscated first letter.
 * Caps results to limit credit spend on enrichment.
 *
 * @param {Array} results - Apollo People Search results
 * @param {Object} rfCandidate - RF candidate (webhook or cached)
 * @returns {Array} Filtered results, max 5
 */
export function filterSearchResults(results, rfCandidate) {
	if (!results || results.length === 0) return [];

	const rfFirst = (rfCandidate.first_name || '').trim().toLowerCase();
	const rfLast = (rfCandidate.last_name || '').trim();
	const isSingleCharLast = /^[a-zA-Z]\.?$/.test(rfLast);

	// First name exact match required
	let filtered = results.filter(r => (r.first_name || '').trim().toLowerCase() === rfFirst);

	// For single-char last names, filter by first letter of obfuscated last name
	if (isSingleCharLast && rfLast) {
		const firstLetter = rfLast.charAt(0).toLowerCase();
		filtered = filtered.filter(r => {
			const obfuscated = (r.last_name_obfuscated || '').trim();
			return obfuscated.length > 0 && obfuscated.charAt(0).toLowerCase() === firstLetter;
		});
	}

	// Cap at 5 to limit credit spend on enrichment
	return filtered.slice(0, 5);
}

/**
 * Score an enriched Apollo person against a full RF candidate.
 * Uses required gates (first name, org, last name when full) and confidence scoring
 * (title, location, education) on the rich data from both APIs.
 *
 * @param {Object} apolloPerson - Enriched Apollo person (from /people/match by ID)
 * @param {Object} rfFullCandidate - Full RF candidate from getRFCandidate() GET API
 * @returns {{ passed: boolean, confidence: number, score: number, maxPossible: number, gateFailures: string[], matches: string[], mismatches: string[] }}
 */
export function scoreEnrichedCandidate(apolloPerson, rfFullCandidate) {
	const gateFailures = [];

	// Gate: First name exact match (required)
	const aFirst = (apolloPerson.first_name || '').trim().toLowerCase();
	const rFirst = (rfFullCandidate.first_name || '').trim().toLowerCase();
	if (aFirst !== rFirst) {
		gateFailures.push('first_name');
	}

	// Gate: Organization match (required)
	const aOrg = normalizeOrgName(apolloPerson.organization?.name);
	const rOrg = normalizeOrgName(rfFullCandidate.current_organization);
	if (!aOrg || !rOrg || aOrg !== rOrg) {
		gateFailures.push('organization');
	}

	// Gate: Last name match (tolerates middle initials, required when not single-char)
	const rfLast = (rfFullCandidate.last_name || '').trim();
	const isSingleCharLast = /^[a-zA-Z]\.?$/.test(rfLast);
	if (!isSingleCharLast && rfLast) {
		const aLast = (apolloPerson.last_name || '').trim().toLowerCase();
		if (!lastNamesMatch(aLast, rfLast.toLowerCase())) {
			gateFailures.push('last_name');
		}
	}

	if (gateFailures.length > 0) {
		return { passed: false, confidence: 0, score: 0, maxPossible: 0, gateFailures, matches: [], mismatches: [] };
	}

	// Scoring — only reached if all gates pass
	let score = 0;
	let maxPossible = 0;
	const matches = [];
	const mismatches = [];

	// Title (30 points)
	maxPossible += 30;
	const aTitle = (apolloPerson.title || '').trim().toLowerCase();
	const rTitle = (rfFullCandidate.current_designation || rfFullCandidate.current_title || '').trim().toLowerCase();
	if (aTitle && rTitle && aTitle === rTitle) {
		score += 30;
		matches.push('title');
	} else {
		mismatches.push('title');
	}

	// Location — state (20), city (10), country (5)
	const rfLocation = rfFullCandidate.location;
	if (rfLocation) {
		if (rfLocation.state) {
			maxPossible += 20;
			if ((apolloPerson.state || '').trim().toLowerCase() === rfLocation.state.trim().toLowerCase()) {
				score += 20;
				matches.push('state');
			} else {
				mismatches.push('state');
			}
		}
		if (rfLocation.city) {
			maxPossible += 10;
			if ((apolloPerson.city || '').trim().toLowerCase() === rfLocation.city.trim().toLowerCase()) {
				score += 10;
				matches.push('city');
			} else {
				mismatches.push('city');
			}
		}
		if (rfLocation.country) {
			maxPossible += 5;
			if ((apolloPerson.country || '').trim().toLowerCase() === rfLocation.country.trim().toLowerCase()) {
				score += 5;
				matches.push('country');
			} else {
				mismatches.push('country');
			}
		}
	}

	// Education (15 points) — any school name match
	const rfEducation = rfFullCandidate.education;
	if (Array.isArray(rfEducation) && rfEducation.length > 0) {
		maxPossible += 15;
		const rfSchools = rfEducation
			.map(e => (e.school || '').trim().toLowerCase())
			.filter(Boolean);
		// Apollo stores education in employment_history with degree field populated
		const apolloSchools = (apolloPerson.employment_history || [])
			.filter(e => e.degree != null)
			.map(e => (e.organization_name || '').trim().toLowerCase())
			.filter(Boolean);

		const hasSchoolMatch = rfSchools.some(rs =>
			apolloSchools.some(as => as.includes(rs) || rs.includes(as))
		);
		if (hasSchoolMatch) {
			score += 15;
			matches.push('education');
		} else {
			mismatches.push('education');
		}
	}

	const confidence = maxPossible > 0 ? Math.round((score / maxPossible) * 100) : 100;
	return { passed: true, confidence, score, maxPossible, gateFailures: [], matches, mismatches };
}
