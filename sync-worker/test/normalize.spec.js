import { describe, it, expect } from 'vitest';
import { toCandidateRow, toCandidateJobRows, toCandidateThinRow, toJobThinRow, toCallRow } from '../src/normalize.js';

const sample = {
  id: 42,
  first_name: 'Jerry', last_name: 'Smith', name: 'Jerry Smith',
  primary_email: 'jerry@example.com',
  emails: ['jerry@example.com'],
  phone_numbers: [{ phone_number: '+447700900000' }],
  linkedin_profile: 'https://www.linkedin.com/in/jerry-smith',
  current_title: 'Engineer', current_organization: 'Acme',
  added_time: '2026-01-01T00:00:00Z',
  last_updated: '2026-05-05T10:00:00Z',
  last_activity_at: '2026-05-04T00:00:00Z',
  lead_owner: { id: 900001 },
  custom_fields: [],
  // These should be excluded from body:
  activities: [{ id: 1 }],
  notes: [{ id: 2 }],
  experience: [{ company: 'Old Corp' }],
  education: [{ school: 'MIT' }],
  files: [{ name: 'cv.pdf' }],
  jobs: [
    {
      job_id: 100, job_name: 'Eng 1', stage_id: 5, stage_name: 'Sourced',
      stage_moved: '2026-05-04T00:00:00Z',
      added_to_job: '2026-05-01T00:00:00Z',
      added_to_job_by: { id: 900001 },
      disqualified: false,
    },
    {
      job_id: 101, job_name: 'Eng 2', stage_id: 9, stage_name: 'Hired',
      disqualified: true, disqualification_reason: 'Hired elsewhere',
    },
  ],
};

