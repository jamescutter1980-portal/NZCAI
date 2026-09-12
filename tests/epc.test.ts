import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  byRecency,
  certificateLineage,
  certificatesByPostcode,
  composeAddress,
  currentCertificate,
  epcAddressRegister,
  parseUprnSource,
  toCertificate,
  uprnTier,
  LEGACY_BASE,
  type EpcCertificate,
  type EpcFetch,
} from "../src/lib/site-intel/epc";

const CREDS = { email: "a@b.c", apiKey: "k" };

function rows(...items: Record<string, unknown>[]) {
  return { rows: items };
}

/** Serves a payload per register, keyed by the path fragment. */
function epcFetch(routes: Record<string, unknown>, status = 200): EpcFetch {
  return async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: status < 400, status, json: async () => routes[key] };
  };
}

const NON_DOM_ROW = {
  "lmk-key": "LMK-001",
  address1: "Unit 3",
  address2: "Carr Hill Industrial Estate",
  address3: "Doncaster",
  postcode: "DN4 8DE",
  uprn: "100050000001",
  "uprn-source": "Address Matched",
  "asset-rating-band": "C",
  "asset-rating": 58,
  "floor-area": 1430.75,
  "inspection-date": "2024-06-11",
  "lodgement-date": "2024-06-20",
  "building-level": "3",
};

function cert(over: Partial<EpcCertificate> = {}): EpcCertificate {
  return {
    lmkKey: "LMK-001",
    register: "non-domestic",
    address: "Unit 3, Carr Hill Industrial Estate, Doncaster",
    postcode: "DN4 8DE",
    uprn: "100050000001",
    uprnSource: "address_matched",
    rating: "C",
    assetRating: 58,
    floorAreaM2: 1430.75,
    inspectionDate: "2024-06-11",
    lodgementDate: "2024-06-20",
    propertyType: null,
    buildingReference: null,
    ...over,
  };
}

/* ----------------------------------------------------------- UPRN source --- */

describe("UPRN provenance", () => {
  test("distinguishes an address-matched UPRN from an assessor-entered one", () => {
    assert.equal(parseUprnSource("Address Matched"), "address_matched");
    assert.equal(parseUprnSource("address matched"), "address_matched");
    assert.equal(parseUprnSource("Energy Assessor"), "energy_assessor");
  });

  test("an unrecognised source is unknown, not assumed authoritative", () => {
    assert.equal(parseUprnSource("something else"), "unknown");
    assert.equal(parseUprnSource(null), "unknown");
  });

  test("only an address-matched UPRN is register-grade", () => {
    // An assessor typing a UPRN into assessment software is useful but is not
    // the same thing as the register matching it.
    assert.equal(uprnTier("address_matched"), "T1");
    assert.equal(uprnTier("energy_assessor"), "T3");
    assert.equal(uprnTier("unknown"), "T3");
  });

  test("lineage carries the tier and names the source", () => {
    const matched = certificateLineage(cert());
    assert.equal(matched.tier, "T1");
    assert.match(matched.method, /UPRN source address matched/);

    const assessor = certificateLineage(cert({ uprnSource: "energy_assessor" }));
    assert.equal(assessor.tier, "T3");

    const none = certificateLineage(cert({ uprn: null, uprnSource: "none" }));
    assert.equal(none.tier, "T2", "no UPRN is a certificate without an identifier");
  });
});

/* -------------------------------------------------------------- parsing --- */

