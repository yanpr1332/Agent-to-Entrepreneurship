import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "./renderer-trust";

describe("renderer URL trust boundary", () => {
  const packaged = "file:///Applications/AtE.app/Contents/Resources/app.asar/out/renderer/index.html";

  it("accepts only the exact packaged renderer entry", () => {
    expect(isTrustedRendererUrl(packaged, packaged)).toBe(true);
    expect(isTrustedRendererUrl("file:///tmp/attacker/index.html", packaged)).toBe(false);
    expect(isTrustedRendererUrl("file:///Applications/AtE.app/other.html", packaged)).toBe(false);
  });

  it("accepts only the configured development origin and entry path", () => {
    const dev = "http://localhost:5173/";
    expect(isTrustedRendererUrl(dev, packaged, dev)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173/attacker", packaged, dev)).toBe(false);
    expect(isTrustedRendererUrl("http://evil.example/", packaged, dev)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isTrustedRendererUrl("not a url", packaged)).toBe(false);
  });
});
