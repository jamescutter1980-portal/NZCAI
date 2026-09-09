import { defineIntegration, type IntegrationDefinition, type IntegrationGroup, type AccessType } from "../framework";
import type { Licence } from "@/lib/provenance";

/**
 * Reference-only entries for sources the roadmap identified that no
 * connector group built: known routes, licences and what the portal would do
 * with them. Each exposes a single "links" operation so the UI stays uniform.
 */

interface Ref {
  id: string;
  name: string;
  group: IntegrationGroup;
  access: AccessType;
  territory: string;
  description: string;
  docsUrl: string;
  attribution: string;
  licence: Licence;
  notes: string[];
  links: { label: string; url: string }[];
}

function ref(r: Ref): IntegrationDefinition {
  return defineIntegration({
    id: r.id,
    name: r.name,
    group: r.group,
    access: r.access,
    territory: r.territory,
    description: r.description,
    docsUrl: r.docsUrl,
    attribution: r.attribution,
    licence: r.licence,
    envVars: [],
    status: "reference_only",
    notes: r.notes,
    operations: [
      {
        id: "links",
        label: "Links and access route",
        description: "Where to obtain this data and what the portal would do with it.",
        params: [],
        async run(_params, ctx) {
          return {
            summary: `${r.name}: ${r.access === "commercial" ? "commercial" : r.access} access. See links.`,
            links: r.links,
            provenance: { source: r.id, dataset: "reference", basis: "not_applicable", licence: r.licence, territory: r.territory, attribution: r.attribution, retrievedAt: ctx.now().toISOString() },
          };
        },
      },
    ],
  });
}

