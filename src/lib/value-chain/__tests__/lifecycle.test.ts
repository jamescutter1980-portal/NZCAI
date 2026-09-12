import { describe, expect, it } from "vitest";
import { TransitionError, draftRequest, nextAction, transition, REMINDER_AFTER_DAYS } from "../lifecycle";
import type { CounterpartyRecord, EngagementRecord } from "../types";

const cp: CounterpartyRecord = {
  id: "c1", name: "Bidfood Ltd", roles: ["distributor"], ghgCategories: ["1", "4"], annualValueGbp: 1_000_000, ask: "annual_ghg_report", status: "active",
  contactName: "A Patel", contactEmail: "a@example.com", escalationName: "J Smith", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const eng = (over: Partial<EngagementRecord> = {}): EngagementRecord => ({
  id: "e1", counterpartyId: "c1", reportingYear: 2025, state: "identified", ask: "annual_ghg_report", remindersSent: 0, escalated: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});
const none = { report: false, ledgerLines: 0 };

describe("transition", () => {
  it("walks the happy path from identified to verified", () => {
    let e = eng();
    const step = (action: Parameters<typeof transition>[1]["action"], extra: Record<string, unknown> = {}) => {
      e = { ...e, ...transition(e, { reportingYear: 2025, action, ...extra }, "2026-02-01") };
      return e;
    };
    expect(step("request_sent", { dueOn: "2026-03-31", on: "2026-01-10" })).toMatchObject({ state: "contacted", dueOn: "2026-03-31", lastContactOn: "2026-01-10", remindersSent: 0 });
    expect(step("reminder_sent", { on: "2026-02-01" })).toMatchObject({ state: "contacted", remindersSent: 1, lastContactOn: "2026-02-01" });
    expect(step("reply_received").state).toBe("engaged");
    expect(step("data_received").state).toBe("responding");
    expect(step("data_received", { complete: true }).state).toBe("complete");
    expect(step("verified").state).toBe("verified");
    expect(step("reopened")).toMatchObject({ state: "identified", remindersSent: 0, escalated: false, dueOn: undefined });
  });

  it("refuses moves the state does not allow, naming both", () => {
    expect(() => transition(eng(), { reportingYear: 2025, action: "verified" }, "2026-02-01")).toThrow(TransitionError);
    expect(() => transition(eng(), { reportingYear: 2025, action: "reminder_sent" }, "2026-02-01")).toThrow(/Cannot record "reminder sent" while the engagement is identified/);
    expect(() => transition(eng({ state: "verified" }), { reportingYear: 2025, action: "request_sent" }, "2026-02-01")).toThrow(TransitionError);
  });

  it("records a decline with its reason and lets a fresh request reopen it", () => {
    const declined = { ...eng({ state: "contacted" }), ...transition(eng({ state: "contacted" }), { reportingYear: 2025, action: "declined", declineReason: "vsme_right_to_refuse" }, "2026-02-01") };
    expect(declined).toMatchObject({ state: "declined", declineReason: "vsme_right_to_refuse" });
    const again = transition(declined, { reportingYear: 2025, action: "request_sent", on: "2027-01-05" }, "2027-01-05");
    expect(again).toMatchObject({ state: "contacted", declineReason: undefined, lastContactOn: "2027-01-05" });
  });

  it("keeps the state on a note or an escalation but marks the escalation", () => {
    const e = eng({ state: "contacted", lastContactOn: "2026-01-01", remindersSent: 2 });
    expect(transition(e, { reportingYear: 2025, action: "note", detail: "spoke to A" }, "2026-02-01").state).toBe("contacted");
    expect(transition(e, { reportingYear: 2025, action: "escalated", on: "2026-02-01" }, "2026-02-01")).toMatchObject({ state: "contacted", escalated: true, lastContactOn: "2026-02-01" });
  });
});

describe("nextAction", () => {
  it("asks first when nothing has been sent", () => {
    const a = nextAction(undefined, cp, none, "2026-02-01");
    expect(a).toMatchObject({ action: "Send the data request", due: true, overdue: false });
    expect(a.reason).toMatch(/Annual GHG report/);
  });

  it("waits inside the silence window, then climbs the ladder: reminder, reminder, escalation, final notice", () => {
    const contacted = eng({ state: "contacted", lastContactOn: "2026-01-10", dueOn: "2026-06-30" });
    expect(nextAction(contacted, cp, none, "2026-01-20")).toMatchObject({ action: "Wait for a reply", due: false });
    const later = "2026-01-31"; // REMINDER_AFTER_DAYS after 10 January
    expect(REMINDER_AFTER_DAYS).toBe(21);
    expect(nextAction(contacted, cp, none, later)).toMatchObject({ action: "Send reminder 1", due: true });
    expect(nextAction({ ...contacted, remindersSent: 1 }, cp, none, later)).toMatchObject({ action: "Send reminder 2" });
    expect(nextAction({ ...contacted, remindersSent: 2 }, cp, none, later).action).toBe("Escalate to J Smith");
    expect(nextAction({ ...contacted, remindersSent: 2, escalated: true }, cp, none, later).action).toBe("Send a final notice");
  });

  it("falls back to a secondary estimate once the deadline plus grace has passed with nothing received", () => {
    const e = eng({ state: "contacted", lastContactOn: "2026-01-10", dueOn: "2026-03-31", remindersSent: 2, escalated: true });
    const a = nextAction(e, cp, none, "2026-04-20");
    expect(a).toMatchObject({ action: "Fall back to a secondary estimate and disclose it", due: true, overdue: true });
    expect(a.reason).toMatch(/2026-03-31 deadline passed 20 days ago/);
    // Data arriving cancels the overdue flag.
    expect(nextAction(e, cp, { report: true, ledgerLines: 0 }, "2026-04-20")).toMatchObject({ action: "Record the data as received", overdue: false });
  });

  it("describes the closed states without pretending they are done", () => {
    expect(nextAction(eng({ state: "declined", declineReason: "vsme_right_to_refuse" }), cp, none, "2026-02-01").reason).toMatch(/VSME-only ask/);
    expect(nextAction(eng({ state: "unreachable" }), cp, none, "2026-02-01").action).toMatch(/secondary estimate/);
    expect(nextAction(eng({ state: "verified" }), cp, { report: true, ledgerLines: 0 }, "2026-02-01")).toMatchObject({ action: "Nothing due", due: false });
    expect(nextAction(eng({ state: "verified" }), cp, none, "2026-02-01").due).toBe(true);
    expect(nextAction(eng({ state: "complete" }), cp, { report: true, ledgerLines: 0 }, "2026-02-01").action).toBe("Review and verify the figures");
  });
});

describe("draftRequest", () => {
  it("asks for the annual report first and the ledger only as a fallback", () => {
    const d = draftRequest(cp, 2025, { dueOn: "2026-03-31", clientName: "Welcome Break" });
    expect(d.subject).toBe("Welcome Break: request for 2025 greenhouse gas data from Bidfood Ltd");
    expect(d.body).toMatch(/^Dear A Patel,/);
    expect(d.body).toMatch(/1\. Your annual greenhouse gas report for 2025/);
    expect(d.body).toMatch(/2\. Only if no report exists, an activity ledger/);
    expect(d.body).toMatch(/Category 1 Purchased goods and services and Category 4 Upstream transportation/);
    expect(d.body).toMatch(/We need this by 2026-03-31/);
  });

  it("asks for the ledger alone when that is the ask", () => {
    const d = draftRequest({ ...cp, contactName: undefined }, 2025, { ask: "activity_ledger" });
    expect(d.body).toMatch(/^Dear sustainability or account contact,/);
    expect(d.body).toMatch(/1\. An activity ledger for 2025/);
    expect(d.body).not.toMatch(/annual greenhouse gas report/);
  });
});
