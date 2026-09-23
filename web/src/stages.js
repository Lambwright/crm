// Mirrors worker/src/index.js's STAGES + STAGE_REQUIREMENTS for display and
// client-side hinting only — the worker is the source of truth and validates
// every transition independently. Keep these two lists in sync by hand; there
// are few enough stages that a shared-package split isn't worth it yet.

export const STAGE_ORDER = [
  "rfq_imported", "qualified_estimating", "bid_in_preparation", "bid_submitted",
  "client_evaluation", "clarification_negotiation", "awarded_handoff",
  "on_hold", "closed_won", "closed_lost", "no_bid",
];

export const STAGE_LABELS = {
  rfq_imported: "RFQ Imported",
  no_bid: "No Bid",
  qualified_estimating: "Qualified – Estimating",
  bid_in_preparation: "Bid in Preparation",
  bid_submitted: "Bid Submitted",
  client_evaluation: "Client Evaluation",
  clarification_negotiation: "Clarification / Negotiation",
  awarded_handoff: "Awarded – Handoff Pending",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
  on_hold: "On Hold",
};

// Board columns — closed/no-bid stages are visible in the list view but
// collapsed off the kanban board by default (BidBoard filters these out of
// the column set, not out of the underlying data).
export const BOARD_STAGES = [
  "rfq_imported", "qualified_estimating", "bid_in_preparation", "bid_submitted",
  "client_evaluation", "clarification_negotiation", "awarded_handoff", "on_hold",
];

// field -> label, shown as inputs when a stage-move requires them. Must match
// worker/src/index.js's STAGE_REQUIREMENTS exactly.
export const STAGE_REQUIREMENTS = {
  no_bid: [["no_bid_reason", "No-Bid Reason", "text"]],
  qualified_estimating: [
    ["owner_username", "Owner", "text"],
    ["estimator_username", "Estimator", "text"],
    ["bid_due_date", "Bid Due Date", "date"],
  ],
  bid_submitted: [
    ["submitted_date", "Submitted Date", "date"],
    ["submitted_value", "Submitted Value", "number"],
    ["expected_decision_date", "Expected Decision Date", "date"],
    ["next_action_date", "Follow-Up Date", "date"],
  ],
  client_evaluation: [["next_action_date", "Next Action Date", "date"]],
  clarification_negotiation: [["next_action", "Next Action", "text"]],
  on_hold: [
    ["hold_reason", "Hold Reason", "text"],
    ["hold_review_date", "Review Date", "date"],
  ],
  awarded_handoff: [["estimated_value", "Expected/Final Value", "number"]],
  closed_won: [
    ["final_value", "Final Value", "number"],
    ["award_date", "Award Date", "date"],
  ],
  closed_lost: [["lost_reason", "Lost Reason", "text"]],
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
