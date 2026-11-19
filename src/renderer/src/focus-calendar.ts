import type { FocusSession } from "../../shared/local-model";
import { localDateKey } from "./calendar";

export interface FocusCalendarSegment {
  id: string;
  sessionId: string;
  day: string;
  title: string;
  startMinute: number;
  durationMinutes: number;
  completed: boolean;
  elapsedSeconds: number;
}

/**
 * Expand recorded wall-clock focus periods across local midnight for calendar
 * display. Legacy sessions have estimated bounds, so they stay in history only.
 * A segment's clock span is NOT the amount of effective focus (pauses excluded).
 */
export function focusCalendarSegments(sessions: readonly FocusSession[]): FocusCalendarSegment[] {
  const segments: FocusCalendarSegment[] = [];
  for (const session of sessions) {
    if (session.timeSource !== "recorded" || session.elapsedSeconds <= 0) continue;
    const start = Date.parse(session.startedAt);
    const end = Date.parse(session.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) ||
        end <= start || end - start > 48 * 3600000) continue;
    let cursor = start;
    // 48 wall-clock hours can cross at most four local dates.
    for (let part = 0; cursor < end && part < 4; part++) {
      const current = new Date(cursor);
      const day = localDateKey(current);
      const midnight = new Date(current.getFullYear(),current.getMonth(),current.getDate()+1).getTime();
      const boundary = Math.min(end, midnight);
      if (boundary <= cursor) break;
      const endDate = new Date(boundary);
      const startMinute = current.getHours() * 60 + current.getMinutes();
      const endMinute = boundary === midnight ? 1440 :
        endDate.getHours() * 60 + endDate.getMinutes() +
        Number(endDate.getSeconds() > 0 || endDate.getMilliseconds() > 0);
      // An OS DST transition can make wall-clock minutes nonmonotonic.
      // Display a minimum one-minute marker instead of a negative interval.
      const durationMinutes = Math.max(1, Math.min(1440, endMinute) - startMinute);
      segments.push({
        id: session.id + ":" + day, sessionId: session.id, day,
        title: session.title, startMinute, durationMinutes,
        completed: session.completed, elapsedSeconds: session.elapsedSeconds,
      });
      cursor = boundary;
    }
  }
  return segments;
}
