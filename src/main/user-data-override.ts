import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runs before Electron's ready event. Never changes the default userData path
 * unless the requested directory exists and Electron accepts the override.
 * The caller must stop startup on errors to avoid silently using another DB.
 */
export function configureUserDataOverride(
  rawPath: string | undefined,
  setUserDataPath: (absolutePath: string) => void,
): string | null {
  if (rawPath === undefined) return null;
  if (!rawPath.trim()) throw new Error("ATE_USER_DATA_DIR cannot be blank");
  const directory = resolve(rawPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!statSync(directory).isDirectory()) {
    throw new Error("ATE_USER_DATA_DIR does not refer to a directory");
  }
  setUserDataPath(directory);
  return directory;
}
