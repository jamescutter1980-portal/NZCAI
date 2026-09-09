import type { IntegrationDefinition } from "./framework";
import { definition as n3rgy } from "./n3rgy/definition";
import { definition as postcodesIo } from "./postcodes-io";

/** Every registered data source. Order is display order within a group. */
export const integrations: IntegrationDefinition[] = [postcodesIo, n3rgy];

const byId = new Map(integrations.map((d) => [d.id, d]));

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return byId.get(id);
}
