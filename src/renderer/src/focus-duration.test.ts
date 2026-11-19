import { describe, expect, it } from "vitest";
import { parseFocusMinutes } from "./focus-duration";

describe("custom focus time", () => {
  it("supports every whole minute from 1 to 180", () => {
    for (const value of [1, 2, 15, 25, 50, 90, 180]) {
      expect(parseFocusMinutes(String(value))).toBe(value);
    }
  });
  it("rejects invalid or fractional durations before the timer starts", () => {
    for (const value of ["", "0", "-1", "181", "999", "1.5", "2e2", "1x", " 25 ", "0025"]) {
      expect(parseFocusMinutes(value)).toBeNull();
    }
  });
});
