import {
  ASK_LABELS,
  DECLINE_REASONS,
  STATE_LABELS,
  categoryLabel,
  type Ask,
  type CounterpartyRecord,
  type EngagementActionInput,
  type EngagementRecord,
  type EngagementState,
} from "./types";

/**
 * The engagement lifecycle: one state per counterparty per reporting year,
 * every change recorded as an event. Transitions are table-driven so the
 * allowed moves can be read in one place and tested without a database.
 *
 *   identified → contacted → engaged → responding → complete → verified
 *                    ↓          ↓          ↓
 *               unreachable  declined   declined
 *
 * Reminders and escalations leave the state alone and count. A reopen returns
 * any closed engagement to identified so the next year's chase starts clean.
 */
const ALLOWED: Record<EngagementActionInput["action"], readonly EngagementState[]> = {
  request_sent: ["identified", "unreachable", "declined"],
  reminder_sent: ["contacted", "engaged", "responding"],
  escalated: ["contacted", "engaged", "responding"],
  reply_received: ["contacted"],
  data_received: ["contacted", "engaged", "responding"],
  marked_complete: ["contacted", "engaged", "responding"],
  verified: ["complete", "responding"],
  declined: ["identified", "contacted", "engaged", "responding"],
  unreachable: ["contacted"],
  reopened: ["complete", "verified", "declined", "unreachable"],
  note: ["identified", "contacted", "engaged", "responding", "complete", "verified", "declined", "unreachable"],
};

export class TransitionError extends Error {
  constructor(action: string, state: EngagementState) {
    super(`Cannot record "${action.replace(/_/g, " ")}" while the engagement is ${STATE_LABELS[state].toLowerCase()}.`);
    this.name = "TransitionError";
  }
}

export type EngagementPatch = Omit<EngagementRecord, "id" | "counterpartyId" | "reportingYear" | "createdAt" | "updatedAt">;

/** Computes the engagement after an action, or throws when the action is not allowed from the current state. */
export function transition(current: EngagementRecord, input: EngagementActionInput, today: string): EngagementPatch {
  if (!ALLOWED[input.action].includes(current.state)) throw new TransitionError(input.action, current.state);
  const on = input.on ?? today;
  const base: EngagementPatch = {
    state: current.state, ask: current.ask, dueOn: current.dueOn, lastContactOn: current.lastContactOn, remindersSent: current.remindersSent,
    escalated: current.escalated, declineReason: current.declineReason, notes: current.notes,
  };
  switch (input.action) {
    case "request_sent":
      return { ...base, state: "contacted", ask: input.ask ?? current.ask, dueOn: input.dueOn ?? current.dueOn, lastContactOn: on, remindersSent: 0, escalated: false, declineReason: undefined };
    case "reminder_sent":
      return { ...base, lastContactOn: on, remindersSent: current.remindersSent + 1 };
    case "escalated":
      return { ...base, lastContactOn: on, escalated: true };
    case "reply_received":
      return { ...base, state: "engaged" };
    case "data_received":
      return { ...base, state: input.complete ? "complete" : "responding" };
    case "marked_complete":
      return { ...base, state: "complete" };
    case "verified":
      return { ...base, state: "verified" };
    case "declined":
      return { ...base, state: "declined", declineReason: input.declineReason };
    case "unreachable":
      return { ...base, state: "unreachable" };
    case "reopened":
      return { ...base, state: "identified", remindersSent: 0, escalated: false, declineReason: undefined, dueOn: undefined, lastContactOn: undefined };
    case "note":
      return base;
  }
}

/* ------------------------------------------------------------------ */
/* the chase: what to do next, and when                                 */
/* ------------------------------------------------------------------ */

/** Days of silence after a request or reminder before the next step is due. */
export const REMINDER_AFTER_DAYS = 21;
/** Reminders sent before the ladder moves to the escalation contact. */
export const REMINDERS_BEFORE_ESCALATION = 2;
/** Days past the deadline after which a secondary estimate is used and disclosed. */
export const GRACE_AFTER_DUE_DAYS = 14;

export interface NextAction {
  /** Short imperative, e.g. "Send reminder 2". */
  action: string;
  /** Why, naming the dates and counts that decided it. */
  reason: string;
  /** Whether the action is due now rather than a description of the next step. */
  due: boolean;
  /** Past the deadline plus grace with nothing usable received. */
  overdue: boolean;
}

