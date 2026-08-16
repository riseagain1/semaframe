import { describe, expect, it } from "vitest";
import {
  isNormalizedChartTimeseries,
  LocalInlineSourceError,
  normalizeInlineSnapshotResource,
  parseLocalInlineSource,
} from "../../workspace/data";

describe("local inline source parsing", () => {
  it("recognizes normalized stock-like JSON without changing its labels or series", () => {
    const input = {
      labels: ["09:30", "09:31"],
      series: [{ id: "close", label: "Close", values: [188.4, 189.1], color: "#68D5FF" }],
    };
    const parsed = parseLocalInlineSource("json", JSON.stringify(input));
    expect(parsed.kind).toBe("chart_timeseries");
    expect(parsed.data).toEqual(input);
    expect(isNormalizedChartTimeseries(parsed.data)).toBe(true);
    expect(parsed.outputSchema).toMatchObject({
      type: "object",
      required: ["labels", "series"],
    });
  });

  it("converts bounded CSV into chart labels and numeric series", () => {
    const parsed = parseLocalInlineSource("csv", "time,Close,Volume\n09:30,188.4,1200\n\"09:31\",189.1,1400");
    expect(parsed.kind).toBe("chart_timeseries");
    expect(parsed.data).toEqual({
      labels: ["09:30", "09:31"],
      series: [
        { id: "close", label: "Close", values: [188.4, 189.1] },
        { id: "volume", label: "Volume", values: [1200, 1400] },
      ],
    });
  });

  it("infers a closed schema for generic JSON and rejects malformed CSV", () => {
    expect(parseLocalInlineSource("json", '{"quote":{"price":188.4}}')).toMatchObject({
      kind: "generic_json",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["quote"],
      },
    });
    expect(() => parseLocalInlineSource("csv", "time,Close\n09:30,not-a-number")).toThrow(LocalInlineSourceError);
    expect(() => parseLocalInlineSource("json", "")).toThrow(/Paste JSON or CSV/u);
  });

  it("infers a non-branching safe schema for heterogeneous JSON arrays", () => {
    const parsed = parseLocalInlineSource("json", JSON.stringify({
      rows: [
        { id: "one", value: 1 },
        { id: "two", value: "not available" },
        { id: "three", value: null },
      ],
    }));
    expect(JSON.stringify(parsed.outputSchema)).not.toContain("anyOf");
    expect(parsed.outputSchema).toMatchObject({
      properties: {
        rows: {
          items: {
            properties: {
              value: { type: ["null", "number", "string"] },
            },
          },
        },
      },
    });
    expect(() => normalizeInlineSnapshotResource({
      id: "RES_heterogeneous",
      label: "Heterogeneous data",
      connectorType: "inline.snapshot",
      connectorVersion: "1.0.0",
      outputSchema: parsed.outputSchema,
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: parsed.data,
        contentHash: "host-computed",
        retrievedAt: "1970-01-01T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
    }, 1_765_765_323_000)).not.toThrow();
  });
});
