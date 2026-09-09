import type { IntegrationDefinition } from "./framework";
import { definition as n3rgy } from "./n3rgy/definition";
import { definition as postcodesIo } from "./postcodes-io";
import { definition as epcEnglandWales } from "./epc-england-wales";
import { definition as osDataHub } from "./os-data-hub";
import { definition as planningData } from "./planning-data";
import { definition as historicEnglandNhle } from "./historic-england-nhle";
import { definition as landRegistry } from "./land-registry";
import { definition as voaRatingList } from "./voa-rating-list";
import { definition as scottishEpcRegister } from "./scottish-epc-register";
import { definition as osOpenUprn } from "./os-open-uprn";
import { definition as niEpc } from "./ni-epc";

/** Every registered data source. Order is display order within a group. */
export const integrations: IntegrationDefinition[] = [
  // identity
  postcodesIo, epcEnglandWales, osDataHub, planningData, historicEnglandNhle, landRegistry, voaRatingList, scottishEpcRegister, osOpenUprn, niEpc,
  // energy
  n3rgy,
];

const byId = new Map(integrations.map((d) => [d.id, d]));

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return byId.get(id);
}
