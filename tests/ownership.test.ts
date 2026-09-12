import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addressScore,
  addressTokens,
  buildOwnershipResult,
  distinctProprietors,
  matchTitles,
  ADDRESS_MATCH_THRESHOLD,
  type CorporateTitle,
} from "../src/lib/site-intel/ownership";
import {
  activeOfficers,
  activePsc,
  getCompany,
  normaliseCompanyNumber,
  type ChFetch,
} from "../src/lib/site-intel/companies-house";

function title(over: Partial<CorporateTitle> = {}): CorporateTitle {
  return {
    titleNumber: "SYK123456",
    dataset: "ccod",
    tenure: "Freehold",
    propertyAddress: "Unit 3, Carr Hill Industrial Estate, Doncaster",
    postcode: "DN4 8DE",
    district: "DONCASTER",
    county: "SOUTH YORKSHIRE",
    region: "YORKSHIRE AND THE HUMBER",
    multipleAddress: false,
    pricePaid: 1_250_000,
    proprietors: [
      {
        name: "NORTHFIELD ESTATES LIMITED",
        companyNumber: "04182991",
        category: "Limited Company or Public Limited Company",
        address: "12 Kings Road, Leeds LS1 2AB",
        countryIncorporated: null,
      },
    ],
    dateProprietorAdded: "2019-06-11",
    ...over,
  };
}

/* ------------------------------------------------------ address matching --- */

describe("address normalisation", () => {
  test("expands abbreviations so ST and STREET compare equal", () => {
    const a = addressTokens("14 Mill St");
    const b = addressTokens("14 Mill Street");
    assert.equal(addressScore(a, b), 1);
  });

  test("drops noise words that carry no discriminating power", () => {
    const tokens = addressTokens("The Land at Unit 3 Carr Hill");
    assert.ok(!tokens.has("THE"));
    assert.ok(!tokens.has("LAND"));
    assert.ok(!tokens.has("UNIT"));
    assert.ok(tokens.has("CARR"));
    assert.ok(tokens.has("3"));
  });

  test("strips punctuation and case", () => {
    assert.deepEqual(
      [...addressTokens("Unit 3, CARR HILL.")].sort(),
      ["3", "CARR", "HILL"],
    );
  });

  test("an empty address yields no tokens and scores zero", () => {
    assert.equal(addressTokens(null).size, 0);
    assert.equal(addressScore(addressTokens(null), addressTokens("Mill Street")), 0);
  });
});

describe("address scoring", () => {
  test("a short address contained in a longer one still scores well", () => {
    // The common real case: the title describes more than the site does.
    const site = addressTokens("Unit 3 Carr Hill");
    const titleAddr = addressTokens("Unit 3, Carr Hill Industrial Estate, Doncaster, South Yorkshire");
    assert.ok(
      addressScore(site, titleAddr) >= ADDRESS_MATCH_THRESHOLD,
      "containment should survive a much longer title address",
    );
  });

  test("unrelated addresses score far below the threshold", () => {
    const score = addressScore(
      addressTokens("41 Mill Lane, Doncaster"),
      addressTokens("Unit 3, Carr Hill Industrial Estate"),
    );
    assert.ok(score < ADDRESS_MATCH_THRESHOLD, `expected a low score, got ${score}`);
  });

  test("scoring is symmetric", () => {
    const a = addressTokens("Unit 3 Carr Hill");
    const b = addressTokens("Carr Hill Industrial Estate Unit 3 Doncaster");
    assert.equal(addressScore(a, b), addressScore(b, a));
  });
});

/* -------------------------------------------------------------- matching --- */

