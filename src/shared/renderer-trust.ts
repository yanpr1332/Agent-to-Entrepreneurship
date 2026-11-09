/**
 * Exact renderer trust checks shared by the main process and unit tests.
 * In development, only the configured Vite origin and entry path are trusted.
 * In production, only the exact packaged index.html URL is trusted.
 */
export function isTrustedRendererUrl(
  candidate: string,
  expectedFileUrl: string,
  developmentUrl?: string,
): boolean {
  try {
    const actual = new URL(candidate);
    if (developmentUrl) {
      const expected = new URL(developmentUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    }
    return actual.href === new URL(expectedFileUrl).href;
  } catch {
    return false;
  }
}
