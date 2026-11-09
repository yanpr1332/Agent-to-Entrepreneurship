import { describe, expect, it, vi } from "vitest";
import { CanvasApi } from "./canvas-api";

describe("Canvas user identity for per-account provenance", () => {
  it("fetches the current account ID over a validated read-only endpoint", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://oc.sjtu.edu.cn/api/v1/users/self");
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer demo-token");
      return new Response(JSON.stringify({ id: 382, name: "Private User" }), { status: 200 });
    });
    expect(await new CanvasApi("https://oc.sjtu.edu.cn", "demo-token", fetcher).getCurrentUserId()).toBe(382);
  });

  it("rejects invalid or unauthorized identity responses", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "not-number" }), { status: 200 }));
    await expect(new CanvasApi("https://oc.sjtu.edu.cn", "token", fetcher).getCurrentUserId())
      .rejects.toThrow("invalid user identifier");
    const denied = vi.fn(async () => new Response("", { status: 403 }));
    await expect(new CanvasApi("https://oc.sjtu.edu.cn", "token", denied).getCurrentUserId())
      .rejects.toThrow("not authorized");
  });
});