export const referenceDefinitions: IntegrationDefinition[] = [
  ref({
    id: "gresb",
    name: "GRESB",
    group: "company",
    access: "commercial",
    territory: "Global",
    description: "Real estate ESG benchmark. API access depends on the participant's entitlement and supports submission and retrieval workflows for members.",
    docsUrl: "https://www.gresb.com/",
    attribution: "GRESB B.V.",
    licence: "commercial",
    notes: ["Confirm with GRESB which submission and retrieval functions the API exposes for the client's entitlement before building.", "The portal's role is to assemble evidence (energy, water, waste, certifications) that the GRESB Real Estate Assessment asks for; see the gresb-advisory skill for indicator mapping."],
    links: [{ label: "GRESB", url: "https://www.gresb.com/" }],
  }),
  ref({
    id: "hildebrand-glowmarkt",
    name: "Hildebrand Glowmarkt",
    group: "energy",
    access: "authorised",
    territory: "GB",
    description: "Consumer smart-meter data via the DCC with the occupier's consent, using the Bright app account. An alternative to n3rgy for residential portfolios.",
    docsUrl: "https://glowmarkt.com/",
    attribution: "Hildebrand Technology Ltd",
    licence: "consent_based",
    notes: ["Occupier creates a Bright account and consents; the API then serves half-hourly electricity and gas readings.", "Best for residential and small sites where the occupier is engaged; commercial HH meters are better served by Openvolt, Perse or a data collector."],
    links: [{ label: "Glowmarkt API", url: "https://glowmarkt.com/" }],
  }),
  ref({
    id: "ea-water-stressed-areas",
    name: "EA water stressed areas classification",
    group: "flood_water",
    access: "gis",
    territory: "England",
    description: "Environment Agency classification of water company areas as seriously water stressed (2021). Preferable to global water-stress indices for English sites.",
    docsUrl: "https://www.gov.uk/government/publications/water-stressed-areas-2021-classification",
    attribution: "Contains Environment Agency information © Environment Agency and database right; Open Government Licence v3.0.",
    licence: "OGL",
    notes: ["Published as a report with company-area mapping; import the area list and match by water company from the site's SPID or postcode.", "Water stress of the region is distinct from a building's own water consumption."],
    links: [{ label: "Water stressed areas 2021 classification", url: "https://www.gov.uk/government/publications/water-stressed-areas-2021-classification" }],
  }),
  ref({
    id: "heat-network-zoning",
    name: "Heat Networks and Zones Service (England)",
    group: "grid",
    access: "enquiry",
    territory: "England",
    description: "DESNZ zone maps identifying areas where buildings may be required to connect to heat networks. A live policy constraint for plant replacement and new build.",
    docsUrl: "https://www.gov.uk/guidance/heat-networks-delivery-unit",
    attribution: "Department for Energy Security and Net Zero",
    licence: "OGL",
    notes: ["The Heat Networks and Zones Service launched in beta in 2026 with a searchable map, zone dashboard and all-zones list; programmatic access is unconfirmed.", "At minimum, record whether each asset falls inside a designated or candidate zone."],
    links: [{ label: "Heat network zoning", url: "https://www.gov.uk/guidance/heat-networks-delivery-unit" }],
  }),
  ref({
    id: "ena-embedded-capacity-register",
    name: "ENA embedded capacity register and connections data",
    group: "grid",
    access: "download",
    territory: "GB",
    description: "Cross-DNO register of connected and contracted generation and storage above 1 MW, plus connections data. Complements the individual DNO portals.",
    docsUrl: "https://www.energynetworks.org/industry/connecting-to-the-networks/connections-data",
    attribution: "Energy Networks Association and the distribution network operators",
    licence: "open_other",
    notes: ["Each DNO hosts its own register in a common format; the portals in the dno-open-data, nged-connected-data and ssen-data-portal connectors expose them as datasets.", "Northern Ireland (NIE Networks) is not covered by any GB portal."],
    links: [{ label: "ENA connections data", url: "https://www.energynetworks.org/industry/connecting-to-the-networks/connections-data" }],
  }),
  ref({
    id: "mcs-installations",
    name: "MCS installations database",
    group: "solar",
    access: "download",
    territory: "UK",
    description: "Microgeneration Certification Scheme counts and capacity of certified installations by technology and area. Aggregate only; not per property.",
    docsUrl: "https://mcscertified.com/about-the-mcs-data-dashboard/",
    attribution: "MCS Service Company Ltd",
    licence: "restricted",
    notes: ["Use for local uptake context and benchmarking, not for identifying a specific building's installation."],
    links: [{ label: "MCS data dashboard", url: "https://mcscertified.com/about-the-mcs-data-dashboard/" }],
  }),
  ref({
    id: "ea-lidar",
    name: "Environment Agency LIDAR (DEFRA Survey Data)",
    group: "solar",
    access: "download",
    territory: "England",
    description: "1 m and 2 m digital terrain and surface models. Inputs for roof geometry, shading and flood elevation analysis.",
    docsUrl: "https://environment.data.gov.uk/survey",
    attribution: "Contains Environment Agency information © Environment Agency and database right; Open Government Licence v3.0.",
    licence: "OGL",
    notes: ["Tiles are downloaded by area from the DEFRA Survey Data Download service; processing needs a raster toolchain (GDAL) outside this portal.", "Google Solar API provides roof segments directly where coverage exists and is the quicker route for individual buildings."],
    links: [{ label: "DEFRA Survey Data Download", url: "https://environment.data.gov.uk/survey" }],
  }),
  ref({
    id: "devolved-heritage",
    name: "Cadw, Historic Environment Scotland and DfC Historic Environment (NI)",
    group: "identity",
    access: "gis",
    territory: "Wales, Scotland, Northern Ireland",
    description: "Listed building and heritage designations outside England, needed for retrofit constraints and MEES-style exemptions on devolved assets.",
    docsUrl: "https://datamap.gov.wales/",
    attribution: "Cadw (Welsh Government); Historic Environment Scotland; Department for Communities NI",
    licence: "OGL",
    notes: ["Cadw listed buildings are on DataMapWales (WFS/WMS); HES publishes designations via its portal and spatial downloads; NI via the Historic Environment Record of Northern Ireland.", "Build as ArcGIS/WFS point queries using the shared helpers once service URLs are confirmed."],
    links: [
      { label: "DataMapWales", url: "https://datamap.gov.wales/" },
      { label: "Historic Environment Scotland portal", url: "https://portal.historicenvironment.scot/" },
      { label: "Historic Environment Record of NI", url: "https://www.communities-ni.gov.uk/services/historic-environment-record-northern-ireland" },
    ],
  }),
];