describe("certificate parsing", () => {
  test("joins the address columns", () => {
    assert.equal(
      composeAddress(NON_DOM_ROW),
      "Unit 3, Carr Hill Industrial Estate, Doncaster",
    );
  });

  test("drops blanks and duplicate address lines", () => {
    assert.equal(
      composeAddress({ address1: "Unit 3", address2: "unit 3", address3: "" }),
      "Unit 3",
    );
  });

  test("prefers a single address column when the register supplies one", () => {
    assert.equal(composeAddress({ address: "41 Mill Lane", address1: "ignored" }), "41 Mill Lane");
  });

  test("maps a non-domestic row", () => {
    const c = toCertificate(NON_DOM_ROW, "non-domestic");
    assert.ok(c);
    assert.equal(c.lmkKey, "LMK-001");
    assert.equal(c.uprn, "100050000001");
    assert.equal(c.uprnSource, "address_matched");
    assert.equal(c.rating, "C");
    assert.equal(c.assetRating, 58);
    assert.equal(c.floorAreaM2, 1430.75);
    assert.equal(c.postcode, "DN4 8DE");
  });

  test("maps a domestic row, which names its fields differently", () => {
    const c = toCertificate({
      "lmk-key": "LMK-D1",
      address1: "12 Kings Road",
      postcode: "ls12ab",
      "current-energy-rating": "D",
      "total-floor-area": 96.5,
      "inspection-date": "2023-01-09",
      "property-type": "House",
    }, "domestic");
    assert.equal(c?.rating, "D");
    assert.equal(c?.floorAreaM2, 96.5);
    assert.equal(c?.postcode, "LS1 2AB", "postcode is normalised");
    assert.equal(c?.propertyType, "House");
  });

  test("maps a DEC row", () => {
    const c = toCertificate({
      "lmk-key": "LMK-DEC",
      address1: "Civic Offices",
      postcode: "DN1 3BU",
      "operational-rating-band": "E",
      "nominated-date": "2025-03-01",
    }, "display");
    assert.equal(c?.register, "display");
    assert.equal(c?.rating, "E");
    assert.equal(c?.inspectionDate, "2025-03-01");
  });

  test("a row without a certificate key is discarded", () => {
    assert.equal(toCertificate({ address1: "nowhere" }, "domestic"), null);
  });

  test("a row with no UPRN records that, rather than leaving it ambiguous", () => {
    const c = toCertificate({ "lmk-key": "X", postcode: "DN4 8DE" }, "domestic");
    assert.equal(c?.uprn, null);
    assert.equal(c?.uprnSource, "none");
  });
});

/* --------------------------------------------------------------- lookup --- */

describe("postcode lookup", () => {
  test("missing credentials degrade with an explanation, not a throw", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      email: undefined, apiKey: undefined, fetchImpl: epcFetch({}),
    });
    assert.equal(result.certificates.length, 0);
    assert.match(result.unavailable ?? "", /EPC_API_EMAIL and EPC_API_KEY are not set/);
  });

  test("an invalid postcode is rejected before any call", async () => {
    let called = false;
    const result = await certificatesByPostcode("NOT A POSTCODE", {
      ...CREDS,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.match(result.unavailable ?? "", /not a valid UK postcode/);
    assert.equal(called, false);
  });

  test("searches all three registers and merges the results", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS,
      fetchImpl: epcFetch({
        "/non-domestic/": rows(NON_DOM_ROW),
        "/domestic/": rows({ "lmk-key": "LMK-D1", address1: "12 Kings Road", postcode: "DN4 8DE" }),
        "/display/": rows({ "lmk-key": "LMK-DEC", address1: "Civic Offices", postcode: "DN4 8DE" }),
      }),
    });
    assert.equal(result.certificates.length, 3);
    assert.deepEqual(
      result.certificates.map((c) => c.register).sort(),
      ["display", "domestic", "non-domestic"],
    );
    assert.equal(result.unavailable, null);
  });

  test("a 404 means no certificates, which is an answer, not a failure", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS,
      registers: ["non-domestic"],
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    assert.equal(result.certificates.length, 0);
    assert.equal(result.unavailable, null, "404 is not an outage");
  });

  test("a failing register is named, so silence is not mistaken for absence", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS,
      registers: ["non-domestic"],
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    assert.match(result.unavailable ?? "", /non-domestic register did not respond/);
    assert.match(result.unavailable ?? "", /missing rather than absent/);
  });

  test("an unexpected payload shape counts as a failure", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS,
      registers: ["domestic"],
      fetchImpl: epcFetch({ "/domestic/": { unexpected: true } }),
    });
    assert.equal(result.certificates.length, 0);
    assert.match(result.unavailable ?? "", /did not respond/);
  });

  test("a thrown fetch is caught and reported", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS,
      registers: ["domestic"],
      fetchImpl: async () => { throw new Error("socket hang up"); },
    });
    assert.ok(result.unavailable);
  });

  test("reports which host answered, so a migration is visible", async () => {
    const result = await certificatesByPostcode("DN4 8DE", {
      ...CREDS, base: LEGACY_BASE, registers: ["domestic"],
      fetchImpl: epcFetch({ "/domestic/": rows() }),
    });
    assert.equal(result.base, LEGACY_BASE);
  });

  test("sends HTTP Basic auth", async () => {
    let seen: string | undefined;
    await certificatesByPostcode("DN4 8DE", {
      ...CREDS, registers: ["domestic"],
      fetchImpl: async (_url, init) => {
        seen = init?.headers?.authorization;
        return { ok: true, status: 200, json: async () => rows() };
      },
    });
    assert.equal(seen, `Basic ${Buffer.from("a@b.c:k").toString("base64")}`);
  });
});

