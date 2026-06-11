/**
 * Test helper: RF `/job/pipeline` response fixtures for the stage-stats
 * positional classification (summary[] = the job's ordered stage list).
 */

/** A representative pipeline: landmark at 'CV Sent', IV stage '1st Interview'. */
export const DEFAULT_PIPELINE = [
  'New Lead', 'Sourced', 'Applied', 'Replied', 'Call Booked', 'Shortlist',
  'CV Sent', '1st Interview', '2nd Interview', 'Offer', 'Placed', 'Disqualified',
];

/** Wire-shaped `/job/pipeline` 200 for a given ordered stage-name list. */
export const pipelineResponse = (names = DEFAULT_PIPELINE) =>
  new Response(
    JSON.stringify({
      summary: names.map((name) => ({ name, candidate_count: 0 })),
      detail: [],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
