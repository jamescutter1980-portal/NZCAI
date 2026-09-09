import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "jba-flood",
  name: "JBA Risk Management flood maps, scores and API",
  group: "flood_water",
  access: "commercial",
  territory: "Global",
  description: "JBA Risk Management commercial flood hazard data: UK and global flood maps (river, surface water, coastal, groundwater) with depths by return period, JBA Flood Scores and climate change scenarios, delivered through JBA Online Services (JBA Vision viewer, API and WMTS).",
  docsUrl: "https://www.jbarisk.com/products/jba-online-services/",
  attribution: "© JBA Risk Management Ltd. Licensed data; not for redistribution.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access is by licence: JBA Online Services provide an API (flood depths, scores and pricing data per location), a WMTS tile service for GIS/mapping and the JBA Vision web viewer. Credentials and endpoint documentation are issued under contract; none are public, so no client is built here.",
    "Flood Scores combine depth and frequency into a rating from negligible to significant per flood type; depth data are modelled for return periods (e.g. 1 in 20, 100, 200, 1000) and, in the climate change products, for RCP/SSP scenarios and epochs. Report present-day and future scenarios separately.",
    "What the portal would do with the data: a 'flood depth and score at a point' operation returning one row per flood type, return period and scenario, basis 'modelled', licence 'commercial'; used for insurer-grade physical risk in the ESG acquisition assessment and CRREM/TCFD physical risk sections.",
    "The EA (England), SEPA (Scotland), NRW (Wales) and DfI (NI) public flood maps already wired up here are the free alternative for screening; JBA adds depths, consistent UK-wide coverage and global sites.",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain JBA flood data",
      description: "Links to JBA Online Services and products.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "JBA flood depths and scores are licensed through JBA Online Services (API, WMTS, viewer).",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "jba", basis: "not_applicable" }),
          links: [
            { label: "JBA Online Services", url: "https://www.jbarisk.com/products/jba-online-services/" },
            { label: "JBA flood maps", url: "https://www.jbarisk.com/products/flood-maps/" },
            { label: "JBA global flood maps", url: "https://www.jbarisk.com/products/global-flood-maps/" },
          ],
        };
      },
    },
  ],
});