describe("title matching", () => {
  const site = { address: "Unit 3, Carr Hill Industrial Estate, Doncaster", postcode: "DN4 8DE" };

  test("a matching postcode and address gives the best available quality", () => {
    const [candidate] = matchTitles(site, [title()]);
    assert.equal(candidate.quality, "postcode_and_address");
    assert.ok(candidate.reasons.some((r) => /Postcode DN4 8DE matches/.test(r)));
    assert.ok(candidate.reasons.some((r) => /Address tokens agree/.test(r)));
  });

  test("every match is tier T3 - nothing here is authoritative", () => {
    const [candidate] = matchTitles(site, [title()]);
    assert.equal(candidate.source.tier, "T3");
  });

  test("a different postcode is not a candidate at all", () => {
    assert.equal(matchTitles(site, [title({ postcode: "DN4 8DF" })]).length, 0);
  });

  test("a site with no postcode matches nothing", () => {
    assert.equal(matchTitles({ address: "Unit 3", postcode: null }, [title()]).length, 0);
  });

  test("same postcode but a different address is postcode_only", () => {
    const [candidate] = matchTitles(site, [
      title({ propertyAddress: "The Gasworks, Balby Road, Doncaster" }),
    ]);
    assert.equal(candidate.quality, "postcode_only");
  });

  test("conflicting building numbers prevent an address match", () => {
    const [candidate] = matchTitles(
      { address: "Unit 3, Carr Hill Industrial Estate", postcode: "DN4 8DE" },
      [title({ propertyAddress: "Unit 7, Carr Hill Industrial Estate" })],
    );
    assert.equal(candidate.quality, "postcode_only");
    assert.ok(candidate.reasons.some((r) => /Building numbers disagree/.test(r)));
  });

  test("a multi-address title says so, because it weakens the match", () => {
    const [candidate] = matchTitles(site, [
      title({ titleNumber: "SYK654321", multipleAddress: true }),
    ]);
    assert.ok(candidate.reasons.some((r) => /covers several addresses/.test(r)));
  });

  test("stronger matches are ranked first", () => {
    const ranked = matchTitles(site, [
      title({ titleNumber: "WEAK", propertyAddress: "The Gasworks, Balby Road" }),
      title({ titleNumber: "STRONG" }),
    ]);
    assert.equal(ranked[0].title.titleNumber, "STRONG");
    assert.equal(ranked[1].title.titleNumber, "WEAK");
  });

  test("OCOD titles are matched the same way and keep their dataset", () => {
    const [candidate] = matchTitles(site, [
      title({ titleNumber: "SYK777777", dataset: "ocod" }),
    ]);
    assert.equal(candidate.title.dataset, "ocod");
    assert.equal(candidate.source.sourceId, "hmlr-ocod");
  });
});

/* ---------------------------------------------------------------- result --- */

describe("ownership result", () => {
  const site = { address: "Unit 3, Carr Hill Industrial Estate", postcode: "DN4 8DE" };

  test("is always flagged as inferred from address", () => {
    const result = buildOwnershipResult(site, [title()]);
    assert.equal(result.inferredFromAddress, true);
    assert.match(result.note, /not proof of ownership/);
    assert.match(result.note, /no title number/);
  });

  test("several candidates raise multiple_title_candidates", () => {
    const result = buildOwnershipResult(site, [
      title({ titleNumber: "A" }),
      title({ titleNumber: "B" }),
    ]);
    assert.ok(result.flags.includes("multiple_title_candidates"));
  });

  test("an overseas proprietor is flagged", () => {
    const result = buildOwnershipResult(site, [title({ dataset: "ocod" })]);
    assert.ok(result.flags.includes("overseas_proprietor"));
  });

  test("postcode-only matches are flagged as such", () => {
    const result = buildOwnershipResult(site, [
      title({ propertyAddress: "Somewhere else entirely" }),
    ]);
    assert.ok(result.flags.includes("postcode_only_match"));
  });

  test("no postcode is flagged and yields nothing", () => {
    const result = buildOwnershipResult({ address: "Unit 3", postcode: null }, [title()]);
    assert.ok(result.flags.includes("no_postcode"));
    assert.equal(result.candidates.length, 0);
  });

  test("distinctProprietors deduplicates across titles by company number", () => {
    const shared = title().proprietors[0];
    const result = buildOwnershipResult(site, [
      title({ titleNumber: "A" }),
      title({ titleNumber: "B", proprietors: [shared, { ...shared, name: "OTHER LTD", companyNumber: "09112233" }] }),
    ]);
    const names = distinctProprietors(result).map((p) => p.companyNumber);
    assert.deepEqual(names.sort(), ["04182991", "09112233"]);
  });
});

/* ------------------------------------------------------- companies house --- */

