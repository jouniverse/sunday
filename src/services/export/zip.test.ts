import { describe, expect, it } from "vitest";
import { buildZip } from "./zip";

describe("buildZip", () => {
  it("produces a ZIP local file header and central directory", () => {
    const bytes = buildZip([
      { name: "a.txt", data: "hello" },
      { name: "b.json", data: "{\"ok\":true}" },
    ]);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("a.txt");
    expect(text).toContain("hello");
    expect(text).toContain("b.json");
  });
});