describe('normalize', () => {
  it('toCandidateRow extracts indexed columns + curated body', () => {
    const row = toCandidateRow(sample);
    expect(row.id).toBe(42);
    expect(row.name).toBe('Jerry Smith');
    expect(row.primary_email).toBe('jerry@example.com');
    expect(row.linkedin_profile).toBe('jerry-smith');
    expect(row.lead_owner_id).toBe(900001);
    expect(row.last_updated).toBe('2026-05-05T10:00:00Z');
    expect(row.current_organization).toBe('Acme');
    expect(row.current_title).toBe('Engineer');
    expect(row.added_time).toBe('2026-01-01T00:00:00Z');
    expect(row.last_activity_at).toBe('2026-05-04T00:00:00Z');
    expect(typeof row.cached_at).toBe('string');
    // body is valid JSON
    const body = JSON.parse(row.body);
    // heavy keys excluded
    expect(body.activities).toBeUndefined();
    expect(body.notes).toBeUndefined();
    expect(body.experience).toBeUndefined();
    expect(body.education).toBeUndefined();
    expect(body.files).toBeUndefined();
    // curated keys preserved
    expect(body.jobs.length).toBe(2);
    expect(body.emails).toEqual(['jerry@example.com']);
    expect(body.phone_numbers).toEqual([{ phone_number: '+447700900000' }]);
  });

  it('toCandidateJobRows produces one row per job', () => {
    const rows = toCandidateJobRows(sample);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      candidate_id: 42, job_id: 100, stage_name: 'Sourced',
      added_to_job_by_id: 900001, disqualified: 0,
    });
    expect(rows[1]).toMatchObject({
      candidate_id: 42, job_id: 101, stage_name: 'Hired',
      disqualified: 1, disqualification_reason: 'Hired elsewhere',
    });
  });

  it('linkedin slug normalisation strips protocol + trailing slash', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: 'http://www.linkedin.com/in/foo-bar/' });
    expect(row.linkedin_profile).toBe('foo-bar');
  });

  it('handles candidate with no jobs', () => {
    const rows = toCandidateJobRows({ ...sample, jobs: [] });
    expect(rows).toEqual([]);
  });

  // Edge cases
  it('handles missing jobs array (undefined)', () => {
    const rf = { ...sample };
    delete rf.jobs;
    const rows = toCandidateJobRows(rf);
    expect(rows).toEqual([]);
  });

  it('normalises pub linkedin URLs', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: 'https://www.linkedin.com/pub/jane-doe/12/345/678/' });
    expect(row.linkedin_profile).toBe('jane-doe');
  });

  it('returns null linkedin_profile when no URL provided', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: null });
    expect(row.linkedin_profile).toBeNull();
  });

  it('falls back to first_name + last_name when name is missing', () => {
    const row = toCandidateRow({ ...sample, name: undefined });
    expect(row.name).toBe('Jerry Smith');
  });

  it('returns null lead_owner_id when lead_owner is missing', () => {
    const row = toCandidateRow({ ...sample, lead_owner: undefined });
    expect(row.lead_owner_id).toBeNull();
  });

  it('lowercases primary_email', () => {
    const row = toCandidateRow({ ...sample, primary_email: 'Jerry@Example.COM' });
    expect(row.primary_email).toBe('jerry@example.com');
  });

  it('returns null primary_email when missing', () => {
    // Drop top-level primary_email and BOTH email array fallbacks (RF `email`, internal `emails`).
    const row = toCandidateRow({ ...sample, primary_email: undefined, email: undefined, emails: undefined });
    expect(row.primary_email).toBeNull();
  });

  it('derives primary_email from RF email array (string entries)', () => {
    const row = toCandidateRow({
      ...sample, primary_email: undefined,
      email: ['JERRY@example.com', 'alt@example.com'],
    });
    expect(row.primary_email).toBe('jerry@example.com');
  });

  it('derives primary_email from RF email array (object entries)', () => {
    const row = toCandidateRow({
      ...sample, primary_email: undefined,
      email: [{ email: 'Jerry@Example.com', type: 'work' }],
    });
    expect(row.primary_email).toBe('jerry@example.com');
  });

  it('aliases RF current_designation -> current_title', () => {
    const row = toCandidateRow({ ...sample, current_title: undefined, current_designation: 'Engineer' });
    expect(row.current_title).toBe('Engineer');
  });

  it('aliases RF latest_activity_time -> last_activity_at', () => {
    const row = toCandidateRow({ ...sample, last_activity_at: undefined, latest_activity_time: '2026-05-01T00:00:00Z' });
    expect(row.last_activity_at).toBe('2026-05-01T00:00:00Z');
  });

  it('mirrors RF phone_number -> phone_numbers in body', () => {
    const row = toCandidateRow({ ...sample, phone_numbers: undefined, phone_number: ['+1234567890'] });
    const body = JSON.parse(row.body);
    expect(body.phone_numbers).toEqual(['+1234567890']);
  });

  it('job row nulls missing optional fields', () => {
    const rf = {
      ...sample,
      jobs: [{ job_id: 200, disqualified: false }],
    };
    const rows = toCandidateJobRows(rf);
    expect(rows[0].stage_id).toBeNull();
    expect(rows[0].stage_name).toBeNull();
    expect(rows[0].stage_moved).toBeNull();
    expect(rows[0].added_to_job).toBeNull();
    expect(rows[0].added_to_job_by_id).toBeNull();
    expect(rows[0].disqualification_reason).toBeNull();
  });

  it('synthesises custom_fields_by_name from custom_fields array (lowercased keys)', () => {
    const row = toCandidateRow({
      ...sample,
      custom_fields: [
        { id: 1, name: 'Expected Compensation', value: '100k' },
        { id: 2, name: 'Tech Stack', value: ['Go', 'Postgres'] },
      ],
    });
    const body = JSON.parse(row.body);
    expect(body.custom_fields_by_name).toBeDefined();
    expect(body.custom_fields_by_name['expected compensation'].value).toBe('100k');
    expect(body.custom_fields_by_name['tech stack'].value).toEqual(['Go', 'Postgres']);
    expect(body.custom_fields_by_name['expected compensation'].id).toBe(1);
  });

  it('preserves existing custom_fields_by_name if already present (defensive)', () => {
    const row = toCandidateRow({
      ...sample,
      custom_fields: [{ id: 1, name: 'Foo', value: 'a' }],
      custom_fields_by_name: { foo: { name: 'Foo', value: 'b', id: 99 } },
    });
    const body = JSON.parse(row.body);
    expect(body.custom_fields_by_name.foo.value).toBe('b');
  });

  it('omits custom_fields_by_name when no custom_fields array', () => {
    const row = toCandidateRow({ ...sample, custom_fields: undefined });
    const body = JSON.parse(row.body);
    expect(body.custom_fields_by_name).toBeUndefined();
  });
});

