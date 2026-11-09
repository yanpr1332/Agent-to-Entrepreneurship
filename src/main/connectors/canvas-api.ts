import { isIP } from "node:net";
import type { CanvasAssignment, CanvasCourse } from "../../shared/canvas-model";
import { parseCanvasCourseId } from "../../shared/canvas-model";

const MAX_PAGES = 20;
const MAX_ITEMS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A Canvas instance must be a public HTTPS hostname.
 * This avoids token-bearing requests to local/private-network and HTTP endpoints.
 * It is still a defense-in-depth check, not a complete DNS-rebinding defense.
 */
export function validateCanvasInstance(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Please enter a valid Canvas HTTPS address");
  }

  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !host.includes(".") ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Canvas must be a public HTTPS instance root, such as https://oc.sjtu.edu.cn");
  }
  return url.origin;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function cleanLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safePositiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseCourses(value: unknown[]): CanvasCourse[] {
  return value.flatMap((value) => {
    const row = asRecord(value);
    const id = row && safePositiveId(row.id);
    if (!id) return [];
    return [{
      id,
      name: cleanLabel(row!.name, `课程 ${id}`),
      courseCode: cleanLabel(row!.course_code, ""),
    }];
  });
}

function parseAssignments(value: unknown[], courseId: number, origin: string): CanvasAssignment[] {
  return value.flatMap((value) => {
    const row = asRecord(value);
    const id = row && safePositiveId(row.id);
    if (!id) return [];
    const dueAt = typeof row!.due_at === "string" &&
      Number.isFinite(Date.parse(row!.due_at)) ? row!.due_at : null;
    let htmlUrl: string | null = null;
    if (typeof row!.html_url === "string") {
      try {
        const link = new URL(row!.html_url);
        if (link.protocol === "https:" && link.origin === origin) htmlUrl = link.href;
      } catch {
        // An untrusted link must not be exposed as a navigation target.
      }
    }
    return [{
      id, courseId,
      name: cleanLabel(row!.name, `作业 ${id}`),
      dueAt, htmlUrl,
      pointsPossible: typeof row!.points_possible === "number" &&
        Number.isFinite(row!.points_possible) ? row!.points_possible : null,
    }];
  });
}

/** Extract rel=next without evaluating or trusting URLs from a remote Link header. */
export function nextCanvasPage(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(",")) {
    if (/;\s*rel\s*=\s*["']?next["']?(?:\s*;|\s*$)/i.test(segment)) {
      const match = segment.match(/^\s*<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
}

/** Read-only Canvas REST client. Token never enters a URL or a renderer response. */
export class CanvasApi {
  readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.origin = validateCanvasInstance(baseUrl);
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error("Invalid Canvas access token");
    }
  }

  private validatePageUrl(candidate: string): string {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("Canvas returned an invalid pagination URL");
    }
    if (url.origin !== this.origin || !url.pathname.startsWith("/api/v1/") ||
        url.username || url.password || url.hash ||
        url.searchParams.has("access_token")) {
      throw new Error("Canvas returned an unsafe pagination URL");
    }
    return url.href;
  }

  private async requestPages(path: string): Promise<unknown[]> {
    let next: string | null = this.validatePageUrl(new URL(path, this.origin).href);
    const visited = new Set<string>();
    const items: unknown[] = [];

    while (next && visited.size < MAX_PAGES) {
      if (visited.has(next)) throw new Error("Canvas pagination loop detected");
      visited.add(next);

      const response = await this.fetcher(next, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401) throw new Error("Canvas token is invalid or expired");
      if (response.status === 403) throw new Error("Canvas access denied. Check account permissions and rate limits");
      if (response.status === 429) throw new Error("Canvas rate limit reached; try again later");
      if (!response.ok) throw new Error(`Canvas request failed (HTTP ${response.status})`);

      const body = await response.text();
      if (body.length > 2_000_000) throw new Error("Canvas response is too large");
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Error("Canvas returned invalid JSON"); }
      if (!Array.isArray(parsed)) throw new Error("Canvas returned an unexpected API response");
      items.push(...parsed);
      if (items.length > MAX_ITEMS) throw new Error("Canvas result exceeds the safe item limit");

      const link = nextCanvasPage(response.headers.get("link"));
      next = link ? this.validatePageUrl(link) : null;
    }
    if (next) throw new Error("Canvas result is too large to load at once");
    return items;
  }

  async listCourses(): Promise<CanvasCourse[]> {
    const rows = await this.requestPages("/api/v1/courses?enrollment_state=active&per_page=50");
    return parseCourses(rows);
  }

  async listAssignments(courseIdInput: unknown): Promise<CanvasAssignment[]> {
    const courseId = parseCanvasCourseId(courseIdInput);
    const rows = await this.requestPages(`/api/v1/courses/${courseId}/assignments?per_page=50`);
    return parseAssignments(rows, courseId, this.origin);
  }
}
