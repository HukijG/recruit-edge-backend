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
