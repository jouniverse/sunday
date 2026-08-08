import { describe, expect, it } from "vitest";
import { parseVoltageKv } from "./grid-distance";

describe("parseVoltageKv", () => {
  it("treats large numbers as volts", () => {
    expect(parseVoltageKv("220000")).toBe(220);
    expect(parseVoltageKv(110000)).toBe(110);
  });

  it("keeps small numbers as kV", () => {
    expect(parseVoltageKv("220")).toBe(220);
    expect(parseVoltageKv("66 kV")).toBe(66);
  });

  it("takes the max of semicolon lists", () => {
    expect(parseVoltageKv("110000;220000")).toBe(220);
  });

  it("returns null for empty or junk", () => {
    expect(parseVoltageKv(undefined)).toBeNull();
    expect(parseVoltageKv("")).toBeNull();
    expect(parseVoltageKv("unknown")).toBeNull();
  });
});