describe("company number normalisation", () => {
  test("zero-pads a plain number to eight characters", () => {
    assert.equal(normaliseCompanyNumber("4182991"), "04182991");
    assert.equal(normaliseCompanyNumber("04182991"), "04182991");
  });

  test("keeps and pads a jurisdiction prefix", () => {
    assert.equal(normaliseCompanyNumber("SC318221"), "SC318221");
    assert.equal(normaliseCompanyNumber("sc18221"), "SC018221");
  });

  test("rejects nonsense rather than guessing", () => {
    assert.equal(normaliseCompanyNumber(null), null);
    assert.equal(normaliseCompanyNumber(""), null);
    assert.equal(normaliseCompanyNumber("not-a-company"), null);
  });
});

describe("Companies House lookup", () => {
  const profileBody = {
    company_name: "NORTHFIELD ESTATES LIMITED",
    company_status: "active",
    type: "ltd",
    date_of_creation: "2001-02-14",
    sic_codes: ["68209"],
    registered_office_address: {
      address_line_1: "12 Kings Road",
      locality: "Leeds",
      postal_code: "LS1 2AB",
      country: "England",
    },
  };

  function chFetch(routes: Record<string, unknown>): ChFetch {
    return async (url: string) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => routes[key] };
    };
  }

  test("a missing API key degrades, it does not throw", async () => {
    const record = await getCompany("04182991", { apiKey: undefined, fetchImpl: chFetch({}) });
    assert.equal(record.profile, null);
    assert.match(record.unavailable ?? "", /COMPANIES_HOUSE_API_KEY is not set/);
  });

  test("builds a profile, officers and PSC", async () => {
    const record = await getCompany("04182991", {
      apiKey: "test",
      fetchImpl: chFetch({
        "/persons-with-significant-control": {
          items: [
            {
              name: "Jane Holder",
              kind: "individual-person-with-significant-control",
              natures_of_control: ["ownership-of-shares-75-to-100-percent"],
              notified_on: "2016-07-01",
            },
            { name: "Former Holder", ceased_on: "2020-01-01", natures_of_control: [] },
          ],
        },
        "/officers": {
          items: [
            { name: "Jane Holder", officer_role: "director", appointed_on: "2001-02-14", nationality: "British" },
            { name: "Past Director", officer_role: "director", resigned_on: "2018-05-02" },
          ],
        },
        "/company/": profileBody,
      }),
    });

    assert.equal(record.profile?.name, "NORTHFIELD ESTATES LIMITED");
    assert.equal(record.profile?.inactive, false);
    assert.equal(record.profile?.registeredAddress, "12 Kings Road, Leeds, LS1 2AB, England");
    assert.deepEqual(record.profile?.sicCodes, ["68209"]);
    assert.equal(record.officers.length, 2);
    assert.equal(activeOfficers(record).length, 1);
    assert.equal(activePsc(record).length, 1);
    assert.equal(activePsc(record)[0].name, "Jane Holder");
    assert.equal(record.unavailable, null);
  });

  test("a dissolved company is marked inactive", async () => {
    const record = await getCompany("04182991", {
      apiKey: "test",
      fetchImpl: chFetch({ "/company/": { ...profileBody, company_status: "dissolved" } }),
    });
    assert.equal(record.profile?.inactive, true);
  });

  test("an unreachable officers list is reported, not passed off as none", async () => {
    const record = await getCompany("04182991", {
      apiKey: "test",
      fetchImpl: chFetch({ "/company/": profileBody }),
    });
    assert.equal(record.officers.length, 0);
    assert.match(record.unavailable ?? "", /Could not retrieve officers/);
  });

  test("an unknown company is reported rather than invented", async () => {
    const record = await getCompany("99999999", {
      apiKey: "test",
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    assert.equal(record.profile, null);
    assert.match(record.unavailable ?? "", /no record for 99999999/);
  });

  test("a thrown fetch is caught, not propagated", async () => {
    const record = await getCompany("04182991", {
      apiKey: "test",
      fetchImpl: async () => { throw new Error("socket hang up"); },
    });
    assert.equal(record.profile, null);
    assert.ok(record.unavailable);
  });
});
