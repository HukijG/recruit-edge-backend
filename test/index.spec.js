import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src';
import { extractCandidateEmail, formatKrispNotesAsHtml } from '../src/krisp.js';
import { createRFCustomActivity, extractRFIdFromDialpadContact, findEligibleJob, convertDialpadContactToRFUpdate, findJobsForStageMove } from '../src/rf-client.js';
import {
	isOutboundCall, truncateTranscript, formatActivityTime, classifyColdCall, mergeTag, addHtmlLineBreaks
} from '../src/cold-call.js';
import { isMonitoredDialpadUser, getRFUserIdByDialpadId } from '../src/users.js';
import { enrichPerson, searchPeople, normalizeOrgName, verifyApolloMatch, filterSearchResults, scoreEnrichedCandidate } from '../src/apollo-client.js';
import { isJoelCandidate, enrichCandidate } from '../src/enrichment.js';

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

describe('isMonitoredDialpadUser', () => {
	it('returns true for Joel Dialpad user ID as string', () => {
		expect(isMonitoredDialpadUser('8000000000000001')).toBe(true);
	});

	it('returns true for Joel Dialpad user ID as number', () => {
		expect(isMonitoredDialpadUser(8000000000000001)).toBe(true);
	});

	it('returns true for Alice Dialpad user ID', () => {
		expect(isMonitoredDialpadUser('8000000000000002')).toBe(true);
	});

	it('returns false for other user IDs', () => {
		expect(isMonitoredDialpadUser('9999999999999999')).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isMonitoredDialpadUser(undefined)).toBe(false);
	});
});

describe('getRFUserIdByDialpadId', () => {
	it('returns Joel RF user ID for Joel Dialpad ID', () => {
		expect(getRFUserIdByDialpadId('8000000000000001')).toBe(900001);
	});

	it('returns Alice RF user ID for Alice Dialpad ID', () => {
		expect(getRFUserIdByDialpadId('8000000000000002')).toBe(900002);
	});

	it('coerces numeric Dialpad IDs', () => {
		expect(getRFUserIdByDialpadId(8000000000000001)).toBe(900001);
	});

	it('returns null for unknown Dialpad ID', () => {
		expect(getRFUserIdByDialpadId('1234567890')).toBeNull();
	});

	it('returns null for null/undefined', () => {
		expect(getRFUserIdByDialpadId(null)).toBeNull();
		expect(getRFUserIdByDialpadId(undefined)).toBeNull();
	});
});

describe('addHtmlLineBreaks', () => {
	it('replaces every \\n with <br>\\n', () => {
		expect(addHtmlLineBreaks('a\nb')).toBe('a<br>\nb');
	});

	it('produces double <br> for blank-line separators', () => {
		expect(addHtmlLineBreaks('header\n\nbody')).toBe('header<br>\n<br>\nbody');
	});

	it('handles a multi-line activity text end-to-end', () => {
		const input = 'Cold call with X — Connected (Positive)\n\nNext steps:\n- email follow-up\n- send JD';
		const expected = 'Cold call with X — Connected (Positive)<br>\n<br>\nNext steps:<br>\n- email follow-up<br>\n- send JD';
		expect(addHtmlLineBreaks(input)).toBe(expected);
	});

	it('does not append a trailing <br> when text has no trailing newline', () => {
		expect(addHtmlLineBreaks('single line')).toBe('single line');
	});

	it('returns single-line text unchanged', () => {
		expect(addHtmlLineBreaks('Cold call with X — Voicemail')).toBe('Cold call with X — Voicemail');
	});

	it('returns falsy input unchanged', () => {
		expect(addHtmlLineBreaks('')).toBe('');
		expect(addHtmlLineBreaks(null)).toBe(null);
		expect(addHtmlLineBreaks(undefined)).toBe(undefined);
	});
});

