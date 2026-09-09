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
import { definition as carbonIntensity } from "./carbon-intensity";
import { definition as elexonInsights } from "./elexon-insights";
import { definition as nesoDataPortal } from "./neso-data-portal";
import { definition as dnoOpenData } from "./dno-open-data";
import { definition as ngedConnectedData } from "./nged-connected-data";
import { definition as ssenDataPortal } from "./ssen-data-portal";
import { definition as nationalGasData } from "./national-gas-data";
import { definition as pvLive } from "./pv-live";
import { definition as octopusEnergy } from "./octopus-energy";
import { definition as openvolt } from "./openvolt";
import { definition as electralinkQuoteright } from "./electralink-quoteright";
import { definition as xoserveGasData } from "./xoserve-gas-data";
import { definition as perse } from "./perse";
import { definition as measurabl } from "./measurabl";
import { definition as openMeteo } from "./open-meteo";
import { definition as metOfficeDatahub } from "./met-office-datahub";
import { definition as degreeDaysNet } from "./degree-days-net";
import { definition as ukhsaWeatherHealthAlerts } from "./ukhsa-weather-health-alerts";
import { definition as ukcp18 } from "./ukcp18";
import { definition as hadukGridCeda } from "./haduk-grid-ceda";
import { definition as copernicusCds } from "./copernicus-cds";
import { definition as pvgis } from "./pvgis";
import { definition as solcast } from "./solcast";
import { definition as googleSolar } from "./google-solar";
import { definition as solaredge } from "./solaredge";
import { definition as enphase } from "./enphase";
import { definition as givenergy } from "./givenergy";
import { definition as desnzConversionFactors } from "./desnz-conversion-factors";
import { definition as aibResidualMix } from "./aib-residual-mix";
import { definition as ofgemRenewableElectricityRegister } from "./ofgem-renewable-electricity-register";
import { definition as climatiq } from "./climatiq";
import { definition as exiobase } from "./exiobase";
import { definition as xeroSpend } from "./xero-spend";
import { definition as quickbooksSpend } from "./quickbooks-spend";
import { definition as crremPathways } from "./crrem-pathways";
import { definition as ukNzcbs } from "./uk-nzcbs";
import { definition as ecoPlatformEcoPortal } from "./eco-platform-eco-portal";
import { definition as okobaudat } from "./okobaudat";
import { definition as ec3BuildingTransparency } from "./ec3-building-transparency";
import { definition as becd } from "./becd";
import { definition as ecoinvent } from "./ecoinvent";

/** Every registered data source. Order is display order within a group. */
export const integrations: IntegrationDefinition[] = [
  // identity
  postcodesIo, epcEnglandWales, osDataHub, planningData, historicEnglandNhle, landRegistry, voaRatingList, scottishEpcRegister, osOpenUprn, niEpc,
  // energy
  n3rgy, octopusEnergy, openvolt, electralinkQuoteright, xoserveGasData, perse, measurabl,
  // grid
  carbonIntensity, elexonInsights, nesoDataPortal, dnoOpenData, ngedConnectedData, ssenDataPortal, nationalGasData,
  // weather
  openMeteo, metOfficeDatahub, degreeDaysNet, ukhsaWeatherHealthAlerts, ukcp18, hadukGridCeda, copernicusCds,
  // solar
  pvgis, pvLive, solcast, googleSolar, solaredge, enphase, givenergy,
  // carbon
  desnzConversionFactors, aibResidualMix, ofgemRenewableElectricityRegister, climatiq, exiobase, xeroSpend, quickbooksSpend,
  // pathways
  crremPathways, ukNzcbs,
  // embodied
  ecoPlatformEcoPortal, okobaudat, ec3BuildingTransparency, becd, ecoinvent,
];

const byId = new Map(integrations.map((d) => [d.id, d]));

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return byId.get(id);
}
