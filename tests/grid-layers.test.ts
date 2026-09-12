import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ECR_MEANING,
  STATUS_LABEL,
  TECHNOLOGIES,
  summariseGridLayers,
  technologyColor,
  technologyOf,
  technologySpec,
  type Technology,
} from "../src/lib/site-intel/grid-layers";

/* ---------------------------------------------------------- technologies --- */

describe("ECR technology normalisation", () => {
  test("the common register spellings map", () => {
    assert.equal(technologyOf("Photovoltaic"), "solar");
    assert.equal(technologyOf("Solar PV"), "solar");
    assert.equal(technologyOf("Wind"), "wind");
    assert.equal(technologyOf("Battery Storage"), "storage");
    assert.equal(technologyOf("BESS"), "storage");
    assert.equal(technologyOf("Anaerobic Digestion"), "biomass");
    assert.equal(technologyOf("Landfill Gas"), "biomass");
    assert.equal(technologyOf("Diesel Reciprocating Engine"), "engine");
    assert.equal(technologyOf("CHP"), "engine");
    assert.equal(technologyOf("Hydro"), "hydro");
  });

  test("solar wins where a string names more than one thing", () => {
    // For siting PV, "Solar PV with battery storage" is a solar connection.
    assert.equal(technologyOf("Solar PV with battery storage"), "solar");
  });

  test("hydrogen is not read as hydro", () => {
    assert.notEqual(technologyOf("Hydrogen fuel cell"), "hydro");
  });

  test("unrecognised and absent are different answers", () => {
    // "The register said something we do not recognise" is not "the register
    // said nothing", and a legend that merged them would be wrong.
    assert.equal(technologyOf("Tidal lagoon"), "other");
    assert.equal(technologyOf(null), "unknown");
    assert.equal(technologyOf("   "), "unknown");
  });

  test("every technology has a distinct colour", () => {
    const colors = TECHNOLOGIES.map((t) => t.color);
    assert.equal(new Set(colors).size, colors.length, "two technologies share a colour");
  });

  test("an unknown key throws rather than returning a blank", () => {
    assert.throws(() => technologySpec("made-up" as Technology), /unknown technology/);
    assert.ok(technologyColor("anything at all"));
  });
});

/* ------------------------------------------------------------- statuses --- */

describe("connected and accepted are different facts", () => {
  test("the labels say which is generating", () => {
    assert.match(STATUS_LABEL.connected, /generating/i);
    assert.match(STATUS_LABEL.accepted, /not yet connected/i);
    assert.match(STATUS_LABEL.unknown, /not stated/i);
  });
});

/* -------------------------------------------------------------- meaning --- */

describe("what an ECR entry means", () => {
  test("the sentence says absorbed, not available", () => {
    // The dots are the part of this map most likely to be read as spare
    // capacity, which is close to the opposite of what they are.
    assert.match(ECR_MEANING, /already connected or accepted/i);
    assert.match(ECR_MEANING, /not what is left/i);
    assert.match(ECR_MEANING, /not evidence of available capacity/i);
  });
});

/* -------------------------------------------------------------- coverage --- */

const sub = (over = {}) => ({ lat: 53.5, lng: -1.1, stale: false, hasArea: false, ...over });
const ecr = (over = {}) => ({ lat: 53.5, lng: -1.1, ...over });

describe("grid layer coverage", () => {
  test("counts what is drawn", () => {
    const c = summariseGridLayers({
      substations: [sub(), sub()],
      ecr: [ecr(), ecr(), ecr()],
      method: "supply_area",
    });
    assert.equal(c.substationsDrawn, 2);
    assert.equal(c.ecrDrawn, 3);
    assert.match(c.statement, /2 substations/);
    assert.match(c.statement, /3 register entries/);
  });

  test("a supply area is reported when one exists", () => {
    const c = summariseGridLayers({
      substations: [sub({ hasArea: true })],
      ecr: [],
      method: "supply_area",
    });
    assert.equal(c.supplyAreasDrawn, 1);
    assert.match(c.statement, /1 supply area/);
  });

  test("features the publisher left unplaceable are counted from a separate source", () => {
    // A radius query filters on coordinates, so these can never appear in the
    // result lists. Deriving the count from those lists would give a number
    // that is structurally always zero.
    const c = summariseGridLayers({
      substations: [sub()],
      ecr: [ecr()],
      method: "nearest_by_distance",
      unplaceable: { substations: 3, ecr: 7 },
    });
    assert.equal(c.substationsWithoutPoint, 3);
    assert.equal(c.ecrWithoutPoint, 7);
    assert.match(c.statement, /cannot be placed/);
    assert.match(c.statement, /a radius search cannot see them/);
  });

  test("with nothing unplaceable the note is absent", () => {
    const c = summariseGridLayers({ substations: [sub()], ecr: [ecr()], method: "supply_area" });
    assert.equal(c.substationsWithoutPoint, 0);
    assert.equal(c.ecrWithoutPoint, 0);
    assert.ok(!/cannot be placed/.test(c.statement));
  });

  test("nearest_by_distance carries its warning onto the map", () => {
    // The panel says it; the map has to as well, because someone reading rings
    // around substations will otherwise assume one of them serves the site.
    const c = summariseGridLayers({ substations: [sub()], ecr: [], method: "nearest_by_distance" });
    assert.equal(c.nearestByDistance, true);
    assert.match(c.statement, /nearest by straight line/);
    assert.match(c.statement, /proximity does not mean one would serve it/);
  });

  test("a containing supply area carries no proximity warning", () => {
    const c = summariseGridLayers({ substations: [sub()], ecr: [], method: "supply_area" });
    assert.equal(c.nearestByDistance, false);
    assert.ok(!/nearest by straight line/.test(c.statement));
  });

  test("staleness reaches the map", () => {
    const c = summariseGridLayers({
      substations: [sub({ stale: true })],
      ecr: [],
      method: "supply_area",
    });
    assert.equal(c.anyStale, true);
    assert.match(c.statement, /past the staleness window/);
  });

  test("nothing drawn says so rather than reading as an empty network", () => {
    const c = summariseGridLayers({ substations: [], ecr: [], method: null });
    assert.match(c.statement, /No substation drawn/);
    assert.match(c.statement, /no register entries in range/);
  });
});
