/**
 * Apollo API Client
 *
 * Provides people enrichment and search via the Apollo.io API.
 */

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Enrich a person via Apollo People Enrichment API.
 *
 * @param {Object} params - Lookup params: { linkedin_url, first_name, last_name, organization_name, id }
 * @param {Object} options - Optional: { reveal_phone_number, webhook_url }
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
			console.error({ message: `Apollo enrichPerson failed with status ${response.status}`, source: 'apollo' });
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
			console.error({ message: `Apollo searchPeople failed with status ${response.status}`, source: 'apollo' });
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
 * Verify an Apollo person matches an RF candidate.
 *
 * @param {Object} apolloPerson - Apollo person object with first_name, last_name, organization.name
 * @param {Object} rfCandidate - RF candidate with first_name, last_name, current_organization
 * @returns {{ match: boolean, reasons: string[] }}
 */
export function verifyApolloMatch(apolloPerson, rfCandidate) {
	const reasons = [];

	// First name: case-insensitive exact match (required)
	const aFirst = (apolloPerson.first_name || '').toLowerCase();
	const rFirst = (rfCandidate.first_name || '').toLowerCase();
	if (aFirst !== rFirst) {
		reasons.push(`First name mismatch: Apollo "${apolloPerson.first_name}" vs RF "${rfCandidate.first_name}"`);
	}

	// Last name: case-insensitive exact match, skip if RF last name is single char (with optional dot)
	const rfLast = rfCandidate.last_name || '';
	const singleCharLastName = /^[a-zA-Z]\.?$/.test(rfLast);
	if (!singleCharLastName) {
		const aLast = (apolloPerson.last_name || '').toLowerCase();
		const rLast = rfLast.toLowerCase();
		if (aLast !== rLast) {
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
 * Score and select the best Apollo search result for an RF candidate.
 *
 * @param {Array} results - Array of Apollo people search results
 * @param {Object} rfCandidate - RF candidate to match against
 * @returns {Object|null} Best matching result, or null if ambiguous/no match
 */
export function scoreSearchResults(results, rfCandidate) {
	if (!results || results.length === 0) return null;

	const rfFirst = (rfCandidate.first_name || '').toLowerCase();

	// Filter: first name exact match required
	const filtered = results.filter(r => (r.first_name || '').toLowerCase() === rfFirst);
	if (filtered.length === 0) return null;

	const rfTitle = (rfCandidate.current_title || '').toLowerCase();
	const rfOrg = normalizeOrgName(rfCandidate.current_organization);

	// Score each result
	const scored = filtered.map(r => {
		let score = 0;
		if ((r.title || '').toLowerCase() === rfTitle) score += 2;
		if (normalizeOrgName(r.organization?.name) === rfOrg) score += 2;
		if (r.has_direct_phone === 'Yes') score += 1;
		return { result: r, score };
	});

	// Must score >= 2
	const qualifying = scored.filter(s => s.score >= 2);
	if (qualifying.length === 0) return null;

	// Sort descending
	qualifying.sort((a, b) => b.score - a.score);

	// Check for ambiguity
	if (qualifying.length >= 2 && qualifying[0].score === qualifying[1].score) {
		return null;
	}

	return qualifying[0].result;
}
