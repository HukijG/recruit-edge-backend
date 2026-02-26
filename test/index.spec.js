import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';
import { extractCandidateEmail, formatKrispNotesAsHtml } from '../src/krisp.js';
import { createRFCustomActivity, extractRFIdFromDialpadContact } from '../src/rf-client.js';
import {
	isJoelsCall, isOutboundCall, truncateTranscript, formatActivityTime, classifyColdCall,
	normalizePhone, looksLikePhoneNumber
} from '../src/cold-call.js';

describe('RF-Dialpad Sync Worker', () => {
	it('/health returns 200 with status message', async () => {
		const request = new Request('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('RF-Dialpad Sync Middleware - OK');
	});

	it('unknown routes return 404', async () => {
		const request = new Request('http://example.com/unknown');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Manual RF webhook handler tests
// ---------------------------------------------------------------------------

describe('Manual RF webhook handler', () => {
	it('returns 401 without token query param', async () => {
		const request = new Request('http://example.com/webhook/recruiterflow/manual', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 123, name: 'Test User' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 401 with wrong token', async () => {
		const request = new Request('http://example.com/webhook/recruiterflow/manual?token=wrong', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 123, name: 'Test User' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 400 when payload missing candidate ID', async () => {
		const request = new Request(
			`http://example.com/webhook/recruiterflow/manual?token=${env.RF_WEBHOOK_SECRET}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'No ID' }),
			}
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('returns 200 and skips Dialpad sync for candidate missing required fields', async () => {
		const request = new Request(
			`http://example.com/webhook/recruiterflow/manual?token=${env.RF_WEBHOOK_SECRET}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: 99999,
					name: 'Test User',
					first_name: 'Test',
					last_name: 'User',
					email: '',
					phone_number: '',
					current_organization: '',
					current_title: '',
				}),
			}
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Krisp helper unit tests
// ---------------------------------------------------------------------------

describe('extractCandidateEmail', () => {
	it('returns non-Joel email from 2-person participant array', () => {
		const participants = [
			{ email: 'owner@example.com' },
			{ email: 'candidate@example.com' },
		];
		expect(extractCandidateEmail(participants)).toBe('candidate@example.com');
	});

	it('returns null when only Joel is present', () => {
		const participants = [{ email: 'owner@example.com' }];
		expect(extractCandidateEmail(participants)).toBeNull();
	});

	it('returns first non-Joel email in 3+ participant group calls', () => {
		const participants = [
			{ email: 'owner@example.com' },
			{ email: 'first-candidate@example.com' },
			{ email: 'second-person@example.com' },
		];
		expect(extractCandidateEmail(participants)).toBe('first-candidate@example.com');
	});

	it('returns null for empty array', () => {
		expect(extractCandidateEmail([])).toBeNull();
	});

	it('returns null for null input', () => {
		expect(extractCandidateEmail(null)).toBeNull();
	});

	it('returns null for undefined input', () => {
		expect(extractCandidateEmail(undefined)).toBeNull();
	});
});

describe('formatKrispNotesAsHtml', () => {
	const baseMeeting = {
		title: 'Engineering Sync',
		url: 'https://app.krisp.ai/meetings/abc123',
		start_date: '2026-02-10T19:00:00Z',
		duration: 1800, // 30 minutes
	};

	const twoSections = [
		{
			title: '**Key Discussion Points**',
			description: 'Talked about roadmap\nDiscussed hiring priorities',
		},
		{
			title: '**Action Items**',
			description: 'Follow up with candidate\nSchedule next round',
		},
	];

	it('formats a basic meeting with 2 content sections into HTML', () => {
		const html = formatKrispNotesAsHtml(baseMeeting, twoSections);

		// Outline header
		expect(html).toContain('<b>Outline</b>');

		// Meeting title wrapped in <a> tag pointing to Krisp URL
		expect(html).toContain('<a href="https://app.krisp.ai/meetings/abc123">Engineering Sync Call Notes</a>');

		// Duration in minutes
		expect(html).toContain('30m');

		// Section titles rendered as <b> tags, without ** markers
		expect(html).toContain('<b>Key Discussion Points</b>');
		expect(html).toContain('<b>Action Items</b>');
		expect(html).not.toContain('**');

		// Bullet points rendered as <li> tags
		expect(html).toContain('<li>Talked about roadmap</li>');
		expect(html).toContain('<li>Discussed hiring priorities</li>');
		expect(html).toContain('<li>Follow up with candidate</li>');
		expect(html).toContain('<li>Schedule next round</li>');
	});

	it('does not produce empty <li></li> tags from blank lines in descriptions', () => {
		const sectionsWithBlanks = [
			{
				title: 'Notes',
				description: 'First point\n\n\nSecond point\n\n',
			},
		];
		const html = formatKrispNotesAsHtml(baseMeeting, sectionsWithBlanks);

		expect(html).not.toContain('<li></li>');
		expect(html).toContain('<li>First point</li>');
		expect(html).toContain('<li>Second point</li>');
	});

	it('escapes special HTML characters in titles and descriptions', () => {
		const meeting = {
			...baseMeeting,
			title: 'R&D <Team> "Sync"',
			url: 'https://app.krisp.ai/meetings/abc&123',
		};
		const sections = [
			{
				title: 'Q&A Session',
				description: 'Discussed <script> injection & "quotes"',
			},
		];
		const html = formatKrispNotesAsHtml(meeting, sections);

		// Title should have & escaped
		expect(html).toContain('R&amp;D &lt;Team&gt; &quot;Sync&quot; Call Notes');

		// URL should have & escaped in href attribute
		expect(html).toContain('href="https://app.krisp.ai/meetings/abc&amp;123"');

		// Section title should have & escaped
		expect(html).toContain('<b>Q&amp;A Session</b>');

		// Description should have special chars escaped
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('&amp;');
		expect(html).toContain('&quot;quotes&quot;');
	});
});

// ---------------------------------------------------------------------------
// Krisp webhook handler tests
// ---------------------------------------------------------------------------

describe('Krisp webhook handler', () => {
	it('returns 401 without auth token', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ event: 'summary_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 401 with wrong auth token', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': 'wrong-secret',
			},
			body: JSON.stringify({ event: 'summary_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 200 and ignores key_points_generated events', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify({ event: 'key_points_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Dialpad call webhook handler tests
// ---------------------------------------------------------------------------

describe('Dialpad call webhook handler', () => {
	it('returns 401 without auth token', async () => {
		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ state: 'call_transcription' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// RF custom activity tests
// ---------------------------------------------------------------------------

describe('createRFCustomActivity', () => {
	it('throws when RF_API_KEY is missing', async () => {
		const env = { RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external' };
		await expect(
			createRFCustomActivity({ activity_text: 'test' }, env)
		).rejects.toThrow('RF_API_KEY environment variable is required');
	});
});

// ---------------------------------------------------------------------------
// Cold call helper unit tests
// ---------------------------------------------------------------------------

describe('isJoelsCall', () => {
	it('returns true for Joel Dialpad user ID as string', () => {
		expect(isJoelsCall('8000000000000001')).toBe(true);
	});

	it('returns true for Joel Dialpad user ID as number', () => {
		expect(isJoelsCall(8000000000000001)).toBe(true);
	});

	it('returns false for other user IDs', () => {
		expect(isJoelsCall('9999999999999999')).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isJoelsCall(undefined)).toBe(false);
	});
});

describe('isOutboundCall', () => {
	it('returns true for outbound', () => {
		expect(isOutboundCall('outbound')).toBe(true);
	});

	it('returns false for inbound', () => {
		expect(isOutboundCall('inbound')).toBe(false);
	});
});

describe('truncateTranscript', () => {
	it('returns text unchanged when under limit', () => {
		expect(truncateTranscript('short text', 5000)).toBe('short text');
	});

	it('truncates text exceeding limit', () => {
		const long = 'a'.repeat(6000);
		const result = truncateTranscript(long, 5000);
		expect(result.length).toBe(5000);
	});

	it('returns empty string for null input', () => {
		expect(truncateTranscript(null)).toBe('');
	});

	it('returns empty string for undefined input', () => {
		expect(truncateTranscript(undefined)).toBe('');
	});
});

describe('formatActivityTime', () => {
	it('formats unix ms timestamp to RF ISO format', () => {
		const result = formatActivityTime(1772101800000);
		expect(result).toBe('2026-02-26T10:30:00+0000');
	});

	it('formats ISO string input', () => {
		const result = formatActivityTime('2026-02-26T10:30:00.000Z');
		expect(result).toBe('2026-02-26T10:30:00+0000');
	});
});

// ---------------------------------------------------------------------------
// Cold call LLM classification tests (mocked AI)
// ---------------------------------------------------------------------------

describe('classifyColdCall', () => {
	it('returns is_cold_call false when transcript is empty', async () => {
		const mockEnv = { AI: { run: async () => ({}) } };
		const result = await classifyColdCall('', mockEnv);
		expect(result.is_cold_call).toBe(false);
		expect(result.reasoning).toBe('No transcript text available');
	});

	it('returns is_cold_call false when transcript is null', async () => {
		const mockEnv = { AI: { run: async () => ({}) } };
		const result = await classifyColdCall(null, mockEnv);
		expect(result.is_cold_call).toBe(false);
	});

	it('parses valid cold call JSON response from LLM', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: '{"is_cold_call": true, "reasoning": "Caller introduced themselves as a headhunter"}'
				})
			}
		};
		const result = await classifyColdCall('Hi, I am Joel, a global headhunter...', mockEnv);
		expect(result.is_cold_call).toBe(true);
		expect(result.reasoning).toContain('headhunter');
	});

	it('parses valid non-cold-call JSON response from LLM', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: '{"is_cold_call": false, "reasoning": "Familiar greeting, scheduled follow-up"}'
				})
			}
		};
		const result = await classifyColdCall('Hey mate, thanks for booking time...', mockEnv);
		expect(result.is_cold_call).toBe(false);
	});

	it('handles Workers AI returning response as already-parsed object', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: { is_cold_call: true, reasoning: 'First contact introduction via LinkedIn' }
				})
			}
		};
		const result = await classifyColdCall('Hi, I am Joel from...', mockEnv);
		expect(result.is_cold_call).toBe(true);
		expect(result.reasoning).toContain('LinkedIn');
	});

	it('handles Workers AI returning non-cold-call as already-parsed object', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: { is_cold_call: false, reasoning: 'Scheduled follow-up' }
				})
			}
		};
		const result = await classifyColdCall('Hey, thanks for booking...', mockEnv);
		expect(result.is_cold_call).toBe(false);
	});

	it('handles LLM response with extra text around JSON', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: 'Here is my analysis:\n{"is_cold_call": true, "reasoning": "First contact"}\nDone.'
				})
			}
		};
		const result = await classifyColdCall('Hi, I am Joel from...', mockEnv);
		expect(result.is_cold_call).toBe(true);
	});

	it('returns false when LLM returns unparseable response', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: 'I cannot determine this.'
				})
			}
		};
		const result = await classifyColdCall('Some transcript...', mockEnv);
		expect(result.is_cold_call).toBe(false);
		expect(result.reasoning).toBe('LLM response could not be parsed');
	});

	it('truncates long transcripts before sending to LLM', async () => {
		let capturedMessages = null;
		const mockEnv = {
			AI: {
				run: async (_model, opts) => {
					capturedMessages = opts.messages;
					return { response: '{"is_cold_call": false, "reasoning": "test"}' };
				}
			}
		};
		const longText = 'a'.repeat(10000);
		await classifyColdCall(longText, mockEnv);
		const userMessage = capturedMessages.find(m => m.role === 'user');
		// "Transcript:\n\n" prefix = 13 chars + 5000 truncated = 5013
		expect(userMessage.content.length).toBeLessThanOrEqual(5013);
	});

	it('parses JSON when LLM includes curly braces in reasoning text', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: '{"is_cold_call": true, "reasoning": "Caller used {name} introduction pattern typical of cold outreach"}'
				})
			}
		};
		const result = await classifyColdCall('Hi, this is Joel...', mockEnv);
		expect(result.is_cold_call).toBe(true);
		expect(result.reasoning).toContain('{name}');
	});

	it('parses JSON wrapped in markdown code blocks', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: '```json\n{"is_cold_call": false, "reasoning": "Scheduled follow-up call"}\n```'
				})
			}
		};
		const result = await classifyColdCall('Hey, thanks for hopping on...', mockEnv);
		expect(result.is_cold_call).toBe(false);
		expect(result.reasoning).toContain('follow-up');
	});

	it('returns false when LLM response has no JSON at all', async () => {
		const mockEnv = {
			AI: {
				run: async () => ({
					response: 'I cannot determine from this transcript whether it is a cold call.'
				})
			}
		};
		const result = await classifyColdCall('Some transcript...', mockEnv);
		expect(result.is_cold_call).toBe(false);
		expect(result.reasoning).toBe('LLM response could not be parsed');
	});

	it('returns false when LLM returns empty response', async () => {
		const mockEnv = {
			AI: { run: async () => ({ response: '' }) }
		};
		const result = await classifyColdCall('Some transcript...', mockEnv);
		expect(result.is_cold_call).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extractRFIdFromDialpadContact tests
// ---------------------------------------------------------------------------

describe('extractRFIdFromDialpadContact', () => {
	it('extracts RF ID from full Dialpad contact string', () => {
		expect(extractRFIdFromDialpadContact('shared_contact_pool_Company:0000000000000000_uid_RF12345')).toBe('12345');
	});

	it('returns null for contact without RF UID', () => {
		expect(extractRFIdFromDialpadContact('shared_contact_pool_Company:0000000000000000')).toBeNull();
	});

	it('returns null for null input', () => {
		expect(extractRFIdFromDialpadContact(null)).toBeNull();
	});

	it('returns null for undefined input', () => {
		expect(extractRFIdFromDialpadContact(undefined)).toBeNull();
	});

	it('handles numeric contact ID without crashing', () => {
		expect(extractRFIdFromDialpadContact(4670000000000000)).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(extractRFIdFromDialpadContact('')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Phone number helpers (deferred cold call processing)
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
	it('strips formatting from US phone number', () => {
		expect(normalizePhone('(650) 521-2531')).toBe('6505550125');
	});

	it('strips country code, keeps last 10 digits', () => {
		expect(normalizePhone('+16505550125')).toBe('6505550125');
	});

	it('handles plain digits', () => {
		expect(normalizePhone('6505550125')).toBe('6505550125');
	});

	it('returns null for null input', () => {
		expect(normalizePhone(null)).toBeNull();
	});

	it('returns null for short numbers', () => {
		expect(normalizePhone('123')).toBeNull();
	});

	it('handles 7-digit numbers', () => {
		expect(normalizePhone('521-2531')).toBe('5212531');
	});
});

describe('looksLikePhoneNumber', () => {
	it('returns true for formatted US phone', () => {
		expect(looksLikePhoneNumber('(650) 521-2531')).toBe(true);
	});

	it('returns true for plain digits', () => {
		expect(looksLikePhoneNumber('6505550125')).toBe(true);
	});

	it('returns false for a person name', () => {
		expect(looksLikePhoneNumber('Bradley Naumann')).toBe(false);
	});

	it('returns false for null', () => {
		expect(looksLikePhoneNumber(null)).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(looksLikePhoneNumber('')).toBe(false);
	});
});
