/**
 * Team registry — single source of truth for consultant-to-system-id mappings.
 *
 * Each record maps a consultant's first name to:
 *   - rfUserId: their RecruiterFlow user_id (used for activity_user_id, stage move user_id, lead_owner_id, custom_fields[consultant_id], etc.)
 *   - dialpadId: their Dialpad target.id (used for cold-call attribution)
 *
 * Edits show up in PR diffs. Add/remove entries here when the team changes.
 */

const USERS = [
  { firstName: 'Joel',  rfUserId: 900001, dialpadId: '8000000000000001' },
  { firstName: 'Alice', rfUserId: 900002, dialpadId: '8000000000000002' },
  // TODO: add remaining team members (firstName, rfUserId, dialpadId)
];

function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase();
  return trimmed || null;
}

export function getUserByFirstName(firstName) {
  const key = normalizeName(firstName);
  if (!key) return null;
  return USERS.find(u => u.firstName.toLowerCase() === key) ?? null;
}

export function getUserByDialpadId(dialpadId) {
  if (dialpadId === null || dialpadId === undefined) return null;
  const key = String(dialpadId);
  return USERS.find(u => u.dialpadId === key) ?? null;
}

export function getUserByRFUserId(rfUserId) {
  if (rfUserId === null || rfUserId === undefined) return null;
  return USERS.find(u => u.rfUserId === rfUserId) ?? null;
}

export function resolveRFUserId(firstName) {
  return getUserByFirstName(firstName)?.rfUserId ?? null;
}

export function getRFUserIdByDialpadId(dialpadId) {
  return getUserByDialpadId(dialpadId)?.rfUserId ?? null;
}

export function isMonitoredDialpadUser(dialpadId) {
  return getUserByDialpadId(dialpadId) !== null;
}
