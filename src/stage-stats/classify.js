/**
 * Stage-label classification for the stage-movement stats plane.
 *
 * KEPT IN LOCKSTEP with company_dashboard/server/config/consultants.json
 * (`pre_submission_stage_labels`, `first_interview_stage_labels`). When the
 * label sets change, edit BOTH files together, then re-run the backfill
 * (POST /admin/stage-stats/backfill) over the horizon you care about — the
 * is_cv_cross / is_iv_landing flags are denormalised into D1 at write time
 * and do not self-heal on a label change.
 *
 * Counting semantics (canonical, shared with the dashboard):
 *  - Submitted territory is a DENYLIST: a stage is submitted-or-beyond unless
 *    its trimmed, lowercased name is in PRE_SUBMISSION_STAGES or contains
 *    "disqualif". Empty/whitespace-only/missing names are NOT submitted.
 *  - CV-Sent crossing: is_submitted(to) && !is_submitted(from); a missing
 *    `from` counts as not-submitted, so a first entry straight into submitted
 *    territory IS a crossing, and stage-skipping jumps are crossings.
 *  - 1st-Interview landing: trimmed, lowercased `to` is in
 *    FIRST_INTERVIEW_STAGES (allowlist).
 */

export const PRE_SUBMISSION_STAGES = new Set([
  'sourced', 'applied', 'replied', 'replied (cold)', 'call booked', 'shortlist',
  'new lead', 'new', 'contacted', 'prospect', 'screening',
]);

export const FIRST_INTERVIEW_STAGES = new Set([
  '1st interview', 'first interview', 'client interview 1', 'client interview',
  'interview 1',
]);

/**
 * Denylist test: a stage is "submitted territory" (CV-Sent-or-beyond) unless
 * it is empty, disqualified, or a configured pre-submission stage. Errs toward
 * counting an unknown stage as submitted — a wasted event row is harmless, a
 * silently dropped submission is not.
 *
 * @param {string|null|undefined} stageName
 * @returns {boolean}
 */
export function isSubmittedStage(stageName) {
  if (stageName === null || stageName === undefined) return false;
  const n = String(stageName).trim().toLowerCase();
  if (n === '' || n.includes('disqualif')) return false;
  return !PRE_SUBMISSION_STAGES.has(n);
}

/**
 * Classify one stage transition.
 *
 * @param {string|null|undefined} fromStage
 * @param {string|null|undefined} toStage
 * @returns {{ isCvCross: boolean, isIvLanding: boolean }}
 */
export function classifyTransition(fromStage, toStage) {
  const toSubmitted = isSubmittedStage(toStage);
  const fromSubmitted = isSubmittedStage(fromStage);
  const toNorm = toStage === null || toStage === undefined
    ? ''
    : String(toStage).trim().toLowerCase();
  return {
    isCvCross: toSubmitted && !fromSubmitted,
    isIvLanding: FIRST_INTERVIEW_STAGES.has(toNorm),
  };
}
