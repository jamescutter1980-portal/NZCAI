import { describe, expect, it } from "vitest";
import { GROUP_LABELS, paramsToSchema } from "../framework";
import { integrations } from "../registry";
import { describeIntegration } from "../service";

describe("integration registry", () => {
  it("has unique ids and valid groups", () => {
    const ids = integrations.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of integrations) {
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(Object.keys(GROUP_LABELS)).toContain(d.group);
      expect(d.attribution.length).toBeGreaterThan(5);
      expect(d.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it("every operation has buildable params and every reference-only source has notes", () => {
    for (const d of integrations) {
      for (const op of d.operations) {
        expect(() => paramsToSchema(op.params)).not.toThrow();
        for (const p of op.params) {
          if (p.type === "select") expect(p.options?.length ?? 0).toBeGreaterThan(0);
        }
      }
      if (d.status === "reference_only") expect((d.notes ?? []).length).toBeGreaterThan(0);
    }
  });

  it("describes without leaking secrets", () => {
    const view = describeIntegration(integrations[0], { SOME_KEY: "secret" });
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});
