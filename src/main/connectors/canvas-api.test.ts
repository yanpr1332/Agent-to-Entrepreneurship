import { describe, expect, it, vi } from "vitest";
import { CanvasApi, nextCanvasPage, validateCanvasInstance } from "./canvas-api";

describe("Canvas instance safety", () => {
  it("normalizes public HTTPS roots", () => {
    expect(validateCanvasInstance(" https://oc.sjtu.edu.cn/ ")).toBe("https://oc.sjtu.edu.cn");
    expect(validateCanvasInstance("https://canvas.example.edu")).toBe("https://canvas.example.edu");
  });

  it.each([
    "http://oc.sjtu.edu.cn", "https://localhost", "https://127.0.0.1",
    "https://192.168.1.8", "https://campus.internal", "https://campus.local",
    "https://user:pass@canvas.example.edu", "https://canvas.example.edu:8443",
    "https://canvas.example.edu/api", "https://canvas.example.edu?access_token=secret",
  ])("rejects unsafe destinations: %s", (value) => {
    expect(() => validateCanvasInstance(value)).toThrow();
  });
});

describe("Canvas REST API", () => {
  it("extracts next page from a Canvas Link header", () => {
    expect(nextCanvasPage('<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"'))
      .toBe("https://canvas.example.edu/api/v1/courses?page=2");
    expect(nextCanvasPage('<https://canvas.example.edu/api/v1/courses?page=1>; rel="current"'))
      .toBeNull();
  });

  it("lists courses across pages with Bearer auth, no redirects, no token in URL", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).not.toContain("demo-secret");
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer demo-secret");
      if (url.includes("page=2")) {
        return new Response(JSON.stringify([{ id: 11, name: "线性代数" }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 10, name: "计算机科学", course_code: "CS101" }]), {
        status: 200,
        headers: { link: '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"' },
      });
    });
    const courses = await new CanvasApi("https://canvas.example.edu", "demo-secret", fetcher).listCourses();
    expect(courses).toHaveLength(2);
    expect(courses[1].name).toBe("线性代数");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks cross-origin pagination instead of forwarding credentials", async () => {
    const fetcher = vi.fn(async () =>
      new Response("[]", { status: 200, headers: {
        link: '<https://evil.example/api/v1/courses>; rel="next"',
      }}));
    const client = new CanvasApi("https://canvas.example.edu", "demo-secret", fetcher);
    await expect(client.listCourses()).rejects.toThrow("unsafe pagination");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps real-style assignment data without trusting external HTML links", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([
        { id: 33, name: "Homework 3", due_at: "2026-11-25T12:00:00Z",
          points_possible: 100, html_url: "https://canvas.example.edu/courses/7/assignments/33" },
        { id: 34, name: "Homework 4", html_url: "https://evil.example/redirect" },
      ]), { status: 200 }));
    const rows = await new CanvasApi("https://canvas.example.edu", "secret", fetcher).listAssignments(7);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 33, courseId: 7, name: "Homework 3", pointsPossible: 100 });
    expect(rows[1].htmlUrl).toBeNull();
    await expect(new CanvasApi("https://canvas.example.edu", "secret").listAssignments(-1)).rejects.toThrow("Invalid Canvas course identifier");
  });

  it("never passes through raw HTTP errors or response bodies containing secrets", async () => {
    const fetcher = vi.fn(async () => new Response("private text", { status: 403 }));
    await expect(new CanvasApi("https://canvas.example.edu", "secret", fetcher).listCourses())
      .rejects.toThrow("Canvas access denied");
  });
});
