import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import { CounterpartyRepository, EmissionsReportRepository, ValueChainRecordNotFoundError } from "./repo";
import { ALLOCATION_METHODS, ASKS, ASSURANCE_LEVELS, BOUNDARIES, METHODOLOGIES, REPORT_BASES, type Ask, type CounterpartyRecord, type SubmissionState } from "./types";

/**
 * A one-time link a counterparty can use to send its own figures in.
 *
 * Two decisions shape this. The token is the only credential, so it is
 * generated with a cryptographic random source, stored as a hash and shown
 * once: a leaked database gives an attacker nothing to replay. And what a
 * counterparty sends never becomes the reported figure on its own — it lands
 * as a submission awaiting review, and somebody on the client side accepts it.
 * Self-service removes the typing, not the judgement.
 */

export const linkCreateSchema = z.object({
  counterpartyId: z.string().uuid(),
  reportingYear: z.number().int().min(1990).max(2100),
  ask: z.enum(ASKS).default("either"),
  /** Days the link stays usable. Kept short because it is a bearer credential. */
  validForDays: z.number().int().min(1).max(180).default(30),
  createdBy: z.string().max(200).optional(),
});
export type LinkCreate = z.infer<typeof linkCreateSchema>;

export interface SubmissionLinkRecord {
  id: string;
  counterpartyId: string;
  reportingYear: number;
  /** The last four characters of the token, so a link can be identified in a list without holding it. */
  tokenHint: string;
  ask: Ask;
  expiresOn: string;
  state: SubmissionState;
  submittedAt?: string;
  submittedPayload?: SubmissionPayload;
  submittedNote?: string;
  acceptedAt?: string;
  acceptedReportId?: string;
  revokedAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a counterparty sends. Deliberately the same shape as the annual report the portal already holds. */
export const submissionPayloadSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope1Tco2e: z.number().min(0).optional(),
  scope2LocationTco2e: z.number().min(0).optional(),
  scope2MarketTco2e: z.number().min(0).optional(),
  scope3Tco2e: z.number().min(0).optional(),
  allocationMethod: z.enum(ALLOCATION_METHODS),
  allocatedTco2e: z.number().min(0).optional(),
  supplierRevenueGbp: z.number().min(0).optional(),
  methodology: z.enum(METHODOLOGIES),
  boundary: z.enum(BOUNDARIES),
  assurance: z.enum(ASSURANCE_LEVELS),
  assuranceProvider: z.string().max(200).optional(),
  basis: z.enum(REPORT_BASES),
  evidence: z.string().max(500).optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().max(200).optional(),
  note: z.string().max(2000).optional(),
});
export type SubmissionPayload = z.infer<typeof submissionPayloadSchema>;

export class SubmissionLinkError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "expired" | "revoked" | "already_used" | "not_submitted",
  ) {
    super(message);
    this.name = "SubmissionLinkError";
  }
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const stamp = (d: Date) => d.toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

interface Row {
  id: string; counterparty_id: string; reporting_year: number; token_hash: string; token_hint: string; ask: string; expires_on: string; state: string;
  submitted_at: string | null; submitted_payload: string | null; submitted_note: string | null; accepted_at: string | null; accepted_report_id: string | null;
  revoked_at: string | null; created_by: string | null; created_at: string; updated_at: string;
}

export class SubmissionLinkRepository {
  constructor(private readonly db: Db) {}

