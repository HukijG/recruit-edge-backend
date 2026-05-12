/**
 * LinkedIn URL output normalization.
 *
 * D1 stores bare slugs (cache-worker `normalizeLinkedInSlug` strips URLs at
 * ingest). Callers want full URLs. This module turns slugs into URLs at
 * output time only — no ingest / cache changes, so the writer stays the
 * single source of truth.
 */

import { project } from './projection.js';

const LINKEDIN_BASE = 'https://www.linkedin.com/in/';
const SLUG_RE = /^[a-z0-9_-]+$/i;

/**
 * Slug → canonical URL. Pass-through for null/empty/full-URL/weird shapes.
 */
export function toLinkedInUrl(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (!SLUG_RE.test(value)) return value;
  return LINKEDIN_BASE + value;
}

/**
 * Walk an object/array tree, calling `transform(path, value)` on every leaf.
 * Returns a new tree (no in-place mutation of the input). Path is the dot-
 * joined key trail.
 */
function walkTransform(node, transform, path = '') {
  if (Array.isArray(node)) return node.map((v, i) => walkTransform(v, transform, `${path}.${i}`));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walkTransform(v, transform, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return transform(path, node);
}

/**
 * Project + LinkedIn-normalize. Drop-in replacement for `project()` in any
 * MCP handler that returns candidate-shaped data.
 */
export function projectWithLinkedIn(obj, paths) {
  const projected = project(obj, paths);
  return walkTransform(projected, (path, value) =>
    path.endsWith('linkedin_profile') ? toLinkedInUrl(value) : value
  );
}