const MS_PER_DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);

export interface DataHeld {
  report: boolean;
  ledgerLines: number;
}

/**
 * Deterministic chase ladder from the state, the dates and what has arrived:
 * request, reminder, reminder, escalation, final notice, fall back. The engine
 * proposes; a person records what was actually done.
 */
export function nextAction(engagement: EngagementRecord | undefined, counterparty: CounterpartyRecord, held: DataHeld, today: string): NextAction {
  const hasData = held.report || held.ledgerLines > 0;
  const askText = ASK_LABELS[engagement?.ask ?? counterparty.ask];
  if (!engagement || engagement.state === "identified") {
    return { action: "Send the data request", reason: `${counterparty.name} has not been asked for ${engagement?.reportingYear ?? "this year's"} data. Ask for: ${askText}.`, due: true, overdue: false };
  }
  const e = engagement;
  const overdue = e.dueOn !== undefined && daysBetween(e.dueOn, today) > GRACE_AFTER_DUE_DAYS && !hasData && !["complete", "verified"].includes(e.state);
  const silence = e.lastContactOn ? daysBetween(e.lastContactOn, today) : 0;
  const escalation = counterparty.escalationName ? `${counterparty.escalationName}${counterparty.escalationEmail ? ` (${counterparty.escalationEmail})` : ""}` : "a senior or commercial contact";

  switch (e.state) {
    case "contacted":
    case "engaged":
    case "responding": {
      if (hasData && e.state !== "responding") {
        return { action: "Record the data as received", reason: `${held.report ? "An annual report" : `${held.ledgerLines} ledger line${held.ledgerLines === 1 ? "" : "s"}`} for ${e.reportingYear} is held but the engagement still reads "${STATE_LABELS[e.state].toLowerCase()}".`, due: true, overdue };
      }
      if (overdue) {
        return { action: "Fall back to a secondary estimate and disclose it", reason: `The ${e.dueOn} deadline passed ${daysBetween(e.dueOn!, today)} days ago with nothing usable received after ${e.remindersSent} reminder${e.remindersSent === 1 ? "" : "s"}${e.escalated ? " and an escalation" : ""}. Tell ${counterparty.name} what will be assumed on their behalf, then mark the engagement unreachable or declined.`, due: true, overdue };
      }
      if (e.state === "responding") {
        return { action: "Review what has arrived and ask for the outstanding fields", reason: `Data is arriving from ${counterparty.name}; mark it complete once everything asked for is in.`, due: true, overdue };
      }
      if (silence < REMINDER_AFTER_DAYS) {
        return { action: e.state === "engaged" ? "Wait for the data" : "Wait for a reply", reason: `Last contact ${e.lastContactOn}, ${silence} day${silence === 1 ? "" : "s"} ago; the next step falls due after ${REMINDER_AFTER_DAYS} days of silence${e.dueOn ? `, and the deadline is ${e.dueOn}` : ""}.`, due: false, overdue };
      }
      if (e.remindersSent < REMINDERS_BEFORE_ESCALATION) {
        return { action: `Send reminder ${e.remindersSent + 1}`, reason: `${silence} days since the last contact on ${e.lastContactOn} with no ${e.state === "engaged" ? "data" : "reply"}. Restate only what is outstanding${e.dueOn ? ` and the ${e.dueOn} deadline` : ""}.`, due: true, overdue };
      }
      if (!e.escalated) {
        return { action: `Escalate to ${escalation}`, reason: `${e.remindersSent} reminders have gone unanswered; move up the contact ladder rather than sending more mail to the same person.`, due: true, overdue };
      }
      return { action: "Send a final notice", reason: `Reminders and escalation have not produced ${e.state === "engaged" ? "the data" : "a reply"}. State plainly that a secondary estimate will be used and disclosed${e.dueOn ? ` if nothing arrives by ${e.dueOn}` : ""}.`, due: true, overdue };
    }
    case "complete":
      return { action: "Review and verify the figures", reason: hasData ? `${counterparty.name}'s ${e.reportingYear} data is held; check the boundary, the allocation and the evidence, then mark it verified.` : `The engagement is marked complete but no report or ledger for ${e.reportingYear} is recorded against ${counterparty.name}. Enter what was received.`, due: true, overdue: false };
    case "verified":
      return { action: "Nothing due", reason: hasData ? `${e.reportingYear} data is verified. It will need re-requesting for the next reporting year.` : `Marked verified but no report or ledger for ${e.reportingYear} is recorded; reopen or enter the data.`, due: !hasData, overdue: false };
    case "declined":
      return { action: "Use a secondary estimate and disclose it", reason: `${counterparty.name} declined${e.declineReason ? ` (${DECLINE_REASONS[e.declineReason as keyof typeof DECLINE_REASONS] ?? e.declineReason})` : ""}. Estimate the category from spend or average data, state the basis, and re-approach next period${e.declineReason === "vsme_right_to_refuse" ? " with a VSME-only ask" : ""}.`, due: true, overdue: false };
    case "unreachable":
      return { action: "Use a secondary estimate and disclose it", reason: `No contact could be reached at ${counterparty.name}. Estimate the category from spend or average data, state the basis, and find a contact before next period.`, due: true, overdue: false };
    case "identified":
      return { action: "Send the data request", reason: `${counterparty.name} has not been asked for ${e.reportingYear} data.`, due: true, overdue: false };
  }
}

