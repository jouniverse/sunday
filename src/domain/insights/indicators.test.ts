import { describe, expect, it } from "vitest";
import { capacityDisagreementPct, latestByEntity, seriesForEntity } from "./indicators";
import type { InsightObservation } from "./types";

const base = {
  indicatorId: "test",
  unit: "GW",
  method: "t",
  source: "t",
  vintage: "2024",
  license: "CC",
};

function obs(entityIso3: string, date: string, value: number): InsightObservation {
  return { ...base, entityIso3, date, value };
}

describe("latestByEntity", () => {
  it("keeps the newest year per country", () => {
    const rows = latestByEntity([
      obs("FIN", "2020", 1),
      obs("FIN", "2023", 3),
      obs("SWE", "2022", 2),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entityIso3 === "FIN")?.value).toBe(3);
  });
});

describe("seriesForEntity", () => {
  it("filters and sorts ascending by date", () => {
    const series = seriesForEntity(
      [obs("FIN", "2022", 2), obs("FIN", "2020", 1), obs("SWE", "2021", 9)],
      "fin",
    );
    expect(series.map((r) => r.date)).toEqual(["2020", "2022"]);
  });
});

describe("capacityDisagreementPct", () => {
  it("returns null when a side is missing", () => {
    expect(capacityDisagreementPct(10, undefined)).toBeNull();
  });
  it("reports relative spread", () => {
    expect(capacityDisagreementPct(100, 80)).toBeCloseTo(20);
  });
});
