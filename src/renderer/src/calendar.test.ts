import { describe, expect, it } from "vitest";
import { formatDueDate, localDateKey, monthCells } from "./calendar";

describe("local calendar", () => {
  it("formats local civil dates without UTC day shifts", () => {
    expect(localDateKey(new Date(2026, 10, 9, 12))).toBe("2026-11-09");
    expect(formatDueDate("2026-11-25")).toBe("2026年11月25日");
  });

  it("produces a six-week calendar starting on Monday", () => {
    const dates = monthCells(2026, 10);
    expect(dates).toHaveLength(42);
    expect(dates[0].key).toBe("2026-10-26");
    expect(dates.some((date) => date.key === "2026-11-25" && date.currentMonth)).toBe(true);
  });
});