/* ------------------------------------------------------------------ */
/* the request                                                         */
/* ------------------------------------------------------------------ */

export interface RequestDraft {
  subject: string;
  body: string;
}

/**
 * A plain request a consultant can paste into an email. It asks for the
 * minimum, an annual GHG report, says exactly what that must contain to be
 * usable, and offers the activity ledger as the fallback with the portal's
 * template. Nothing is sent from here.
 */
export function draftRequest(counterparty: CounterpartyRecord, reportingYear: number, opts: { ask?: Ask; dueOn?: string; clientName?: string } = {}): RequestDraft {
  const ask = opts.ask ?? counterparty.ask;
  const client = opts.clientName ?? "[client name]";
  const cats = counterparty.ghgCategories.map(categoryLabel);
  const to = counterparty.contactName ? `Dear ${counterparty.contactName},` : "Dear sustainability or account contact,";
  const deadline = opts.dueOn ? `We need this by ${opts.dueOn}.` : "Please let us know when you can provide it.";

  const report = [
    `1. Your annual greenhouse gas report for ${reportingYear} (or the financial year closest to it), giving:`,
    "   - Scope 1, Scope 2 (location-based and, if you report it, market-based) and Scope 3 emissions in tCO2e;",
    "   - the organisational boundary (operational control, financial control or equity share) and the methodology (GHG Protocol, ISO 14064 or VSME);",
    "   - whether the figures were assured, and by whom;",
    `   - your total revenue for the same period, so that ${client}'s share can be calculated; or, if you can, the share of your emissions attributable to ${client} directly.`,
  ];
  const ledger = [
    `${ask === "activity_ledger" ? "1" : "2"}. ${ask === "activity_ledger" ? "An" : "If no report exists, an"} activity ledger for ${reportingYear}: one line per activity and period (electricity and gas in kWh, fuel in litres, transport in km or tonne-km, waste in tonnes by route), with the share of each line that relates to work for ${client}. A CSV template is attached; the portal converts each line with the published UK Government (DESNZ) conversion factors.`,
  ];
  const items = ask === "annual_ghg_report" ? [...report, ...ledger.map((l) => l.replace(/^2\. If no report exists/, "2. Only if no report exists"))] : ask === "activity_ledger" ? ledger : [...report, ...ledger];

  const body = [
    to,
    "",
    `${client} is measuring its Scope 3 emissions under the GHG Protocol and ${counterparty.name} is one of the counterparties whose emissions fall within ${cats.length === 1 ? cats[0] : `${cats.slice(0, -1).join(", ")} and ${cats[cats.length - 1]}`}. We would be grateful for the following.`,
    "",
    ...items,
    "",
    deadline,
    "",
    `Anything you send is used only to calculate ${client}'s Scope 3 inventory and is held under the confidentiality basis you state. If you already publish a sustainability report covering ${reportingYear}, a link and the page reference is enough for item 1.`,
    "",
    "With thanks,",
  ].join("\n");

  return { subject: `${client}: request for ${reportingYear} greenhouse gas data from ${counterparty.name}`, body };
}
