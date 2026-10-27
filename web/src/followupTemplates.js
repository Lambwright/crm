// Plain-language follow-up drafts, several per stage bucket so they don't read
// as canned (Ben, 2026-10-07) — the Randomize button in the follow-up box cycles
// through them. Meant to be edited before sending, not a mail-merge that has to
// be exactly right on the first try.
//
// What a follow-up is for (Ben, 2026-10-28): find out whether they received our
// quote, whether they have questions or concerns, whether the project has been
// awarded (and to whom), and whether we are still in the running. So once a
// quote is out, every draft asks those things in plain words.
//
// Grouped by what's actually true at that point, not by every Procore stage —
// see stages.js STAGE_LABELS for the display names:
//   - before the quote goes out (RFQ, Invitation, Estimating Queue, S/I Queue)
//   - quote just submitted (Submitted)
//   - quote out for weeks (Active 30-60 / 60-90+ days: the aged buckets)
//   - on hold (Watch List)
const PRE_SUBMISSION = new Set(["rfq", "invitation", "estimating", "to_do"]);
const SUBMITTED = new Set(["bid_submitted"]);
const AGED = new Set(["accepted", "in_progress"]);
const ON_HOLD = new Set(["delayed"]);

function greeting(contactFirstName, variant) {
  const hello = ["Hi", "Hello", "Good day", "Hi there"][variant % 4];
  return contactFirstName ? `${hello} ${contactFirstName},` : `${hello},`;
}

const SIGNOFFS = ["Thanks,", "Thank you,", "Best regards,", "Many thanks,", "Cheers,"];

const PRE = [
  (p) => `Just checking in on ${p}. We want to make sure we have everything we need to get you a number. Is the bid date still holding, and has anything changed on the scope or drawings?`,
  (p) => `We're working on the pricing for ${p} and wanted to confirm we have the latest drawings and addenda. If there have been any changes, could you send them our way so our number is right?`,
  (p) => `I wanted to touch base on ${p}. Is your bid date still the same, and is there anything you'd like us to look at specifically or any questions we can answer before we submit?`,
  (p) => `Quick note on ${p}: we're keen to get you a competitive number. Anything new from your side, such as revised drawings or a moved deadline, would be great to know about.`,
  (p) => `Following up on ${p}. If it helps, we can talk through scope or alternates before your bid closes. Just let us know what would be most useful.`,
];

const SUBMITTED_V = (bid) => {
  const sub = bid.submitted_date ? ` (sent ${String(bid.submitted_date).slice(0, 10)})` : "";
  return [
    (p) => `I'm following up on our quote for ${p}${sub}. Did you receive it all right? If you've had a chance to look it over, do you have any questions or concerns we can help with? And are we still in the running?`,
    (p) => `Just checking that our pricing for ${p}${sub} reached you. Have you started reviewing the bids? We'd be glad to go through anything in our number, and we'd appreciate knowing where we stand.`,
    (p) => `We sent over our quote for ${p}${sub} and wanted to be sure it got to the right person. Is there anything in it that needs clarifying or adjusting? Do you have a sense of when a decision will be made?`,
    (p) => `Following up on ${p}${sub}. Has the project been awarded yet, and if so, could you let us know how we made out? If it's still open, we'd welcome the chance to answer any questions on our price.`,
    (p) => `Hoping you got our quote for ${p}${sub}. Any questions, concerns, or scope changes since you received it? We'd also like to know if we're still being considered.`,
  ];
};

const AGED_V = (bid) => {
  const sub = bid.submitted_date ? ` on ${String(bid.submitted_date).slice(0, 10)}` : "";
  return [
    (p) => `It's been a little while since we sent our quote for ${p}${sub}, so I wanted to check in. Has a decision been made? If it's been awarded, we'd appreciate knowing the outcome either way, and if not, are we still in the running?`,
    (p) => `Checking back on ${p}. We sent pricing${sub} and haven't heard since. Did the quote reach you, and do you have any questions or concerns on it? A quick yes or no on whether we're still in the picture would help us plan.`,
    (p) => `I wanted to follow up on ${p}. Is the project still going ahead, and where are you in choosing a contractor? If our price needs another look because scope or timing has changed, we're happy to revisit it.`,
    (p) => `Following up on our quote for ${p}${sub}. Have you made your decision? Whatever the result, we'd value the feedback. If it's still open, is there anything we can clarify to help?`,
  ];
};

const HOLD_V = [
  (p) => `I'm checking in on ${p}, which we understand is on hold. Is the project still going ahead, and do you have a sense of when it might move again? We're happy to refresh our pricing when you're ready.`,
  (p) => `Following up on ${p}. Has anything changed on timing or scope since our quote? Let us know if the project is back on, and whether we're still in the running.`,
];

const OTHER = [
  (p) => `Following up on ${p}.`,
  (p) => `Just checking in regarding ${p}. Is there anything you need from us?`,
];

function pool(bid) {
  if (PRE_SUBMISSION.has(bid.stage)) return PRE;
  if (SUBMITTED.has(bid.stage)) return SUBMITTED_V(bid);
  if (AGED.has(bid.stage)) return AGED_V(bid);
  if (ON_HOLD.has(bid.stage)) return HOLD_V;
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
  const subjects = [`RE: ${project}`, `Following up: ${project}`, `${project}: checking in`, `RE: ${project}: quick follow-up`];
  return {
    to: contactEmail || "",
    subject: subjects[((variant % subjects.length) + subjects.length) % subjects.length],
    body,
  };
}
