import { describe, expect, it } from "vitest";
import { cleanDescription, isSolarRelevant, parseFeed, sanitizeXml } from "./rss";

describe("sanitizeXml", () => {
  it("escapes bare ampersands", () => {
    expect(sanitizeXml("a&b &amp; c")).toBe("a&amp;b &amp; c");
  });
});

describe("cleanDescription", () => {
  it("strips tags and truncates", () => {
    const long = `<p>${"word ".repeat(200)}</p>`;
    const cleaned = cleanDescription(long) ?? "";
    expect(cleaned.length).toBeGreaterThan(0);
    expect(cleaned.includes("<")).toBe(false);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});

describe("isSolarRelevant", () => {
  it("matches solar keywords", () => {
    expect(isSolarRelevant("New PV plant", null)).toBe(true);
    expect(isSolarRelevant("Wind only", "no match")).toBe(false);
  });
});

describe("parseFeed", () => {
  it("maps RSS items", () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Hello</title>
          <link>https://example.com/a</link>
          <guid>g1</guid>
          <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
          <description><![CDATA[<p>Body</p>]]></description>
        </item>
      </channel></rss>`;
    const items = parseFeed(xml, "pv-magazine", "PV Magazine");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Hello");
    expect(items[0]?.link).toBe("https://example.com/a");
  });
});
