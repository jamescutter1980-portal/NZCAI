import { describe, expect, it } from "vitest";
import { getMember, listMembers, MOSL_MEMBERS, retailers, wholesalers } from "../members";

describe("MOSL members", () => {
  it("includes major wholesalers and retailers from Our Members", () => {
    expect(MOSL_MEMBERS.length).toBeGreaterThan(50);
    expect(getMember("thames-water")?.roles).toContain("wholesaler");
    expect(getMember("wave")?.roles).toContain("retailer");
    expect(getMember("castle-water")?.roles).toContain("retailer");
    expect(wholesalers().some((m) => m.id === "united-utilities-water")).toBe(true);
    expect(retailers().some((m) => m.id === "business-stream")).toBe(true);
  });

  it("filters by role and search", () => {
    expect(listMembers({ role: "nav" }).every((m) => m.roles.includes("nav"))).toBe(true);
    expect(listMembers({ q: "sainsbury" })[0]?.shortName).toBe("Sainsbury's");
  });
});
