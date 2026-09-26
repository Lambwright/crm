// Plain-language follow-up drafts, one per stage bucket, meant to be edited
// before sending — not a mail-merge that has to be exactly right on the first
// try. Grouped by what's actually true at that point in the pipeline (pre-
// submission vs. waiting on a decision vs. already engaged), not by every
// individual Procore stage — see stages.js STAGE_LABELS for the display names.
const PRE_SUBMISSION = new Set(["rfq", "invitation", "estimating", "to_do"]);
const AWAITING_DECISION = new Set(["bid_submitted"]);
const ENGAGED = new Set(["accepted", "in_progress", "delayed"]);

function greeting(contactFirstName) {
  return contactFirstName ? `Hi ${contactFirstName},` : "Hi,";
}

export function buildFollowUpDraft(bid, { contactFirstName, contactEmail } = {}) {
  const project = bid.project_name || "this project";
  let body;

  if (PRE_SUBMISSION.has(bid.stage)) {
    body =
      `${greeting(contactFirstName)}\n\n` +
      `Just checking in on ${project} — wanted to make sure we're all set to get you a number. ` +
      `Let us know if anything's changed on the scope or timeline, or if there's anything else you need from us before we price it.\n\n` +
      `Thanks,\n`;
  } else if (AWAITING_DECISION.has(bid.stage)) {
    body =
      `${greeting(contactFirstName)}\n\n` +
      `Following up on our proposal for ${project}` +
      `${bid.submitted_date ? ` (submitted ${bid.submitted_date})` : ""}. ` +
      `Wanted to check where things stand on your end, and see if there's anything else you need from us to make a decision.\n\n` +
      `Thanks,\n`;
  } else if (ENGAGED.has(bid.stage)) {
    body =
      `${greeting(contactFirstName)}\n\n` +
      `Just touching base on ${project} — let us know if there's any update on timing or next steps on your end.\n\n` +
      `Thanks,\n`;
  } else {
    body = `${greeting(contactFirstName)}\n\nFollowing up on ${project}.\n\nThanks,\n`;
  }

  return {
    to: contactEmail || "",
    subject: `RE: ${project}`,
    body,
  };
}
