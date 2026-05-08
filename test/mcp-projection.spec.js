import { describe, it, expect } from 'vitest';
import { resolveFieldName, resolveFields, project, getPath, resolveFieldsWithDefaults } from '../src/mcp/projection.js';

const sample = {
  id: 1, name: 'X', primary_email: 'x@y.com',
  current_organization: 'Acme', current_title: 'Engineer',
  jobs: [{ job_name: 'Eng', stage_name: 'Sourced' }],
  custom_fields_by_name: {
    'expected compensation': { name: 'Expected Compensation', value: '100k' },
    'technology': { name: 'Technology', value: ['Kubernetes', 'Go'] },
  },
};

describe('projection', () => {
  it('aliases english names to schema paths', () => {
    expect(resolveFieldName('linkedin', Object.keys(sample))).toMatchObject({ path: 'linkedin_profile' });
    expect(resolveFieldName('email', Object.keys(sample))).toMatchObject({ path: 'primary_email' });
    expect(resolveFieldName('company', Object.keys(sample))).toMatchObject({ path: 'current_organization' });
    expect(resolveFieldName('stage', Object.keys(sample))).toMatchObject({ path: 'jobs.*.stage_name' });
  });
  it('resolves cf.<name> to custom_fields_by_name path', () => {
    const r = resolveFieldName('cf.expected compensation', Object.keys(sample), sample);
    expect(r).toMatchObject({ path: 'custom_fields_by_name.expected compensation.value' });
  });
  it('resolveFields collects errors for unresolvable names', () => {
    const r = resolveFields(['linkedin', 'totally_unknown_field_xyz'], sample, sample);
    expect(r.paths).toContain('linkedin_profile');
    expect(r.errors.length).toBe(1);
  });
  it('project keeps only requested paths', () => {
    const out = project(sample, ['id', 'name', 'current_organization']);
    expect(out).toEqual({ id: 1, name: 'X', current_organization: 'Acme' });
  });
  it('getPath supports * wildcard for arrays', () => {
    expect(getPath(sample, 'jobs.*.stage_name')).toEqual(['Sourced']);
  });
});

describe('resolveFieldsWithDefaults', () => {
  it('returns defaults when extras is empty/undefined', () => {
    const r = resolveFieldsWithDefaults(undefined, ['id', 'name'], sample, sample);
    expect(r.paths).toEqual(['id', 'name']);
  });

  it('extends defaults with extras', () => {
    const r = resolveFieldsWithDefaults(['linkedin'], ['id', 'name'], sample, sample);
    expect(r.paths).toEqual(['id', 'name', 'linkedin_profile']);
  });

  it('dedupes by resolved path (extras request a default)', () => {
    const r = resolveFieldsWithDefaults(['name', 'who'], ['id', 'name'], sample, sample);
    // 'who' aliases to 'name' — both collapse to one path.
    expect(r.paths).toEqual(['id', 'name']);
  });

  it('drops unknown field names silently', () => {
    const r = resolveFieldsWithDefaults(['totally_unknown_xyz'], ['id', 'name'], sample, sample);
    expect(r.paths).toEqual(['id', 'name']);
  });

  it('preserves default order and appends extras after', () => {
    const r = resolveFieldsWithDefaults(['linkedin'], ['name', 'id'], sample, sample);
    expect(r.paths).toEqual(['name', 'id', 'linkedin_profile']);
  });

  it('resolves alias on extras (company → current_organization)', () => {
    const r = resolveFieldsWithDefaults(['company'], ['id'], sample, sample);
    expect(r.paths).toEqual(['id', 'current_organization']);
  });
});
