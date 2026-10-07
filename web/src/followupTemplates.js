// Plain-language follow-up drafts, several per stage bucket so they don't read
// as canned (Ben, 2026-10-07) — the Randomize button in the follow-up box cycles
// through them. Meant to be edited before sending, not a mail-merge that has to
// be exactly right on the first try. Grouped by what's actually true at that
// point in the pipeline (pre-submission vs. waiting on a decision vs. already
// engaged), not by every individual Procore stage — see stages.js STAGE_LABELS
// for the display names.
const PRE_SUBMISSION = new Set(["rfq", "invitation", "estimating", "to_do"]);
const AWAITING_DECISION = new Set(["bid_submitted"]);
const ENGAGED = new Set(["accepted", "in_progress", "delayed"]);

function greeting(contactFirstName, variant) {
  const hello = ["Hi", "Hello", "Good day", "Hi there"][variant % 4];
  return contactFirstName ? `${hello} ${contactFirstName},` : `${hello},`;
}

const SIGNOFFS = ["Thanks,", "Thank you,", "Best regards,", "Many thanks,", "Cheers,"];

const PRE = [
  (p) => `Just checking in on ${p} — wanted to make sure we're all set to get you a number. Let us know if anything's changed on the scope or timeline, or if there's anything else you need from us before we price it.`,
  (p) => `We're working through the pricing on ${p} and wanted to confirm the drawings and bid date we have are still current. If there have been any addenda or scope changes, could you send them our way?`,
  (p) => `I wanted to touch base on ${p}. We're keen to get you a competitive number — is the bid date still holding, and is there anything on the scope you'd like us to look at specifically?`,
  (p) => `Quick note on ${p}: we have it on our list to price and want to be sure we've got everything. Anything new from your side — revised drawings, a moved deadline — would be great to know about.`,
  (p) => `Following up on ${p}. If it helps, we can talk through scope or alternates before your bid closes. Just let us know what would be most useful.`,
];

const AWAITING = (bid) => {
  const sub = bid.submitted_date ? ` (submitted ${String(bid.submitted_date).slice(0, 10)})` : "";
  return [
    (p) => `Following up on our proposal for ${p}${sub}. Wanted to check where things stand on your end, and see if there's anything else you need from us to make a decision.`,
    (p) => `I hope your week is going well. We sent over our pricing for ${p}${sub} and wanted to see whether you've had a chance to review it — happy to answer any questions or adjust if the scope has moved.`,
    (p) => `Checking in on ${p}${sub}. Do you have a sense of timing for a decision? If there's anything we can clarify on our number, we're glad to help.`,
    (p) => `Just a friendly nudge on ${p}${sub}. If you're comparing options, we'd welcome the chance to go over our proposal with you or tighten anything up.`,
    (p) => `We'd love to hear how ${p} is progressing${sub}. Is there anything outstanding on our side that would help you decide?`,
  ];
};

const ENGAGED_V = [
  (p) => `Just touching base on ${p} — let us know if there's any update on timing or next steps on your end.`,
  (p) => `Checking in on ${p}. Is the schedule still on track, and is there anything you need from us to keep things moving?`,
  (p) => `Wanted to see how ${p} is coming along and whether the timing has shifted at all. Happy to adjust on our end.`,
  (p) => `Following up on ${p} — if anything has changed on scope, sequencing or dates, please let us know so we can plan accordingly.`,
];

const OTHER = [
  (p) => `Following up on ${p}.`,
  (p) => `Just checking in regarding ${p} — is there anything you need from us?`,
];

function pool(bid) {
  if (PRE_SUBMISSION.has(bid.stage)) return PRE;
  if (AWAITING_DECISION.has(bid.stage)) return AWAITING(bid);
  if (ENGAGED.has(bid.stage)) return ENGAGED_V;
  return OTHER;
}

// How many different drafts exist for this bid's stage.
export function variantCount(bid) {
  return pool(bid).length;
}

// `variant` is any integer; it wraps. Call with a random one for a fresh draft,
// or the next one up to cycle.
export function buildFollowUpDraft(bid, { contactFirstName, contactEmail } = {}, variant = 0) {
  const project = bid.project_name || "this project";
  const bodies = pool(bid);
  const v = ((variant % bodies.length) + bodies.length) % bodies.length;
  const body = `${greeting(contactFirstName, Math.abs(variant))}\n\n${bodies[v](project)}\n\n${SIGNOFFS[Math.abs(variant) % SIGNOFFS.length]}\n`;
  const subjects = [`RE: ${project}`, `Following up: ${project}`, `${project} — checking in`, `RE: ${project} — quick follow-up`];
  return {
    to: contactEmail || "",
    subject: subjects[((variant % subjects.length) + subjects.length) % subjects.length],
    body,
  };
}
