import { describe, expect, it } from "vitest";
import type { FixedEvent } from "./fixed-calendar-model";
import type { LocalTask } from "./local-model";
import {
  parsePersonalSyncOperation, parseSyncOperationResult,
  projectManualCalendarEvent, projectPersonalTask,
} from "./personal-sync-contract";

const owner = "aae9ac05-b37d-4898-aee4-5848fa28e01b";
const another = "9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const operation = {
  operationId: "ca9c6544-371b-41f2-b621-a956b088c7fb",
  deviceId: "6da6f704-5b0c-4e5a-a7dd-dc8db5b4c665",
  actorId: owner, ownerId: owner,
  entityId: "3babcb78-c10d-4f4e-ab3e-f47f6ad72447",
  entityType: "personal-task",
  action: "upsert",
  baseVersion: null,
  clientTimestamp: "2026-11-19T15:30:00.000Z",
  payload: {
    title: "Prepare report",
    description: "Study notes",
    dueDate: "2026-11-25",
    priority: "normal",
    completed: false,
  },
};
const calendarPayload = {
  title: "Advanced algorithms",
  day: "2026-11-25",
  startMinute: 540,
  durationMinutes: 90,
  seriesId: "manual:afe10e9e-a12b-4448-ad9b-9b6d9be19b2a",
};

describe("ALPHA-SYNC-001 strict wire envelope, without enabling sync", () => {
  it("accepts only versioned personal task and manual calendar operations", () => {
    expect(parsePersonalSyncOperation(operation)).toEqual(operation);
    expect(parsePersonalSyncOperation({
      ...operation, entityType: "manual-calendar-event", payload: calendarPayload,
      baseVersion: 7,
    })).toMatchObject({ action: "upsert", entityType: "manual-calendar-event" });
    expect(parsePersonalSyncOperation({
      ...operation, action: "delete", payload: null, baseVersion: 0,
    })).toMatchObject({ action: "delete", payload: null });
  });

  it("rejects unknown keys and personal content that must never sync implicitly", () => {
    expect(() => parsePersonalSyncOperation({...operation, accessToken: "secret"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, payload: {
      ...operation.payload, source: {provider: "canvas"}, privatePath: "/Documents",
    }})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, entityType: "knowledge"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, entityType: "mail"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, entityType: "canvas"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, action: "patch"})).toThrow();
  });

  it("rejects forged identity, bad version, invalid timestamps and inconsistent delete", () => {
    expect(() => parsePersonalSyncOperation({...operation, actorId: another})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, deviceId: "a"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, baseVersion: -1})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, baseVersion: 1.5})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, clientTimestamp: "2026-02-30T15:30:00.000Z"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, clientTimestamp: "2026-11-19"})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, action: "delete", payload: null})).toThrow();
    expect(() => parsePersonalSyncOperation({...operation, action: "delete", baseVersion: 3})).toThrow();
  });

  it("never permits remote calendar series, malformed date or spill past midnight", () => {
    for (const seriesId of ["ics:9", "canvas:1", "manual:not-a-uuid"]) {
      expect(() => parsePersonalSyncOperation({
        ...operation, entityType: "manual-calendar-event",
        payload: {...calendarPayload, seriesId},
      })).toThrow();
    }
    expect(() => parsePersonalSyncOperation({
      ...operation, entityType: "manual-calendar-event",
      payload: {...calendarPayload, day: "2026-02-30"},
    })).toThrow();
    expect(() => parsePersonalSyncOperation({
      ...operation, entityType: "manual-calendar-event",
      payload: {...calendarPayload, startMinute: 1400, durationMinutes: 90},
    })).toThrow();
  });

  it("projects ONLY personal data; filters Canvas and ICS even with valid-looking fields", () => {
    const task: LocalTask = {
      id: operation.entityId, title: "Prepare report", description: "Study notes",
      dueDate: "2026-11-25", priority: "normal", completed: false,
      source: null, visible: true, hiddenAt: null, retentionExpiresAt: null,
      createdAt: "2026-11-19T15:00:00.000Z", updatedAt: "2026-11-19T15:00:00.000Z",
    };
    expect(projectPersonalTask(task)).toEqual(operation.payload);
    expect(projectPersonalTask({...task, visible: false})).toBeNull();
    expect(projectPersonalTask({...task, source: {
      provider: "canvas", instanceUrl: "https://example.instructure.com",
      accountId: 1, courseId: 2, assignmentId: 3,
      sourceUrl: null, lastSyncedAt: "2026-11-19",
    }})).toBeNull();

    const event: FixedEvent = {
      id: operation.entityId, sourceUid: null, seriesId: calendarPayload.seriesId,
      source: "manual", title: calendarPayload.title, day: calendarPayload.day,
      startMinute: calendarPayload.startMinute, durationMinutes: calendarPayload.durationMinutes,
      createdAt: "2026-11-19T15:00:00.000Z",
    };
    expect(projectManualCalendarEvent(event)).toEqual(calendarPayload);
    expect(projectManualCalendarEvent({...event, source: "ics"})).toBeNull();
    expect(projectManualCalendarEvent({...event, sourceUid: "ical-item"})).toBeNull();
  });

  it("only accepts bounded, versioned acknowledgement and opaque cursor", () => {
    expect(parseSyncOperationResult({
      status: "accepted", serverVersion: 1, cursor: "cursor_123",
    })).toEqual({status: "accepted", serverVersion: 1, cursor: "cursor_123"});
    expect(parseSyncOperationResult({
      status: "conflict", serverVersion: 2, cursor: null,
    }).status).toBe("conflict");
    expect(() => parseSyncOperationResult({
      status: "accepted", serverVersion: null, cursor: "x",
    })).toThrow();
    expect(() => parseSyncOperationResult({
      status: "duplicate", serverVersion: 1, cursor: null,
    })).toThrow();
    expect(() => parseSyncOperationResult({
      status: "accepted", serverVersion: 1, cursor: "../../users",
    })).toThrow();
    expect(() => parseSyncOperationResult({
      status: "applied-anyway", serverVersion: 1, cursor: "x",
    })).toThrow();
  });
});