describe('toCandidateThinRow', () => {
  it('extracts id, name, linkedin slug, added_time_ms, snapshot title/company', () => {
    const rf = {
      id: 12345,
      name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
      linkedin_profile: 'https://www.linkedin.com/in/jane-doe/',
      added_time: '2024-06-01T12:00:00+0000',
      current_title: 'Director of Engineering',
      current_organization: 'Acme Corp',
    };
    const row = toCandidateThinRow(rf);
    expect(row).toEqual({
      id: 12345,
      name: 'Jane Doe',
      linkedin_profile: 'jane-doe',
      added_time_ms: Date.parse('2024-06-01T12:00:00+0000'),
      current_title_at_cache_time: 'Director of Engineering',
      current_company_at_cache_time: 'Acme Corp',
      cached_at_ms: expect.any(Number),
    });
  });

  it('handles bare-slug linkedin_profile (RF /candidate/list shape)', () => {
    const row = toCandidateThinRow({
      id: 99,
      name: 'X',
      linkedin_profile: 'jane-doe',
      added_time: '2024-06-01T12:00:00+0000',
    });
    expect(row.linkedin_profile).toBe('jane-doe');
  });

  it('returns null linkedin_profile when not parseable', () => {
    const row = toCandidateThinRow({
      id: 99,
      name: 'X',
      linkedin_profile: 'None',
      added_time: '2024-06-01T12:00:00+0000',
    });
    expect(row.linkedin_profile).toBeNull();
  });

  it('falls back to first_name + last_name when name absent', () => {
    const row = toCandidateThinRow({
      id: 1,
      first_name: 'Jane',
      last_name: 'Doe',
      added_time: '2024-06-01T12:00:00+0000',
    });
    expect(row.name).toBe('Jane Doe');
  });

  it('throws on missing added_time (non-recoverable: cron must skip such rows upstream)', () => {
    expect(() => toCandidateThinRow({ id: 1, name: 'X' })).toThrow(/added_time/);
  });

  it('aliases RF current_designation -> current_title_at_cache_time', () => {
    const row = toCandidateThinRow({
      id: 1,
      name: 'X',
      current_designation: 'Engineer',
      added_time: '2024-06-01T12:00:00+0000',
    });
    expect(row.current_title_at_cache_time).toBe('Engineer');
  });
});

describe('toJobThinRow', () => {
  it('extracts id, name, company, added_time_ms', () => {
    const rf = {
      id: 42,
      name: 'Senior SWE',
      company: { id: 7, name: 'Acme Corp' },
      created_time: '2024-01-15T09:00:00+0000',
    };
    const row = toJobThinRow(rf);
    expect(row).toEqual({
      id: 42,
      name: 'Senior SWE',
      client_company_name: 'Acme Corp',
      added_time_ms: Date.parse('2024-01-15T09:00:00+0000'),
      canonical_pipeline_json: null,
      cached_at_ms: expect.any(Number),
    });
  });

  it('accepts client_company_name when company nested object missing (/candidate/get jobs[] shape)', () => {
    const row = toJobThinRow({
      id: 42,
      name: 'X',
      client_company_name: 'Acme',
      created_time: '2024-01-15T09:00:00+0000',
    });
    expect(row.client_company_name).toBe('Acme');
  });

  it('falls back to rf.title when name absent', () => {
    const row = toJobThinRow({
      id: 1,
      title: 'Senior SWE',
      created_time: '2024-01-15T09:00:00+0000',
    });
    expect(row.name).toBe('Senior SWE');
  });

  it('throws on missing created_time', () => {
    expect(() => toJobThinRow({ id: 1, name: 'X' })).toThrow(/created_time/);
  });
});

describe('toCallRow', () => {
  it('shapes a Dialpad /v2/call response item into a row', () => {
    const dp = {
      call_id: '5678901234',
      target: { id: '8000000000000001', name: 'Joel' },
      contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345', name: 'Jane Doe' },
      date_started: 1717248000000,
      total_duration: 180500,
      direction: 'outbound',
    };
    const row = toCallRow(dp);
    expect(row).toEqual({
      call_id: '5678901234',
      target_dialpad_id: '8000000000000001',
      dialpad_contact_id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
      rf_candidate_id: 12345,
      date_started_ms: 1717248000000,
      duration_ms: 180500,
      direction: 'outbound',
      cached_at_ms: expect.any(Number),
    });
  });

  it('rounds fractional ms in total_duration', () => {
    const row = toCallRow({
      call_id: 'c1',
      target: { id: '1' },
      contact: { id: 'shared_contact_pool_Company:X_uid_RF1' },
      date_started: 1,
      total_duration: 68286.025,
      direction: 'outbound',
    });
    expect(row.duration_ms).toBe(68286);
  });

  it('returns rf_candidate_id null when contact id does not match the RF pattern', () => {
    const row = toCallRow({
      call_id: 'c1',
      target: { id: '1' },
      contact: { id: 'something-else' },
      date_started: 1,
      total_duration: 1000,
      direction: 'inbound',
    });
    expect(row.rf_candidate_id).toBeNull();
  });

  it('coerces target.id and contact.id to strings', () => {
    const row = toCallRow({
      call_id: 'c1',
      target: { id: 8000000000000001 },
      contact: { id: 'shared_contact_pool_Company:X_uid_RF1' },
      date_started: 1,
      total_duration: 1000,
      direction: 'outbound',
    });
    expect(row.target_dialpad_id).toBe('8000000000000001');
  });

  it('throws when dp.target.id is missing', () => {
    expect(() => toCallRow({
      call_id: 'c1',
      contact: { id: 'shared_contact_pool_Company:X_uid_RF1' },
      date_started: 1,
      total_duration: 1000,
      direction: 'outbound',
    })).toThrow(/target/);
  });
});
