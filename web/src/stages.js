// Mirrors worker/src/index.js's STAGES + STAGE_REQUIREMENTS for display and
// client-side hinting only — the worker is the source of truth and validates
// every transition independently. Keep these two lists in sync by hand; there
// are few enough stages that a shared-package split isn't worth it yet.
//
// These are Procore's own 9 real Bid Board statuses (raw keys; labels below
// are Einbau's actual custom labels, confirmed live via Procore's
// /estimating/settings — not guessed), plus `no_bid` as a 10th CRM-only
// stage for SCOUT declines, which has no Procore equivalent. "Awarded -
// Handoff Pending" is NOT a stage — see HANDOFF_STATUS_LABELS below; it's an
// attribute of `complete` bids, not something a bid moves through.

export const STAGE_ORDER = [
  "invitation", "accepted", "estimating", "bid_submitted", "to_do",
  "delayed", "in_progress", "lost", "complete", "no_bid",
];

export const STAGE_LABELS = {
  invitation: "Invitation",
  accepted: "Active (30-60 days)",
  estimating: "Estimating Queue",
  bid_submitted: "Submitted (30 days)",
  to_do: "S/I Queue",
  delayed: "Watch List",
  in_progress: "Active (60-90+ days)",
  lost: "Lost ENA / CNA",
  complete: "Awarded",
  no_bid: "No Bid",
};

export const HANDOFF_STATUS_LABELS = {
  pending: "Handoff Pending",
  complete: "Handoff Complete",
};

// Board columns — closed/no-bid stages are visible in the list view but
// collapsed off the kanban board by default (BidBoard filters these out of
// the column set, not out of the underlying data).
export const BOARD_STAGES = [
  "invitation", "accepted", "estimating", "bid_submitted", "to_do", "delayed", "in_progress",
];

// field -> label, shown as inputs when a stage-move requires them. Must match
// worker/src/index.js's STAGE_REQUIREMENTS exactly. Most of Procore's own
// statuses turned out to be attention/aging flags rather than real
// data-collection points (per Ben) — only Lost and Awarded are gated.
export const STAGE_REQUIREMENTS = {
  no_bid: [["no_bid_reason", "No-Bid Reason", "text"]],
  bid_submitted: [
    ["submitted_date", "Submitted Date", "date"],
    ["submitted_value", "Submitted Value", "number"],
    ["expected_decision_date", "Expected Decision Date", "date"],
    ["next_action_date", "Follow-Up Date", "date"],
  ],
  complete: [
    ["final_value", "Final Value", "number"],
    ["award_date", "Award Date", "date"],
  ],
  lost: [["lost_reason", "Lost Reason", "text"]],
};

export const ACCOUNT_SEGMENTS = [
  "unreviewed", "qualified_target", "active_prospect", "engaged_prospect",
  "customer", "dormant_customer", "do_not_pursue", "do_not_work_with",
];

export const ACCOUNT_SEGMENT_LABELS = {
  unreviewed: "Unreviewed",
  qualified_target: "Qualified Target",
  active_prospect: "Active Prospect",
  engaged_prospect: "Engaged Prospect",
  customer: "Customer",
  dormant_customer: "Dormant Customer",
  do_not_pursue: "Do Not Pursue",
  do_not_work_with: "Do Not Work With",
};