  list(filter: { counterpartyId?: string; reportingYear?: number; state?: SubmissionState } = {}): SubmissionLinkRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.counterpartyId) { clauses.push("counterparty_id = ?"); args.push(filter.counterpartyId); }
    if (filter.reportingYear !== undefined) { clauses.push("reporting_year = ?"); args.push(filter.reportingYear); }
    if (filter.state) { clauses.push("state = ?"); args.push(filter.state); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM supplier_submission_links${where} ORDER BY created_at DESC`).all(...args) as unknown as Row[]).map(fromRow);
  }

  get(id: string): SubmissionLinkRecord | undefined {
    const row = this.db.prepare("SELECT * FROM supplier_submission_links WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * The plain token is returned once and never stored. Callers show it to the
   * person sending the link and then forget it.
   */
  create(input: LinkCreate, now = new Date()): { link: SubmissionLinkRecord; token: string } {
    const counterparty = new CounterpartyRepository(this.db).get(input.counterpartyId);
    if (!counterparty) throw new ValueChainRecordNotFoundError("Counterparty", input.counterpartyId);
    const token = randomBytes(32).toString("base64url");
    const at = stamp(now);
    const expires = new Date(now.getTime() + input.validForDays * 86_400_000).toISOString().slice(0, 10);
    const record: SubmissionLinkRecord = {
      id: randomUUID(),
      counterpartyId: input.counterpartyId,
      reportingYear: input.reportingYear,
      tokenHint: token.slice(-4),
      ask: input.ask,
      expiresOn: expires,
      state: "open",
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO supplier_submission_links (id, counterparty_id, reporting_year, token_hash, token_hint, ask, expires_on, state, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.counterpartyId, record.reportingYear, hashToken(token), record.tokenHint, record.ask, record.expiresOn, record.state, n(record.createdBy), at, at);
    return { link: record, token };
  }

  /**
   * Looks a link up by its token. The comparison is constant-time over the
   * hashes so the lookup does not leak how much of a guess was right.
   */
  findByToken(token: string): SubmissionLinkRecord | undefined {
    const wanted = Buffer.from(hashToken(token), "hex");
    const rows = this.db.prepare("SELECT * FROM supplier_submission_links").all() as unknown as Row[];
    for (const row of rows) {
      const candidate = Buffer.from(row.token_hash, "hex");
      if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return fromRow(row);
    }
    return undefined;
  }

  submit(id: string, payload: SubmissionPayload, now = new Date()): SubmissionLinkRecord {
    const at = stamp(now);
    this.db
      .prepare("UPDATE supplier_submission_links SET state = 'submitted', submitted_at = ?, submitted_payload = ?, submitted_note = ?, updated_at = ? WHERE id = ?")
      .run(at, JSON.stringify(payload), n(payload.note), at, id);
    return this.get(id)!;
  }

  markAccepted(id: string, reportId: string, now = new Date()): SubmissionLinkRecord {
    const at = stamp(now);
    this.db.prepare("UPDATE supplier_submission_links SET state = 'accepted', accepted_at = ?, accepted_report_id = ?, updated_at = ? WHERE id = ?").run(at, reportId, at, id);
    return this.get(id)!;
  }

  markRejected(id: string, now = new Date()): SubmissionLinkRecord {
    const at = stamp(now);
    this.db.prepare("UPDATE supplier_submission_links SET state = 'rejected', updated_at = ? WHERE id = ?").run(at, id);
    return this.get(id)!;
  }

  revoke(id: string, now = new Date()): SubmissionLinkRecord {
    const at = stamp(now);
    this.db.prepare("UPDATE supplier_submission_links SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
    return this.get(id)!;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM supplier_submission_links WHERE id = ?").run(id).changes === 0) throw new ValueChainRecordNotFoundError("Submission link", id);
  }
}

function fromRow(r: Row): SubmissionLinkRecord {
  return {
    id: r.id,
    counterpartyId: r.counterparty_id,
    reportingYear: r.reporting_year,
    tokenHint: r.token_hint,
    ask: r.ask as Ask,
    expiresOn: r.expires_on,
    state: r.state as SubmissionState,
    submittedAt: r.submitted_at ?? undefined,
    submittedPayload: r.submitted_payload ? (JSON.parse(r.submitted_payload) as SubmissionPayload) : undefined,
    submittedNote: r.submitted_note ?? undefined,
    acceptedAt: r.accepted_at ?? undefined,
    acceptedReportId: r.accepted_report_id ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* what a counterparty sees and sends                                  */
/* ------------------------------------------------------------------ */

export interface SubmissionInvitation {
  counterpartyName: string;
  reportingYear: number;
  ask: Ask;
  expiresOn: string;
  state: SubmissionState;
  /** What the client is asking for, in the counterparty's terms. */
  instructions: string[];
  alreadySubmitted: boolean;
}

/**
 * Resolves a token to what the counterparty should see. Throws rather than
 * returning a reason string, so a caller cannot forget to check.
 */
export function openInvitation(db: Db, token: string, today: string): { link: SubmissionLinkRecord; counterparty: CounterpartyRecord; invitation: SubmissionInvitation } {
  const link = new SubmissionLinkRepository(db).findByToken(token);
  if (!link) throw new SubmissionLinkError("This link is not recognised. Ask for a new one.", "not_found");
  if (link.state === "revoked") throw new SubmissionLinkError("This link has been withdrawn. Ask for a new one.", "revoked");
  if (link.state === "accepted") throw new SubmissionLinkError("The figures sent with this link have already been accepted.", "already_used");
  if (link.expiresOn < today) throw new SubmissionLinkError(`This link expired on ${link.expiresOn}. Ask for a new one.`, "expired");

  const counterparty = new CounterpartyRepository(db).get(link.counterpartyId);
  if (!counterparty) throw new SubmissionLinkError("The counterparty this link belongs to no longer exists.", "not_found");

  const instructions =
    link.ask === "activity_ledger"
      ? [
          `Send the activity behind your emissions for ${link.reportingYear}: what was consumed, how much, and in what units.`,
          "State the share of it that relates to the goods or services you supply to us, if it is not all of it.",
          "Name the source of each figure, such as a meter reading, an invoice or a fuel card statement.",
        ]
      : [
          `Send your greenhouse gas figures for ${link.reportingYear}: Scope 1, Scope 2 on both a location and a market basis if you have them, and Scope 3.`,
          "Say how the figure attributable to us is worked out, and on what boundary.",
          "Say whether the figures are measured, calculated or estimated, and whether anyone has assured them.",
          "Give a reference for the document the figures come from, so they can be traced.",
        ];

  return {
    link,
    counterparty,
    invitation: {
      counterpartyName: counterparty.name,
      reportingYear: link.reportingYear,
      ask: link.ask,
      expiresOn: link.expiresOn,
      state: link.state,
      instructions,
      alreadySubmitted: link.state === "submitted",
    },
  };
}

/** Records what the counterparty sent. It is not a reported figure until somebody accepts it. */
export function receiveSubmission(db: Db, token: string, payload: SubmissionPayload, now = new Date()): SubmissionLinkRecord {
  const today = stamp(now).slice(0, 10);
  const { link } = openInvitation(db, token, today);
  return new SubmissionLinkRepository(db).submit(link.id, payload, now);
}

/**
 * Turns a submission into the annual report the value chain engine reads.
 * The client side does this, which is the point: a counterparty can send
 * figures but cannot put them into the client's inventory.
 */
export function acceptSubmission(db: Db, linkId: string, now = new Date()): { link: SubmissionLinkRecord; reportId: string } {
  const repo = new SubmissionLinkRepository(db);
  const link = repo.get(linkId);
  if (!link) throw new ValueChainRecordNotFoundError("Submission link", linkId);
  if (link.state !== "submitted" || !link.submittedPayload) throw new SubmissionLinkError("Nothing has been submitted against this link yet, so there is nothing to accept.", "not_submitted");

  const p = link.submittedPayload;
  const report = new EmissionsReportRepository(db).create(
    {
      counterpartyId: link.counterpartyId,
      reportingYear: link.reportingYear,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      scope1Tco2e: p.scope1Tco2e,
      scope2LocationTco2e: p.scope2LocationTco2e,
      scope2MarketTco2e: p.scope2MarketTco2e,
      scope3Tco2e: p.scope3Tco2e,
      allocationMethod: p.allocationMethod,
      allocatedTco2e: p.allocatedTco2e,
      supplierRevenueGbp: p.supplierRevenueGbp,
      methodology: p.methodology,
      boundary: p.boundary,
      assurance: p.assurance,
      assuranceProvider: p.assuranceProvider,
      basis: p.basis,
      evidence: p.evidence,
      documentDate: p.documentDate,
      notes: [p.note, p.contactName ? `Submitted by ${p.contactName}${p.contactEmail ? ` (${p.contactEmail})` : ""}.` : undefined, `Received through a supplier link on ${link.submittedAt?.slice(0, 10)}.`]
        .filter(Boolean)
        .join(" "),
    },
    now,
  );
  return { link: repo.markAccepted(link.id, report.id, now), reportId: report.id };
}