/* ------------------------------------------------------------ selection --- */

describe("choosing a certificate", () => {
  test("prefers the newest non-domestic assessment", () => {
    const chosen = currentCertificate([
      cert({ lmkKey: "OLD", inspectionDate: "2019-01-01" }),
      cert({ lmkKey: "NEW", inspectionDate: "2024-06-11" }),
      cert({ lmkKey: "DOM", register: "domestic", inspectionDate: "2026-01-01" }),
    ]);
    assert.equal(chosen?.lmkKey, "NEW", "a newer domestic EPC does not displace a commercial one");
  });

  test("falls back to any register when there is no non-domestic certificate", () => {
    const chosen = currentCertificate([
      cert({ lmkKey: "D1", register: "domestic", inspectionDate: "2020-01-01" }),
      cert({ lmkKey: "D2", register: "domestic", inspectionDate: "2024-01-01" }),
    ]);
    assert.equal(chosen?.lmkKey, "D2");
  });

  test("returns null for nothing rather than inventing a certificate", () => {
    assert.equal(currentCertificate([]), null);
  });

  test("byRecency falls back to lodgement when inspection is missing", () => {
    const sorted = [
      cert({ lmkKey: "A", inspectionDate: null, lodgementDate: "2020-01-01" }),
      cert({ lmkKey: "B", inspectionDate: null, lodgementDate: "2025-01-01" }),
    ].sort(byRecency);
    assert.equal(sorted[0].lmkKey, "B");
  });
});

/* ------------------------------------------------------ address register --- */

describe("address register (resolution chain step a)", () => {
  const register = (routes: Record<string, unknown>) =>
    epcAddressRegister({ ...CREDS, fetchImpl: epcFetch(routes) });

  test("resolves an address to a UPRN", async () => {
    const matches = await register({ "/non-domestic/": rows(NON_DOM_ROW) })
      .lookup("Unit 3, Carr Hill Industrial Estate, Doncaster DN4 8DE");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].uprn, "100050000001");
    assert.equal(matches[0].postcode, "DN4 8DE");
  });

  test("an address with no postcode cannot be searched", async () => {
    assert.deepEqual(await register({}).lookup("Somewhere, Doncaster"), []);
  });

  test("certificates without a UPRN are not returned", async () => {
    // Without a UPRN there is nothing for step (b) to look up, so a match would
    // be an address rather than a resolution.
    const matches = await register({
      "/non-domestic/": rows({ ...NON_DOM_ROW, uprn: undefined, "uprn-source": undefined }),
    }).lookup("Unit 3, Carr Hill Industrial Estate, Doncaster DN4 8DE");
    assert.deepEqual(matches, []);
  });

  test("a certificate in the same postcode but a different building is rejected", async () => {
    const matches = await register({
      "/non-domestic/": rows({
        ...NON_DOM_ROW,
        address1: "The Gasworks",
        address2: "Balby Road",
        address3: "",
      }),
    }).lookup("Unit 3, Carr Hill Industrial Estate, Doncaster DN4 8DE");
    assert.deepEqual(matches, []);
  });

  test("a conflicting building number is rejected", async () => {
    const matches = await register({
      "/non-domestic/": rows({ ...NON_DOM_ROW, address1: "Unit 9" }),
    }).lookup("Unit 3, Carr Hill Industrial Estate, Doncaster DN4 8DE");
    assert.deepEqual(matches, []);
  });

  test("best match first when several agree", async () => {
    const matches = await register({
      "/non-domestic/": rows(
        { ...NON_DOM_ROW, "lmk-key": "LOOSE", uprn: "200", address2: "Carr Hill Industrial Estate Doncaster South Yorkshire Extra Words Here" },
        { ...NON_DOM_ROW, "lmk-key": "TIGHT", uprn: "100" },
      ),
    }).lookup("Unit 3, Carr Hill Industrial Estate, Doncaster DN4 8DE");
    assert.equal(matches[0].uprn, "100");
  });

  test("no credentials means no matches, not a crash", async () => {
    const matches = await epcAddressRegister({ email: undefined, apiKey: undefined })
      .lookup("Unit 3, Carr Hill, Doncaster DN4 8DE");
    assert.deepEqual(matches, []);
  });
});