describe('mergeTag', () => {
	it('appends the tag when not present', () => {
		expect(mergeTag(['Active'], 'Cold Called')).toEqual(['Active', 'Cold Called']);
	});

	it('returns existing array unchanged when tag already present', () => {
		const existing = ['Active', 'Cold Called'];
		expect(mergeTag(existing, 'Cold Called')).toBe(existing);
	});

	it('handles non-array input by treating it as empty', () => {
		expect(mergeTag(null, 'Cold Called')).toEqual(['Cold Called']);
		expect(mergeTag(undefined, 'Cold Called')).toEqual(['Cold Called']);
		expect(mergeTag('not an array', 'Cold Called')).toEqual(['Cold Called']);
	});

	it('works for the Number Invalid tag', () => {
		expect(mergeTag([], 'Number Invalid')).toEqual(['Number Invalid']);
		const withTag = ['Number Invalid'];
		expect(mergeTag(withTag, 'Number Invalid')).toBe(withTag);
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
					return { response: '{"is_cold_call": false, "outcome": null, "reasoning": "test"}' };
				}
			}
		};
		const longText = 'a'.repeat(10000);
		await classifyColdCall(longText, mockEnv, 'call_transcription');
		const userMessage = capturedMessages.find(m => m.role === 'user');
		// "Call type: Connected call\n\nTranscript:\n\n" prefix = 40 chars + 5000 truncated = 5040
		expect(userMessage.content.length).toBeLessThanOrEqual(5040);
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
// findEligibleJob tests (stage movement eligibility)
// ---------------------------------------------------------------------------

describe('findEligibleJob', () => {
  // Helper: build a candidate GET response with jobs
  function buildCandidate(jobs) {
    return {
      id: 49503,
      first_name: 'Steve',
      last_name: 'Xu',
      jobs: jobs,
    };
  }

  function buildJob(overrides = {}) {
    return {
      job_id: 977,
      stage_name: 'Sourced',
      stage_moved: '2026-03-24T17:10:16+0000',
      added_to_job_by: { id: 900003, name: 'Bob Smith' },
      stages: [
        { id: 17934, name: 'Sourced', rank: 1 },
        { id: 17935, name: 'Applied', rank: 2 },
        { id: 17936, name: 'Replied', rank: 3 },
        { id: 17937, name: 'Replied (Cold)', rank: 4 },
        { id: 17938, name: 'Call Booked', rank: 5 },
        { id: 17939, name: 'Shortlist', rank: 6 },
      ],
      ...overrides,
    };
  }

  it('returns null when candidate has no jobs', () => {
    const candidate = buildCandidate([]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('returns null for null candidate', () => {
    expect(findEligibleJob(null)).toBeNull();
  });

  it('returns null for candidate with undefined jobs', () => {
    expect(findEligibleJob({ id: 1 })).toBeNull();
  });

  it('returns the job when candidate is in Sourced', () => {
    const candidate = buildCandidate([buildJob({ stage_name: 'Sourced' })]);
    const result = findEligibleJob(candidate);
    expect(result).not.toBeNull();
    expect(result.job_id).toBe(977);
    expect(result.targetStage.name).toBe('Call Booked');
  });

  it('returns the job when candidate is in Replied', () => {
    const candidate = buildCandidate([buildJob({ stage_name: 'Replied' })]);
    const result = findEligibleJob(candidate);
    expect(result).not.toBeNull();
  });

  it('returns the job when candidate is in Replied (Cold)', () => {
    const candidate = buildCandidate([buildJob({ stage_name: 'Replied (Cold)' })]);
    const result = findEligibleJob(candidate);
    expect(result).not.toBeNull();
  });

  it('returns null when candidate is already in Call Booked', () => {
    const candidate = buildCandidate([buildJob({ stage_name: 'Call Booked' })]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('returns null when candidate is in Shortlist (past Call Booked)', () => {
    const candidate = buildCandidate([buildJob({ stage_name: 'Shortlist' })]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('returns null when candidate is in 1st Interview', () => {
    const candidate = buildCandidate([buildJob({ stage_name: '1st Interview' })]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('picks the job with the most recent stage_moved when multiple jobs exist', () => {
    const oldJob = buildJob({
      job_id: 100,
      stage_name: 'Sourced',
      stage_moved: '2026-03-20T10:00:00+0000',
      stages: [
        { id: 50001, name: 'Sourced', rank: 1 },
        { id: 50002, name: 'Call Booked', rank: 5 },
      ],
    });
    const recentJob = buildJob({
      job_id: 200,
      stage_name: 'Replied',
      stage_moved: '2026-03-24T17:10:16+0000',
      stages: [
        { id: 60001, name: 'Replied', rank: 3 },
        { id: 60002, name: 'Call Booked', rank: 5 },
      ],
    });
    const candidate = buildCandidate([oldJob, recentJob]);
    const result = findEligibleJob(candidate);
    expect(result).not.toBeNull();
    expect(result.job_id).toBe(200);
    expect(result.targetStage.id).toBe(60002);
  });

  it('returns null when the most recent job is not in an eligible stage', () => {
    const eligibleOldJob = buildJob({
      job_id: 100,
      stage_name: 'Sourced',
      stage_moved: '2026-03-20T10:00:00+0000',
    });
    const ineligibleRecentJob = buildJob({
      job_id: 200,
      stage_name: 'Shortlist',
      stage_moved: '2026-03-24T17:10:16+0000',
    });
    const candidate = buildCandidate([eligibleOldJob, ineligibleRecentJob]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('returns null when job has no Call Booked stage in stages array', () => {
    const job = buildJob({
      stage_name: 'Sourced',
      stages: [
        { id: 17934, name: 'Sourced', rank: 1 },
        { id: 17935, name: 'Applied', rank: 2 },
      ],
    });
    const candidate = buildCandidate([job]);
    expect(findEligibleJob(candidate)).toBeNull();
  });

  it('falls back to Joel user ID (900001) when added_to_job_by is missing', () => {
    const job = buildJob({
      stage_name: 'Sourced',
      added_to_job_by: null,
    });
    const candidate = buildCandidate([job]);
    const result = findEligibleJob(candidate);
    expect(result).not.toBeNull();
    expect(result.userId).toBe(900001);
  });

  it('uses the Joel RF user ID sourced from users.js, not a duplicate literal', async () => {
    const { getUserByFirstName } = await import('../src/users.js');
    const joel = getUserByFirstName('Joel');
    // findEligibleJob's userId field must equal Joel's rfUserId from the registry
    const result = findEligibleJob({
      jobs: [{
        job_id: 1,
        stage_name: 'Sourced',
        stage_moved: '2026-03-30T15:08:04+0000',
        stages: [{ id: 100, name: 'Call Booked' }],
      }],
    });
    expect(result.userId).toBe(joel.rfUserId);
  });
});

// ---------------------------------------------------------------------------
// findJobsForStageMove tests (generalised stage-move filter)
// ---------------------------------------------------------------------------

describe('findJobsForStageMove', () => {
  function buildCandidate(jobs) {
    return { id: 49503, first_name: 'Steve', last_name: 'Xu', jobs };
  }

  function buildJob(overrides = {}) {
    return {
      job_id: 977,
      is_open: true,
      stage_name: 'Sourced',
      stages: [
        { id: 17934, name: 'Sourced', rank: 1 },
        { id: 17935, name: 'Applied', rank: 2 },
        { id: 17936, name: 'Replied', rank: 3 },
      ],
      ...overrides,
    };
  }

  const COLD_CALL_FILTERS = {
    currentStage: 'Sourced',
    targetStage: 'Replied',
  };

  it('returns empty array when candidate has no jobs', () => {
    expect(findJobsForStageMove(buildCandidate([]), COLD_CALL_FILTERS)).toEqual([]);
  });

  it('returns empty array for null candidate', () => {
    expect(findJobsForStageMove(null, COLD_CALL_FILTERS)).toEqual([]);
  });

  it('returns empty array when filters are missing required fields', () => {
    expect(findJobsForStageMove(buildCandidate([buildJob()]), {})).toEqual([]);
    expect(findJobsForStageMove(buildCandidate([buildJob()]), { currentStage: 'Sourced' })).toEqual([]);
  });

  it('returns matching job with target stage info', () => {
    const result = findJobsForStageMove(buildCandidate([buildJob()]), COLD_CALL_FILTERS);
    expect(result).toEqual([{ job_id: 977, targetStage: { id: 17936, name: 'Replied' } }]);
  });

  it('excludes closed jobs by default', () => {
    const result = findJobsForStageMove(buildCandidate([buildJob({ is_open: false })]), COLD_CALL_FILTERS);
    expect(result).toEqual([]);
  });

  it('includes closed jobs when openOnly=false', () => {
    const candidate = buildCandidate([buildJob({ is_open: false })]);
    const result = findJobsForStageMove(candidate, { ...COLD_CALL_FILTERS, openOnly: false });
    expect(result).toHaveLength(1);
  });

  it('excludes jobs not in the requested currentStage', () => {
    const result = findJobsForStageMove(buildCandidate([buildJob({ stage_name: 'Replied' })]), COLD_CALL_FILTERS);
    expect(result).toEqual([]);
  });

  it('excludes jobs that do not have the targetStage available', () => {
    const job = buildJob({ stages: [{ id: 17934, name: 'Sourced', rank: 1 }] });
    const result = findJobsForStageMove(buildCandidate([job]), COLD_CALL_FILTERS);
    expect(result).toEqual([]);
  });

  it('only considers jobs[0] — returns it when eligible', () => {
    const candidate = buildCandidate([
      buildJob({ job_id: 1 }),
      buildJob({ job_id: 2 }),
    ]);
    const result = findJobsForStageMove(candidate, COLD_CALL_FILTERS);
    expect(result).toHaveLength(1);
    expect(result[0].job_id).toBe(1);
  });

  it('only considers jobs[0] — does NOT fall through to a later eligible job when jobs[0] is wrong stage', () => {
    const candidate = buildCandidate([
      buildJob({ job_id: 1, stage_name: 'Replied' }), // ineligible (already past Sourced)
      buildJob({ job_id: 2 }),                         // eligible but at index 1 — must NOT be picked
    ]);
    const result = findJobsForStageMove(candidate, COLD_CALL_FILTERS);
    expect(result).toEqual([]);
  });

  it('only considers jobs[0] — does NOT fall through when jobs[0] is closed', () => {
    const candidate = buildCandidate([
      buildJob({ job_id: 1, is_open: false }),
      buildJob({ job_id: 2 }),
    ]);
    const result = findJobsForStageMove(candidate, COLD_CALL_FILTERS);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Apollo API client tests
// ---------------------------------------------------------------------------

describe('enrichPerson', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockEnv = { APOLLO_API_KEY: 'test-apollo-key' };

  it('calls correct URL with correct headers and body', async () => {
    const personData = { id: '123', first_name: 'Jane', last_name: 'Doe' };
    globalThis.fetch = async (url, opts) => {
      expect(url).toBe('https://api.apollo.io/api/v1/people/match');
      expect(opts.method).toBe('POST');
      expect(opts.headers['x-api-key']).toBe('test-apollo-key');
      expect(opts.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body);
      expect(body.linkedin_url).toBe('https://linkedin.com/in/janedoe');
      return new Response(JSON.stringify({ person: personData }), { status: 200 });
    };

    const result = await enrichPerson({ linkedin_url: 'https://linkedin.com/in/janedoe' }, {}, mockEnv);
    expect(result).toEqual(personData);
  });

  it('returns person object on success', async () => {
    const personData = { id: '456', first_name: 'John', last_name: 'Smith' };
    globalThis.fetch = async () => new Response(JSON.stringify({ person: personData }), { status: 200 });

    const result = await enrichPerson({ first_name: 'John', last_name: 'Smith' }, {}, mockEnv);
    expect(result).toEqual(personData);
  });

  it('returns null when Apollo returns no person', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });

    const result = await enrichPerson({ linkedin_url: 'https://linkedin.com/in/nobody' }, {}, mockEnv);
    expect(result).toBeNull();
  });

  it('passes reveal_phone_number and webhook_url when provided', async () => {
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.reveal_phone_number).toBe(true);
      expect(body.webhook_url).toBe('https://example.com/webhook');
      expect(body.first_name).toBe('Jane');
      return new Response(JSON.stringify({ person: { id: '789' } }), { status: 200 });
    };

    const result = await enrichPerson(
      { first_name: 'Jane' },
      { reveal_phone_number: true, webhook_url: 'https://example.com/webhook' },
      mockEnv
    );
    expect(result).toEqual({ id: '789' });
  });

  it('returns null on non-200 response', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });

    const result = await enrichPerson({ linkedin_url: 'https://linkedin.com/in/test' }, {}, mockEnv);
    expect(result).toBeNull();
  });
});

describe('searchPeople', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockEnv = { APOLLO_API_KEY: 'test-apollo-key' };

  it('calls correct URL and returns people array', async () => {
    const people = [{ id: '1', first_name: 'Alice' }, { id: '2', first_name: 'Bob' }];
    globalThis.fetch = async (url, opts) => {
      expect(url).toBe('https://api.apollo.io/api/v1/mixed_people/api_search');
      expect(opts.method).toBe('POST');
      expect(opts.headers['x-api-key']).toBe('test-apollo-key');
      const body = JSON.parse(opts.body);
      expect(body.page).toBe(1);
      expect(body.per_page).toBe(25);
      expect(body.q_keywords).toBe('engineer');
      return new Response(JSON.stringify({ people }), { status: 200 });
    };

    const result = await searchPeople({ q_keywords: 'engineer' }, mockEnv);
    expect(result).toEqual(people);
  });

  it('returns empty array on API failure', async () => {
    globalThis.fetch = async () => new Response('Server Error', { status: 500 });

    const result = await searchPeople({ q_keywords: 'test' }, mockEnv);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeOrgName tests
// ---------------------------------------------------------------------------

describe('normalizeOrgName', () => {
	it('lowercases and trims', () => {
		expect(normalizeOrgName('  Acme Corp  ')).toBe('acme');
	});

	it('strips Inc suffix', () => {
		expect(normalizeOrgName('Acme Inc')).toBe('acme');
	});

	it('strips Inc. suffix with dot', () => {
		expect(normalizeOrgName('Acme Inc.')).toBe('acme');
	});

	it('strips Ltd suffix', () => {
		expect(normalizeOrgName('Acme Ltd')).toBe('acme');
	});

	it('strips LLC suffix', () => {
		expect(normalizeOrgName('Acme LLC')).toBe('acme');
	});

	it('strips Corp suffix', () => {
		expect(normalizeOrgName('Acme Corp')).toBe('acme');
	});

	it('strips Corp. suffix', () => {
		expect(normalizeOrgName('Acme Corp.')).toBe('acme');
	});

	it('strips Co. suffix', () => {
		expect(normalizeOrgName('Acme Co.')).toBe('acme');
	});

	it('strips suffix with comma before it', () => {
		expect(normalizeOrgName('Acme, Inc.')).toBe('acme');
	});

	it('returns empty string for null', () => {
		expect(normalizeOrgName(null)).toBe('');
	});

	it('returns empty string for undefined', () => {
		expect(normalizeOrgName(undefined)).toBe('');
	});

	it('returns empty string for empty string', () => {
		expect(normalizeOrgName('')).toBe('');
	});

	it('returns empty string when name is just a suffix', () => {
		expect(normalizeOrgName('LLC')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// verifyApolloMatch tests
// ---------------------------------------------------------------------------

describe('verifyApolloMatch', () => {
	it('returns match when both name and org match', () => {
		const apollo = { first_name: 'Jane', last_name: 'Doe', organization: { name: 'Acme Inc' } };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
		expect(result.reasons).toEqual([]);
	});

	it('matches case-insensitively', () => {
		const apollo = { first_name: 'JANE', last_name: 'DOE', organization: { name: 'ACME' } };
		const rf = { first_name: 'jane', last_name: 'doe', current_organization: 'acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('skips last name comparison when RF last name is single char', () => {
		const apollo = { first_name: 'Andrew', last_name: 'Chen', organization: { name: 'Acme' } };
		const rf = { first_name: 'Andrew', last_name: 'C', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('skips last name comparison when RF last name is single char with dot', () => {
		const apollo = { first_name: 'Andrew', last_name: 'Chen', organization: { name: 'Acme' } };
		const rf = { first_name: 'Andrew', last_name: 'C.', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('reports first name mismatch', () => {
		const apollo = { first_name: 'John', last_name: 'Doe', organization: { name: 'Acme' } };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(false);
		expect(result.reasons.length).toBeGreaterThan(0);
		expect(result.reasons[0]).toContain('First name mismatch');
	});

	it('reports org mismatch', () => {
		const apollo = { first_name: 'Jane', last_name: 'Doe', organization: { name: 'BigCorp' } };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(false);
		expect(result.reasons.some(r => r.includes('Organization mismatch'))).toBe(true);
	});

	it('reports last name mismatch when not single char', () => {
		const apollo = { first_name: 'Jane', last_name: 'Smith', organization: { name: 'Acme' } };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(false);
		expect(result.reasons.some(r => r.includes('Last name mismatch'))).toBe(true);
	});

	it('matches when org suffixes differ', () => {
		const apollo = { first_name: 'Jane', last_name: 'Doe', organization: { name: 'Acme, Inc.' } };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme LLC' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('handles null Apollo organization gracefully', () => {
		const apollo = { first_name: 'Jane', last_name: 'Doe', organization: null };
		const rf = { first_name: 'Jane', last_name: 'Doe', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(false);
		expect(result.reasons.some(r => r.includes('Organization mismatch'))).toBe(true);
	});

	it('matches when RF last name has a middle initial prefix', () => {
		const apollo = { first_name: 'Juan', last_name: 'Romero', organization: { name: 'Acme' } };
		const rf = { first_name: 'Juan', last_name: 'N. Romero', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('matches when Apollo last name has a middle initial prefix', () => {
		const apollo = { first_name: 'Juan', last_name: 'N. Romero', organization: { name: 'Acme' } };
		const rf = { first_name: 'Juan', last_name: 'Romero', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});

	it('matches when RF last name has middle initial without dot', () => {
		const apollo = { first_name: 'Juan', last_name: 'Romero', organization: { name: 'Acme' } };
		const rf = { first_name: 'Juan', last_name: 'N Romero', current_organization: 'Acme' };
		const result = verifyApolloMatch(apollo, rf);
		expect(result.match).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// filterSearchResults tests
// ---------------------------------------------------------------------------

describe('filterSearchResults', () => {
	it('filters by first name match', () => {
		const results = [
			{ first_name: 'Jane', last_name_obfuscated: 'Do*' },
			{ first_name: 'John', last_name_obfuscated: 'Do*' },
			{ first_name: 'Jane', last_name_obfuscated: 'Sm***' },
		];
		const rfCandidate = { first_name: 'Jane', last_name: 'Doe' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(2);
		expect(filtered.every(r => r.first_name === 'Jane')).toBe(true);
	});

	it('filters by last_name_obfuscated first letter for single-char last name', () => {
		const results = [
			{ first_name: 'Max', last_name_obfuscated: 'Te***' },
			{ first_name: 'Max', last_name_obfuscated: 'Sm***' },
			{ first_name: 'Max', last_name_obfuscated: 'Th****' },
		];
		const rfCandidate = { first_name: 'Max', last_name: 'T' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(2);
		expect(filtered[0].last_name_obfuscated).toBe('Te***');
		expect(filtered[1].last_name_obfuscated).toBe('Th****');
	});

	it('handles single-char last name with dot (e.g. "T.")', () => {
		const results = [
			{ first_name: 'Max', last_name_obfuscated: 'Te***' },
			{ first_name: 'Max', last_name_obfuscated: 'Sm***' },
		];
		const rfCandidate = { first_name: 'Max', last_name: 'T.' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].last_name_obfuscated).toBe('Te***');
	});

	it('does NOT filter by obfuscated last name for full last names', () => {
		const results = [
			{ first_name: 'Jane', last_name_obfuscated: 'Sm***' },
			{ first_name: 'Jane', last_name_obfuscated: 'Do*' },
		];
		const rfCandidate = { first_name: 'Jane', last_name: 'Doe' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(2);
	});

	it('caps results at 5', () => {
		const results = Array.from({ length: 10 }, (_, i) => ({
			first_name: 'Jane',
			last_name_obfuscated: `Name${i}`,
		}));
		const rfCandidate = { first_name: 'Jane', last_name: 'Doe' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(5);
	});

	it('returns empty array for null/empty input', () => {
		expect(filterSearchResults(null, { first_name: 'Jane' })).toEqual([]);
		expect(filterSearchResults([], { first_name: 'Jane' })).toEqual([]);
	});

	it('trims whitespace from names', () => {
		const results = [{ first_name: '  Jane  ', last_name_obfuscated: 'Do*' }];
		const rfCandidate = { first_name: ' Jane', last_name: 'Doe' };
		const filtered = filterSearchResults(results, rfCandidate);
		expect(filtered).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// scoreEnrichedCandidate tests
// ---------------------------------------------------------------------------

describe('scoreEnrichedCandidate', () => {
	const baseApollo = {
		first_name: 'Jane',
		last_name: 'Doe',
		title: 'Software Engineer',
		organization: { name: 'Acme Inc' },
		state: 'Massachusetts',
		city: 'Boston',
		country: 'United States',
		employment_history: [],
	};

	const baseRF = {
		first_name: 'Jane',
		last_name: 'Doe',
		current_designation: 'Software Engineer',
		current_organization: 'Acme Inc',
		location: { state: 'Massachusetts', city: 'Boston', country: 'United States' },
		education: [{ school: 'MIT' }],
	};

	it('passes all gates and scores full confidence with matching data', () => {
		const apollo = { ...baseApollo, employment_history: [{ degree: 'BS', organization_name: 'MIT' }] };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(true);
		expect(result.confidence).toBe(100);
		expect(result.gateFailures).toEqual([]);
	});

	it('fails first_name gate on mismatch', () => {
		const apollo = { ...baseApollo, first_name: 'John' };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(false);
		expect(result.gateFailures).toContain('first_name');
	});

	it('fails organization gate on mismatch', () => {
		const apollo = { ...baseApollo, organization: { name: 'OtherCo' } };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(false);
		expect(result.gateFailures).toContain('organization');
	});

	it('fails last_name gate for full last names on mismatch', () => {
		const apollo = { ...baseApollo, last_name: 'Smith' };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(false);
		expect(result.gateFailures).toContain('last_name');
	});

	it('skips last_name gate for single-char last names', () => {
		const apollo = { ...baseApollo, last_name: 'Donovan' };
		const rf = { ...baseRF, last_name: 'D' };
		const result = scoreEnrichedCandidate(apollo, rf);
		expect(result.passed).toBe(true);
		expect(result.gateFailures).not.toContain('last_name');
	});

	it('normalizes org names with different suffixes', () => {
		const apollo = { ...baseApollo, organization: { name: 'Acme, Inc.' } };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(true);
	});

	it('scores title match (30 points)', () => {
		const rf = { ...baseRF, location: null, education: [] };
		const result = scoreEnrichedCandidate(baseApollo, rf);
		expect(result.passed).toBe(true);
		expect(result.matches).toContain('title');
		expect(result.score).toBe(30);
	});

	it('scores location fields independently', () => {
		const apollo = { ...baseApollo, title: 'Other Title', state: 'Massachusetts', city: 'Springfield', country: 'United States' };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(true);
		expect(result.matches).toContain('state');
		expect(result.matches).toContain('country');
		expect(result.mismatches).toContain('city');
		expect(result.mismatches).toContain('title');
	});

	it('scores education match via employment_history', () => {
		const apollo = { ...baseApollo, title: 'Other', employment_history: [{ degree: 'MS', organization_name: 'MIT' }] };
		const result = scoreEnrichedCandidate(apollo, baseRF);
		expect(result.passed).toBe(true);
		expect(result.matches).toContain('education');
	});

	it('scores 0% confidence when titles mismatch and no other signals', () => {
		const rf = { ...baseRF, current_designation: '', location: null, education: [] };
		const apollo = { ...baseApollo, title: '' };
		const result = scoreEnrichedCandidate(apollo, rf);
		expect(result.passed).toBe(true);
		expect(result.confidence).toBe(0);
		expect(result.maxPossible).toBe(30);
		expect(result.mismatches).toContain('title');
	});

	it('trims whitespace from all compared fields', () => {
		const apollo = { ...baseApollo, first_name: '  Jane  ', last_name: ' Doe ', organization: { name: '  Acme Inc  ' } };
		const rf = { ...baseRF, first_name: ' Jane', last_name: ' Doe' };
		const result = scoreEnrichedCandidate(apollo, rf);
		expect(result.passed).toBe(true);
	});

	it('passes last_name gate when RF has middle initial prefix', () => {
		const apollo = { ...baseApollo, first_name: 'Juan', last_name: 'Romero' };
		const rf = { ...baseRF, first_name: 'Juan', last_name: 'N. Romero' };
		const result = scoreEnrichedCandidate(apollo, rf);
		expect(result.passed).toBe(true);
		expect(result.gateFailures).not.toContain('last_name');
	});
});

// ---------------------------------------------------------------------------
// isJoelCandidate tests
// ---------------------------------------------------------------------------

describe('isJoelCandidate', () => {
	it('returns true when a job has added_to_job_by.id === 900001', () => {
		const candidate = {
			id: 100,
			jobs: [{ job_id: 1, added_to_job_by: { id: 900001, name: 'Joel Haines' } }],
		};
		expect(isJoelCandidate(candidate)).toBe(true);
	});

	it('returns false when jobs added by someone else', () => {
		const candidate = {
			id: 101,
			jobs: [{ job_id: 1, added_to_job_by: { id: 900003, name: 'Bob Smith' } }],
		};
		expect(isJoelCandidate(candidate)).toBe(false);
	});

	it('returns true when ANY job (not just first) is Joel\'s', () => {
		const candidate = {
			id: 102,
			jobs: [
				{ job_id: 1, added_to_job_by: { id: 900003, name: 'Bob Smith' } },
				{ job_id: 2, added_to_job_by: { id: 900001, name: 'Joel Haines' } },
			],
		};
		expect(isJoelCandidate(candidate)).toBe(true);
	});

	it('returns false for empty jobs array', () => {
		const candidate = { id: 103, jobs: [] };
		expect(isJoelCandidate(candidate)).toBe(false);
	});

	it('returns false when jobs is undefined', () => {
		const candidate = { id: 104 };
		expect(isJoelCandidate(candidate)).toBe(false);
	});

	it('handles null added_to_job_by', () => {
		const candidate = {
			id: 105,
			jobs: [{ job_id: 1, added_to_job_by: null }],
		};
		expect(isJoelCandidate(candidate)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// enrichCandidate tests
// ---------------------------------------------------------------------------

describe('enrichCandidate', () => {
	function mockEnv(overrides = {}) {
		const kvStore = {};
		return {
			APOLLO_API_KEY: 'test-key',
			APOLLO_WEBHOOK_SECRET: 'test-secret',
			RF_API_KEY: 'test-rf-key',
			RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external',
			SYNC_STATE: {
				get: async (key) => kvStore[key] || null,
				put: async (key, value, opts) => { kvStore[key] = value; },
			},
			WORKER_URL: 'https://rf-dialpad-sync-dev.example-account.workers.dev',
			...overrides,
		};
	}

	it('skips when phone already exists (string)', async () => {
		const env = mockEnv();
		const candidate = { id: 100, phone_number: '+61412345678', linkedin_profile: 'https://linkedin.com/in/test' };
		const fullCandidate = { id: 100, phone_number: [] };
		const result = await enrichCandidate(candidate, fullCandidate, env);
		expect(result.enriched).toBe(false);
		expect(result.reason).toBe('phone_exists');
	});

	it('skips when phone already exists (array on fullCandidate)', async () => {
		const env = mockEnv();
		const candidate = { id: 101, phone_number: '', linkedin_profile: 'https://linkedin.com/in/test' };
		const fullCandidate = { id: 101, phone_number: [{ phone_number: '+61412345678', type: 1 }] };
		const result = await enrichCandidate(candidate, fullCandidate, env);
		expect(result.enriched).toBe(false);
		expect(result.reason).toBe('phone_exists');
	});

	it('skips when apollo_enrich KV key already exists (dedup)', async () => {
		const kvStore = { 'apollo_enrich:102': '{"apolloPersonId":"x"}' };
		const env = mockEnv({
			SYNC_STATE: {
				get: async (key) => kvStore[key] || null,
				put: async () => {},
			},
		});
		const candidate = { id: 102, phone_number: '', linkedin_profile: 'https://linkedin.com/in/test' };
		const fullCandidate = { id: 102, phone_number: [] };
		const result = await enrichCandidate(candidate, fullCandidate, env);
		expect(result.enriched).toBe(false);
		expect(result.reason).toBe('already_attempted');
	});
});

// ---------------------------------------------------------------------------
// Apollo webhook handler auth tests
// ---------------------------------------------------------------------------

describe('Apollo webhook handler', () => {
	it('returns 401 without token query param', async () => {
		const request = new Request('http://example.com/webhook/apollo', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 401 with wrong token', async () => {
		const request = new Request('http://example.com/webhook/apollo?token=wrong', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 400 when rfId is missing from query params', async () => {
		const request = new Request(
			`http://example.com/webhook/apollo?token=${env.APOLLO_WEBHOOK_SECRET}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			}
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});

describe('cacheConsultantForJobLink / getCachedConsultantForJobLink', () => {
	it('writes a numeric consultant ID and reads it back as a number', async () => {
		const { cacheConsultantForJobLink, getCachedConsultantForJobLink } = await import('../src/cache.js');
		await cacheConsultantForJobLink(50000, 999, 900001, env);
		const result = await getCachedConsultantForJobLink(50000, 999, env);
		expect(result).toBe(900001);
	});

	it('writes a "none" sentinel and reads it back as the string "none"', async () => {
		const { cacheConsultantForJobLink, getCachedConsultantForJobLink } = await import('../src/cache.js');
		await cacheConsultantForJobLink(50001, 999, null, env);
		const result = await getCachedConsultantForJobLink(50001, 999, env);
		expect(result).toBe('none');
	});

	it('treats undefined input as the "none" sentinel', async () => {
		const { cacheConsultantForJobLink, getCachedConsultantForJobLink } = await import('../src/cache.js');
		await cacheConsultantForJobLink(50002, 999, undefined, env);
		const result = await getCachedConsultantForJobLink(50002, 999, env);
		expect(result).toBe('none');
	});

	it('returns null when no entry exists', async () => {
		const { getCachedConsultantForJobLink } = await import('../src/cache.js');
		const result = await getCachedConsultantForJobLink(99999, 99999, env);
		expect(result).toBeNull();
	});
});

describe('setJobCandidateConsultantId', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	const testEnv = { RF_API_KEY: 'test-rf-key', RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external' };

	it('POSTs to /job-candidate/custom-field/value/update with custom field id 16', async () => {
		const { setJobCandidateConsultantId } = await import('../src/rf-client.js');
		let captured;
		globalThis.fetch = async (url, opts) => {
			captured = { url: typeof url === 'string' ? url : url.toString(), body: JSON.parse(opts.body) };
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		};
		await setJobCandidateConsultantId(50000, 999, 900001, testEnv);
		expect(captured.url).toContain('/job-candidate/custom-field/value/update');
		expect(captured.body).toEqual({
			candidate_id: 50000,
			job_id: 999,
			custom_fields: [{ id: 16, value: 900001 }],
		});
	});

	it('throws on non-2xx response', async () => {
		const { setJobCandidateConsultantId } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response('boom', { status: 500 });
		await expect(setJobCandidateConsultantId(50000, 999, 900001, testEnv)).rejects.toThrow(/RF API error: 500/);
	});
});

describe('convertDialpadContactToRFUpdate — removal sync', () => {
	it('omits phone_number when Dialpad phones is empty', () => {
		const contact = { phones: [], emails: ['test@example.com'], primary_email: 'test@example.com', urls: [] };
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result.phone_number).toBeUndefined();
	});

	it('omits email when Dialpad emails is empty', () => {
		const contact = { phones: ['+14155551234'], emails: [], urls: [] };
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result.email).toBeUndefined();
	});

	it('omits linkedin when Dialpad urls is empty', () => {
		const contact = { phones: [], emails: [], urls: [] };
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result.linkedin_profile).toBeUndefined();
	});

	it('still maps phone numbers correctly when present', () => {
		const contact = { phones: ['+14155551234'], emails: [], urls: [] };
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result.phone_number).toEqual([{ phone_number: '+14155551234', type: 1 }]);
	});

	it('still maps emails correctly when present', () => {
		const contact = { phones: [], emails: ['test@example.com'], primary_email: 'test@example.com', urls: [] };
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result.email).toEqual([{ email: 'test@example.com', is_primary: 1 }]);
	});

	it('does not include fields when property is undefined', () => {
		const contact = {};
		const result = convertDialpadContactToRFUpdate(contact);
		expect(result).toEqual({});
	});
});

describe('getJobCandidateConsultantId', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	const testEnv = { RF_API_KEY: 'test-rf-key', RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external' };

	it('returns the numeric value when custom field id 16 is set', async () => {
		const { getJobCandidateConsultantId } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response(JSON.stringify({
			data: [
				{ id: 102, name: 'Willing to relocate?', value: 'Yes' },
				{ id: 16, name: 'consultant_id', value: 900001 },
			],
		}), { status: 200 });
		expect(await getJobCandidateConsultantId(50000, 999, testEnv)).toBe(900001);
	});

	it('returns null when field id 16 is absent', async () => {
		const { getJobCandidateConsultantId } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response(JSON.stringify({
			data: [{ id: 102, name: 'Other', value: 'whatever' }],
		}), { status: 200 });
		expect(await getJobCandidateConsultantId(50000, 999, testEnv)).toBeNull();
	});

	it('returns null when data is empty', async () => {
		const { getJobCandidateConsultantId } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
		expect(await getJobCandidateConsultantId(50000, 999, testEnv)).toBeNull();
	});

	it('throws on non-2xx response', async () => {
		const { getJobCandidateConsultantId } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response('boom', { status: 500 });
		await expect(getJobCandidateConsultantId(50000, 999, testEnv)).rejects.toThrow(/RF API error: 500/);
	});
});

describe('resolveJobConsultantId', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns the cached numeric value without hitting RF', async () => {
		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		const { resolveJobConsultantId } = await import('../src/rf-client.js');
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		await cacheConsultantForJobLink(60001, 800, 900001, env);
		let fetchCount = 0;
		globalThis.fetch = async () => { fetchCount++; return new Response('{}', { status: 200 }); };
		expect(await resolveJobConsultantId(60001, 800, testEnv)).toBe(900001);
		expect(fetchCount).toBe(0);
	});

	it('returns null when cache holds the "none" sentinel — no RF call', async () => {
		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		const { resolveJobConsultantId } = await import('../src/rf-client.js');
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		await cacheConsultantForJobLink(60002, 800, null, env);
		let fetchCount = 0;
		globalThis.fetch = async () => { fetchCount++; return new Response('{}', { status: 200 }); };
		expect(await resolveJobConsultantId(60002, 800, testEnv)).toBeNull();
		expect(fetchCount).toBe(0);
	});

	it('falls back to RF on cache miss, caches the result, and returns the value', async () => {
		const { resolveJobConsultantId } = await import('../src/rf-client.js');
		const { getCachedConsultantForJobLink } = await import('../src/cache.js');
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		globalThis.fetch = async () => new Response(JSON.stringify({
			data: [{ id: 16, name: 'consultant_id', value: 900002 }],
		}), { status: 200 });
		expect(await resolveJobConsultantId(60003, 800, testEnv)).toBe(900002);
		// And the value got cached
		expect(await getCachedConsultantForJobLink(60003, 800, env)).toBe(900002);
	});

	it('caches the "none" sentinel when RF returns no consultant_id', async () => {
		const { resolveJobConsultantId } = await import('../src/rf-client.js');
		const { getCachedConsultantForJobLink } = await import('../src/cache.js');
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
		expect(await resolveJobConsultantId(60004, 800, testEnv)).toBeNull();
		expect(await getCachedConsultantForJobLink(60004, 800, env)).toBe('none');
	});
});

describe('listCandidateActivities', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('GETs /candidate/activity/list with id query param and returns data array', async () => {
		const { listCandidateActivities } = await import('../src/rf-client.js');
		let captured;
		globalThis.fetch = async (url) => {
			captured = typeof url === 'string' ? url : url.toString();
			return new Response(JSON.stringify({
				data: [
					{ activity_id: 1, type: { id: 1002, name: 'Cold Call' }, time: '2026-04-29T19:49:38+01:00', text: 'foo' },
				],
				total_items: 1,
			}), { status: 200 });
		};
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		const result = await listCandidateActivities(50615, testEnv);
		expect(captured).toContain('/candidate/activity/list');
		expect(captured).toContain('id=50615');
		expect(captured).toContain('items_per_page=50');
		expect(captured).toContain('current_page=1');
		expect(result).toHaveLength(1);
		expect(result[0].activity_id).toBe(1);
	});

	it('returns [] when data is missing', async () => {
		const { listCandidateActivities } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		expect(await listCandidateActivities(50615, testEnv)).toEqual([]);
	});

	it('throws on non-2xx', async () => {
		const { listCandidateActivities } = await import('../src/rf-client.js');
		globalThis.fetch = async () => new Response('nope', { status: 500 });
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		await expect(listCandidateActivities(50615, testEnv)).rejects.toThrow(/RF API error: 500/);
	});
});

describe('normalizeToE164', () => {
	it('passes through a valid E.164 string', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('+15551234567')).toBe('+15551234567');
		expect(normalizeToE164('+447911123456')).toBe('+447911123456');
	});

	it('strips formatting around an E.164 number', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('+1 (555) 123-4567')).toBe('+15551234567');
	});

	it('prepends +1 to a 10-digit US number', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('5551234567')).toBe('+15551234567');
		expect(normalizeToE164('(555) 123-4567')).toBe('+15551234567');
	});

	it('prepends + to an 11-digit number starting with 1', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('15551234567')).toBe('+15551234567');
	});

	it('returns null for too short', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('123')).toBeNull();
	});

	it('returns null for too long', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('+1234567890123456')).toBeNull();
	});

	it('returns null for empty / null / non-string', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('')).toBeNull();
		expect(normalizeToE164(null)).toBeNull();
		expect(normalizeToE164(undefined)).toBeNull();
		expect(normalizeToE164(123)).toBeNull();
	});

	it('returns null for a string with no digits', async () => {
		const { normalizeToE164 } = await import('../src/rf-client.js');
		expect(normalizeToE164('not a number')).toBeNull();
	});
});

describe('addRFCandidate lead_owner_id', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('does NOT include lead_owner_id when caller does not provide one', async () => {
		const { addRFCandidate } = await import('../src/rf-client.js');
		let captured;
		globalThis.fetch = async (url, opts) => {
			captured = JSON.parse(opts.body);
			return new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 });
		};
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		await addRFCandidate({ name: 'Test', linkedin_profile: 'foo' }, testEnv);
		expect(captured).not.toHaveProperty('lead_owner_id');
	});

	it('includes lead_owner_id verbatim when the caller passes one', async () => {
		const { addRFCandidate } = await import('../src/rf-client.js');
		let captured;
		globalThis.fetch = async (url, opts) => {
			captured = JSON.parse(opts.body);
			return new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 });
		};
		const testEnv = { ...env, RF_API_KEY: 'test-rf-key' };
		await addRFCandidate({ name: 'Test', linkedin_profile: 'foo', lead_owner_id: 900001 }, testEnv);
		expect(captured.lead_owner_id).toBe(900001);
	});
});

describe('parseColdCallActivity', () => {
	it('extracts outcome=connected and the body for a connected_positive call', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		const activity = {
			activity_id: 9912,
			time: '2026-04-29T19:49:38+01:00',
			text: 'Cold call with Lucas Ralph — Connected (Positive)<br>\n<br>\nNext steps:<br>\n• Joel will send information.<br>\n• Lucas can reach out.',
		};
		expect(parseColdCallActivity(activity)).toEqual({
			id: 9912,
			type: 'cold_call',
			name: 'Cold call',
			description: 'Next steps:\n• Joel will send information.\n• Lucas can reach out.',
			createdAt: new Date('2026-04-29T19:49:38+01:00').toISOString(),
			outcome: 'connected',
		});
	});

	it('extracts outcome=connected and Notes body for a connected_negative call', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		const activity = {
			activity_id: 9913,
			time: '2026-04-29T19:49:38+01:00',
			text: 'Cold call with Foo — Connected (Negative)<br>\n<br>\nNotes:<br>\n• Just joined a new role.',
		};
		const result = parseColdCallActivity(activity);
		expect(result.outcome).toBe('connected');
		expect(result.description).toBe('Notes:\n• Just joined a new role.');
	});

	it('extracts outcome=voicemail and empty description for a voicemail', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		const activity = {
			activity_id: 9821,
			time: '2026-04-22T14:33:00+00:00',
			text: 'Cold call with Foo — Voicemail',
		};
		const result = parseColdCallActivity(activity);
		expect(result.outcome).toBe('voicemail');
		expect(result.description).toBe('');
	});

	it('returns outcome=null and empty description for a no-outcome legacy entry', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		const activity = {
			activity_id: 9000,
			time: '2026-01-01T00:00:00+00:00',
			text: 'Cold call with Legacy User',
		};
		const result = parseColdCallActivity(activity);
		expect(result.outcome).toBeNull();
		expect(result.description).toBe('');
	});

	it('normalizes time to UTC ISO 8601', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		const result = parseColdCallActivity({
			activity_id: 1, time: '2026-04-29T19:49:38+01:00', text: 'Cold call with X — Voicemail',
		});
		// 19:49:38 +01:00 = 18:49:38 UTC
		expect(result.createdAt).toBe('2026-04-29T18:49:38.000Z');
	});

	it('returns createdAt=null for invalid or missing time', async () => {
		const { parseColdCallActivity } = await import('../src/cold-call.js');
		expect(parseColdCallActivity({ activity_id: 1, time: 'not a date', text: 'x' }).createdAt).toBeNull();
		expect(parseColdCallActivity({ activity_id: 2, time: undefined, text: 'x' }).createdAt).toBeNull();
	});
});

describe('pickConsultantJob', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns null when candidate has no jobs', async () => {
		const { pickConsultantJob } = await import('../src/rf-client.js');
		expect(await pickConsultantJob({ jobs: [] }, 900001, env)).toBeNull();
	});

	it('returns null when candidate has only closed jobs', async () => {
		const { pickConsultantJob } = await import('../src/rf-client.js');
		const candidate = { jobs: [{ job_id: 1, is_open: false, stage_name: 'Sourced' }] };
		expect(await pickConsultantJob(candidate, 900001, env)).toBeNull();
	});

	it('returns the job whose cached consultant_id matches', async () => {
		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		const { pickConsultantJob } = await import('../src/rf-client.js');
		await cacheConsultantForJobLink(70001, 100, null, env);     // none
		await cacheConsultantForJobLink(70001, 200, 900001, env);   // Joel
		await cacheConsultantForJobLink(70001, 300, 900002, env);   // Alice

		const candidate = {
			id: 70001,
			jobs: [
				{ job_id: 100, is_open: true, stage_name: 'Sourced', stages: [], stage_moved: '2026-04-29T00:00:00Z' },
				{ job_id: 200, is_open: true, stage_name: 'Replied', stages: [], stage_moved: '2026-04-28T00:00:00Z' },
				{ job_id: 300, is_open: true, stage_name: 'Sourced', stages: [], stage_moved: '2026-04-27T00:00:00Z' },
			],
		};
		const result = await pickConsultantJob(candidate, 900001, env);
		expect(result.job_id).toBe(200);
	});

	it('falls back to jobs[0] when no job matches the consultant', async () => {
		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		const { pickConsultantJob } = await import('../src/rf-client.js');
		await cacheConsultantForJobLink(70002, 100, 900002, env);   // Alice's job
		await cacheConsultantForJobLink(70002, 200, null, env);     // none

		const candidate = {
			id: 70002,
			jobs: [
				{ job_id: 100, is_open: true, stage_name: 'Sourced', stage_moved: '2026-04-29T00:00:00Z' },
				{ job_id: 200, is_open: true, stage_name: 'Replied', stage_moved: '2026-04-28T00:00:00Z' },
			],
		};
		const result = await pickConsultantJob(candidate, 900001, env);
		expect(result.job_id).toBe(100); // jobs[0] (open)
	});

	it('falls back to jobs[0] only if jobs[0] is open', async () => {
		const { pickConsultantJob } = await import('../src/rf-client.js');
		const candidate = {
			id: 70003,
			jobs: [
				{ job_id: 100, is_open: false, stage_name: 'Sourced' },
				{ job_id: 200, is_open: true, stage_name: 'Sourced' },
			],
		};
		// jobs[0] is closed, no consultant match → null
		expect(await pickConsultantJob(candidate, 900001, env)).toBeNull();
	});

	it('returns null when consultantRfUserId is null and jobs[0] is closed', async () => {
		const { pickConsultantJob } = await import('../src/rf-client.js');
		const candidate = {
			id: 70004,
			jobs: [{ job_id: 100, is_open: false, stage_name: 'Sourced' }],
		};
		expect(await pickConsultantJob(candidate, null, env)).toBeNull();
	});

	it('returns jobs[0] when consultantRfUserId is null and jobs[0] is open (legacy fallback)', async () => {
		const { pickConsultantJob } = await import('../src/rf-client.js');
		const candidate = {
			id: 70005,
			jobs: [{ job_id: 100, is_open: true, stage_name: 'Sourced' }],
		};
		const result = await pickConsultantJob(candidate, null, env);
		expect(result.job_id).toBe(100);
	});
});
