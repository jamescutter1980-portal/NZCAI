/**
 * MOSL trading parties in England's non-household water retail market.
 *
 * Sourced from https://mosl.co.uk/about/our-members (trading party register).
 * Roles follow the MOSL annotations: (W) wholesaler, (R) retailer, (NAV) new
 * appointment and variation. Self-supply names are large customers licensed as
 * their own retailer. This list is a static snapshot for portal lookups; it is
 * not a live MOSL feed.
 */

export type MoslRole = "wholesaler" | "retailer" | "nav" | "self_supply" | "third_party";

export interface MoslMember {
  id: string;
  name: string;
  roles: MoslRole[];
  /** Short label shown in UI selects. */
  shortName: string;
  notes?: string;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function member(name: string, roles: MoslRole[], shortName?: string, notes?: string): MoslMember {
  return { id: slug(name), name, roles, shortName: shortName ?? name, notes };
}

/** Snapshot of MOSL members as published on the Our Members page. */
export const MOSL_MEMBERS: MoslMember[] = [
  member("Advanced Water Infrastructure Networks Limited (AWIN)", ["nav", "wholesaler", "retailer"], "AWIN", "NAV wholesaler and retailer"),
  member("Advanced Demand Side Management (ADSM)", ["third_party"], "ADSM"),
  member("Affinity Water", ["wholesaler"], "Affinity Water"),
  member("Albion Eco", ["nav", "wholesaler", "retailer"], "Albion Eco"),
  member("Albion Water", ["nav", "wholesaler", "retailer"], "Albion Water"),
  member("Anglian Water", ["wholesaler"], "Anglian Water"),
  member("Arla Foods", ["self_supply"], "Arla Foods"),
  member("Blackpool Council", ["self_supply"], "Blackpool Council"),
  member("Boots", ["self_supply"], "Boots"),
  member("Bristol Water", ["wholesaler"], "Bristol Water"),
  member("British Telecommunication (BT)", ["self_supply"], "BT"),
  member("Business Stream", ["retailer"], "Business Stream"),
  member("Castle Water", ["retailer"], "Castle Water"),
  member("Coca-Cola (CCEP)", ["self_supply"], "Coca-Cola"),
  member("Clear Business Water", ["retailer"], "Clear Business Water"),
  member("ConservAqua", ["third_party"], "ConservAqua"),
  member("David Lloyd", ["self_supply"], "David Lloyd"),
  member("Dwr Cymru", ["wholesaler", "retailer"], "Dŵr Cymru", "Welsh Water; largely outside the English competitive market"),
  member("Elis", ["self_supply"], "Elis"),
  member("ESP Water Limited", ["nav", "wholesaler"], "ESP Water"),
  member("Everflow", ["retailer"], "Everflow"),
  member("FCC Environment (UK) Ltd", ["self_supply"], "FCC Environment"),
  member("Futamura Chemicals UK", ["self_supply"], "Futamura"),
  member("Greene King", ["self_supply"], "Greene King"),
  member("Hafren Dyfrdwy", ["wholesaler", "retailer"], "Hafren Dyfrdwy"),
  member("Heineken UK", ["self_supply"], "Heineken UK"),
  member("Last Mile Water", ["nav", "wholesaler", "retailer"], "Last Mile Water", "Previously ICOSA Water"),
  member("Independent Water Networks Ltd", ["nav", "wholesaler", "retailer"], "IWNL"),
  member("Indevor Water Limited", ["nav", "wholesaler"], "Indevor Water"),
  member("InterGen UK Ltd", ["self_supply"], "InterGen"),
  member("John Lewis", ["self_supply"], "John Lewis"),
  member("Kellogg's", ["self_supply"], "Kellogg's"),
  member("LEEP", ["nav", "wholesaler", "retailer"], "LEEP"),
  member("Marston's", ["self_supply"], "Marston's"),
  member("Matrix Water", ["nav", "wholesaler"], "Matrix Water"),
  member("Mitie Waste & Environmental Services Limited", ["self_supply"], "Mitie"),
  member("MUA Water Limited", ["nav", "wholesaler"], "MUA Water"),
  member("Northumbrian Water (NWL)", ["wholesaler"], "Northumbrian Water"),
  member("Nottingham City Council", ["self_supply"], "Nottingham City Council"),
  member("Pennon Water", ["retailer"], "Pennon Water"),
  member("Portsmouth Water", ["wholesaler"], "Portsmouth Water"),
  member("Pozitive Water Limited", ["retailer"], "Pozitive Water"),
  member("Sainsbury's", ["self_supply"], "Sainsbury's"),
  member("Sefton Council", ["self_supply"], "Sefton Council"),
  member("Severn Trent Services", ["nav"], "Severn Trent Services"),
  member("Severn Trent Water", ["wholesaler"], "Severn Trent"),
  member("Simpli Water Ltd", ["retailer"], "Simpli Water"),
  member("Smarta Water", ["retailer"], "Smarta Water"),
  member("South Staffordshire Water", ["wholesaler"], "South Staffs Water"),
  member("South West Water", ["wholesaler"], "South West Water"),
  member("Sutton and East Surrey Water", ["wholesaler"], "SES Water"),
  member("Southern Water", ["wholesaler"], "Southern Water"),
  member("South East Water", ["wholesaler"], "South East Water"),
  member("Stonegate Pub", ["self_supply"], "Stonegate"),
  member("Sutton and East Surrey Water Services", ["retailer"], "SES Water Services"),
  member("Thames Water", ["wholesaler"], "Thames Water"),
  member("The Water Retail Company (TWRC)", ["retailer"], "TWRC"),
  member("United Utilities Water", ["wholesaler"], "United Utilities"),
  member("Veolia Water Retail Limited", ["retailer"], "Veolia Water Retail"),
  member("Veolia Water Projects", ["nav", "wholesaler"], "Veolia Water Projects"),
  member("Water 2 Business", ["retailer"], "Water 2 Business"),
  member("Water Plus", ["retailer"], "Water Plus"),
  member("Waterscan", ["third_party"], "Waterscan"),
  member("Wave", ["retailer"], "Wave"),
  member("Wessex Water", ["wholesaler"], "Wessex Water"),
  member("Whitbread", ["self_supply"], "Whitbread"),
];

export const MOSL_MEMBERS_SOURCE = {
  url: "https://mosl.co.uk/about/our-members",
  label: "MOSL Our Members",
  territory: "England (non-household retail market)",
  caveat:
    "Scotland is operated by CMA Scotland; Wales is largely outside the English competitive market. Household water is not part of MOSL.",
};

export function listMembers(filter: { role?: MoslRole; q?: string } = {}): MoslMember[] {
  const q = filter.q?.trim().toLowerCase();
  return MOSL_MEMBERS.filter((m) => {
    if (filter.role && !m.roles.includes(filter.role)) return false;
    if (!q) return true;
    return m.name.toLowerCase().includes(q) || m.shortName.toLowerCase().includes(q) || m.id.includes(q);
  });
}

export function getMember(id: string): MoslMember | undefined {
  return MOSL_MEMBERS.find((m) => m.id === id);
}

export function retailers(): MoslMember[] {
  return listMembers({ role: "retailer" }).concat(listMembers({ role: "self_supply" }));
}

export function wholesalers(): MoslMember[] {
  return listMembers({ role: "wholesaler" });
}
