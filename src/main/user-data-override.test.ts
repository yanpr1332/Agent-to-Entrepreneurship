import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureUserDataOverride } from "./user-data-override";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ate-user-data-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ATE_USER_DATA_DIR startup override", () => {
  it("leaves Electron's default directory unchanged when not configured", () => {
    const setPath = (value: string) => { throw Error("unexpected: " + value); };
    expect(configureUserDataOverride(undefined, setPath)).toBeNull();
  });

  it("recursively creates a previously missing directory before setPath", () => {
    const path = join(fixture(), "missing", "nested", "userData");
    let selected = "";
    const result = configureUserDataOverride(path, value => {
      expect(existsSync(value)).toBe(true);
      selected = value;
    });
    expect(result).toBe(resolve(path));
    expect(selected).toBe(resolve(path));
  });

  it("accepts a pre-existing directory and does not delete its files", () => {
    const dir = fixture(), file = join(dir, "existing.sqlite");
    writeFileSync(file, "preserve me");
    expect(configureUserDataOverride(dir, () => {})).toBe(dir);
    expect(existsSync(file)).toBe(true);
  });

  it("rejects a blank or inaccessible parent without invoking Electron", () => {
    const root = fixture(), file = join(root, "not-a-directory");
    writeFileSync(file, "keep");
    const calls: string[] = [];
    const setPath = (value: string) => calls.push(value);
    expect(() => configureUserDataOverride("   ", setPath)).toThrow("blank");
    expect(() => configureUserDataOverride(join(file, "nested"), setPath)).toThrow();
    expect(calls).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("propagates a setPath failure rather than pretending the override worked", () => {
    const path = join(fixture(), "new");
    expect(() => configureUserDataOverride(path, () => {
      throw Error("Electron rejected userData path");
    })).toThrow("Electron rejected");
    expect(existsSync(path)).toBe(true);
  });
});
