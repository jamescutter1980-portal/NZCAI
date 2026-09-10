import type { Db } from "@/lib/db/sqlite";
import { TransitionError, transition } from "./lifecycle";
import { CounterpartyRepository, EngagementRepository } from "./repo";
import { STATE_LABELS, type BulkEngagementActionInput, type EngagementRecord } from "./types";

/**
 * A wave: one action recorded against many counterparties in one go, for
 * example "request sent, due 31 March" across every counterparty not yet
 * asked. Each counterparty is handled on its own: a transition its state does
 * not allow is skipped with the reason rather than failing the wave, and the
 * rest go through. Every applied transition writes its audit event.
 */
export interface BulkResult {
  applied: { counterpartyId: string; name: string; engagement: EngagementRecord }[];
  skipped: { counterpartyId: string; name: string; reason: string }[];
}

export function applyBulkAction(db: Db, input: BulkEngagementActionInput, now = new Date()): BulkResult {
  const today = now.toISOString().slice(0, 10);
  const counterparties = new CounterpartyRepository(db);
  const engagements = new EngagementRepository(db);
  const result: BulkResult = { applied: [], skipped: [] };

  const targets = input.counterpartyIds
    ? input.counterpartyIds.map((id) => ({ id, record: counterparties.get(id) }))
    : counterparties.list({ status: "active" }).map((record) => ({ id: record.id, record }));

  for (const { id, record } of targets) {
    if (!record) {
      result.skipped.push({ counterpartyId: id, name: id, reason: "not found" });
      continue;
    }
    const current = engagements.ensure(record.id, input.reportingYear, record.ask, now);
    if (input.inStates && !input.inStates.includes(current.state)) {
      result.skipped.push({ counterpartyId: id, name: record.name, reason: `is ${STATE_LABELS[current.state].toLowerCase()}, not in the states selected` });
      continue;
    }
    try {
      const single = { ...input };
      delete single.counterpartyIds;
      delete single.inStates;
      const next = transition(current, single, today);
      const { engagement } = engagements.applyTransition(current, next, { action: input.action, at: input.on ?? today, channel: input.channel, detail: input.detail, actor: input.actor }, now);
      result.applied.push({ counterpartyId: id, name: record.name, engagement });
    } catch (e) {
      if (e instanceof TransitionError) result.skipped.push({ counterpartyId: id, name: record.name, reason: e.message });
      else throw e;
    }
  }
  return result;
}
