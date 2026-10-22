import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  appendStoredThreadEvent,
  archiveThread,
  createEnvironment,
  createThread,
  events,
  findOrCreateProjectByLocalPathSource,
  getEnvironment,
  getStoredProviderSession,
  getThread,
  listPublicProjects,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  noopNotifier,
} from "@bb/db";
import { parseStoredThreadEvent, threadScope } from "@bb/domain";
import {
  importProviderSessionResponseSchema,
  providerSessionsResponseSchema,
} from "@bb/server-contract";
import type { ExperimentalProviderSessionImportResult } from "@get-bb/plugin-sdk/host";
import { importProviderSession } from "../../../src/services/providers/session-import.js";
import { providerSessionTranscriptEvents } from "../../../src/services/providers/session-import-transcript.js";
import { resolveExistingThreadExecutionPlan } from "../../../src/services/threads/thread-execution-plan.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { seedHost, seedHostSession } from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

function answer(): ExperimentalProviderSessionImportResult {
  return {
    session: {
      sourceKey: "opaque-source",
      sourcePath: "/home/me/.pi/agent/sessions/work/session.jsonl",
      sessionId: "native-session",
      cwd: "/work/project/subdir",
      name: "Imported work",
      createdAt: "2026-01-01T12:00:00.000Z",
      modifiedAt: "2026-01-01T12:00:06.000Z",
      messageCount: 4,
      firstMessage: "Solve the problem",
      model: "anthropic/claude-sonnet-4",
      reasoningLevel: "high",
    },
    providerThreadId: "native-resumable-id",
    transcript: [
      {
        id: "user-1",
        timestamp: "2026-01-01T12:00:01.000Z",
        type: "text",
        role: "user",
        text: "Solve the problem",
      },
      {
        id: "image-1",
        timestamp: "2026-01-01T12:00:01.000Z",
        type: "image",
        role: "user",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      },
      {
        id: "reasoning-1",
        timestamp: "2026-01-01T12:00:02.000Z",
        type: "reasoning",
        text: "Think carefully",
      },
      {
        id: "call-1",
        timestamp: "2026-01-01T12:00:03.000Z",
        type: "toolCall",
        toolCallId: "tool-1",
        toolName: "read",
        arguments: { path: "file.ts" },
      },
      {
        id: "result-1",
        timestamp: "2026-01-01T12:00:04.000Z",
        type: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        text: "file contents",
        content: [{ type: "text", text: "file contents" }],
        details: { count: 1 },
        isError: false,
      },
      {
        id: "assistant-1",
        timestamp: "2026-01-01T12:00:05.000Z",
        type: "text",
        role: "assistant",
        text: "Solved",
      },
      {
        id: "system-1",
        timestamp: "2026-01-01T12:00:06.000Z",
        type: "text",
        role: "system",
        text: "Session note",
      },
    ],
  };
}

function connect(
  harness: TestAppHarness,
  imported = answer(),
  hostId = "import-host",
) {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const rpc = registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle(request) {
      if (request.command.type !== "plugin.host.call")
        throw new Error("Unexpected RPC");
      return {
        ok: true,
        result: {
          output:
            request.command.method === "listSessions"
              ? { sessions: [imported.session] }
              : imported,
        },
      };
    },
  });
  return {
    host,
    rpc,
    args: {
      providerId: "pi",
      hostId: host.id,
      sourceKey: imported.session.sourceKey,
    },
  };
}

describe("provider session import", () => {
  it("closes historical turns, preserves tool arguments, and interrupts unfinished tools", () => {
    const imported = answer();
    imported.transcript.push(
      {
        id: "user-2",
        timestamp: "2026-01-01T12:00:07.000Z",
        type: "text",
        role: "user",
        text: "Continue",
      },
      {
        id: "call-2",
        timestamp: "2026-01-01T12:00:08.000Z",
        type: "toolCall",
        toolCallId: "tool-2",
        toolName: "bash",
        arguments: "pwd",
      },
    );
    const converted = providerSessionTranscriptEvents({
      threadId: "thread",
      environmentId: "environment",
      imported,
    });
    expect(
      converted.filter((event) => event.type === "turn/started"),
    ).toHaveLength(2);
    expect(
      converted.filter((event) => event.type === "turn/completed"),
    ).toHaveLength(2);
    expect(
      converted.find(
        (event) =>
          event.type === "item/completed" && event.data.item.id === "tool-1",
      ),
    ).toMatchObject({
      data: { item: { arguments: { path: "file.ts" }, status: "completed" } },
    });
    expect(
      converted.find(
        (event) =>
          event.type === "item/completed" && event.data.item.id === "tool-2",
      ),
    ).toMatchObject({
      createdAt: Date.parse("2026-01-01T12:00:08.000Z"),
      data: { item: { arguments: { input: "pwd" }, status: "interrupted" } },
    });
    expect(
      converted.filter((event) => event.type === "turn/completed").at(-1),
    ).toMatchObject({ data: { status: "interrupted" } });
  });

  it("seeds a resumable identity even when the normalized transcript is empty", () => {
    const imported = answer();
    imported.transcript = [];
    expect(
      providerSessionTranscriptEvents({
        threadId: "thread",
        environmentId: "environment",
        imported,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "thread/identity",
        providerThreadId: imported.providerThreadId,
        createdAt: Date.parse(imported.session.createdAt),
      }),
    ]);
  });

  it("lists through the owning live artifact and imports canonical history into a resumable idle thread", async () => {
    await withTestHarness(async (harness) => {
      const imported = answer();
      const { host, rpc, args } = connect(harness, imported);
      const list = await harness.app.request(
        `/api/v1/system/providers/pi/sessions?hostId=${host.id}`,
      );
      expect(list.status).toBe(200);
      const { sourcePath: _, ...listedSession } = imported.session;
      expect(providerSessionsResponseSchema.parse(await list.json())).toEqual({
        sessions: [listedSession],
      });
      const response = await harness.app.request(
        "/api/v1/system/providers/pi/sessions/import",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostId: host.id, sourceKey: args.sourceKey }),
        },
      );
      expect(response.status).toBe(200);
      const result = importProviderSessionResponseSchema.parse(
        await response.json(),
      );
      expect(result.created).toBe(true);
      const thread = getThread(harness.db, result.threadId)!;
      expect(thread).toMatchObject({
        title: "Imported work",
        providerId: "pi",
        status: "idle",
        visibility: "visible",
        modelOverride: imported.session.model,
        reasoningLevelOverride: "high",
      });
      const environment = getEnvironment(harness.db, thread.environmentId!)!;
      expect(environment).toMatchObject({
        path: imported.session.cwd,
        hostId: host.id,
        status: "ready",
        providerOwnsPath: false,
        environmentProviderId: null,
      });
      expect(listPublicProjects(harness.db)).toHaveLength(1);
      expect(getStoredProviderSession(harness.db, thread.id)).toEqual({
        kind: "owned",
        providerThreadId: imported.providerThreadId,
      });
      const plan = await resolveExistingThreadExecutionPlan(harness.deps, {
        threadId: thread.id,
        input: {},
        executionSource: "client/turn/requested",
      });
      expect(plan.resolvedExecution).toMatchObject({
        model: imported.session.model,
        reasoningLevel: "high",
      });
      const stored = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all();
      const items = stored.filter((row) => row.type.startsWith("item/"));
      expect(items.map((row) => row.createdAt)).toEqual(
        imported.transcript.map((item) => Date.parse(item.timestamp)),
      );
      for (const row of stored)
        expect(() =>
          parseStoredThreadEvent({
            threadId: thread.id,
            type: row.type,
            scope:
              row.scopeKind === "thread"
                ? threadScope()
                : { kind: "turn", turnId: row.turnId! },
            data: JSON.parse(row.data),
          }),
        ).not.toThrow();
      expect(JSON.parse(items[4]!.data).item).toMatchObject({
        id: "tool-1",
        tool: "read",
        status: "completed",
        result: { text: "file contents", details: { count: 1 } },
      });
      expect(JSON.parse(items[1]!.data).item.content).toEqual([
        { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
      ]);
      expect(stored.filter((row) => row.type === "turn/started")).toHaveLength(
        1,
      );
      expect(rpc.requests.map((request) => request.command)).toEqual([
        expect.objectContaining({
          type: "plugin.host.call",
          pluginId: "provider-pi",
          method: "listSessions",
          input: { providerId: "pi" },
          generation:
            harness.deps.pluginHostArtifacts.get("provider-pi")!.generation,
        }),
        expect.objectContaining({
          type: "plugin.host.call",
          pluginId: "provider-pi",
          method: "importSession",
          input: { providerId: "pi", sourceKey: args.sourceKey },
        }),
      ]);
    });
  });

  it("serializes concurrent duplicates and reuses the exact-path project and environment", async () => {
    await withTestHarness(async (harness) => {
      const { args } = connect(harness);
      const project = findOrCreateProjectByLocalPathSource(
        harness.db,
        noopNotifier,
        {
          name: "Existing",
          source: {
            type: "local_path",
            hostId: args.hostId,
            path: answer().session.cwd,
          },
        },
      ).project;
      const environment = createEnvironment(harness.db, noopNotifier, {
        projectId: project.id,
        hostId: args.hostId,
        path: answer().session.cwd,
        providerOwnsPath: false,
        status: "ready",
      });
      const results = await Promise.all([
        importProviderSession(harness.deps, args),
        importProviderSession(harness.deps, args),
      ]);
      expect(results[0]!.threadId).toBe(results[1]!.threadId);
      expect(results.map((result) => result.created).sort()).toEqual([
        false,
        true,
      ]);
      expect(getThread(harness.db, results[0]!.threadId)).toMatchObject({
        projectId: project.id,
        environmentId: environment.id,
      });
      expect(
        listThreadsWithPendingInteractionState(harness.db, {}),
      ).toHaveLength(1);
      expect(harness.db.select().from(events).all()).toHaveLength(10);
    });
  });

  it("returns an existing live BB owner without changing its active state or transcript", async () => {
    await withTestHarness(async (harness) => {
      const { args } = connect(harness);
      const project = findOrCreateProjectByLocalPathSource(
        harness.db,
        noopNotifier,
        {
          name: "Other",
          source: {
            type: "local_path",
            hostId: args.hostId,
            path: "/work/other",
          },
        },
      ).project;
      const environment = createEnvironment(harness.db, noopNotifier, {
        projectId: project.id,
        hostId: args.hostId,
        path: "/work/other",
        providerOwnsPath: false,
        status: "ready",
      });
      const thread = createThread(harness.db, noopNotifier, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "pi",
        status: "active",
      });
      appendStoredThreadEvent(harness.db, noopNotifier, {
        threadId: thread.id,
        providerThreadId: answer().providerThreadId,
        scope: threadScope(),
        type: "thread/identity",
        data: { providerThreadId: answer().providerThreadId },
      });
      expect(await importProviderSession(harness.deps, args)).toEqual({
        threadId: thread.id,
        created: false,
      });
      expect(getThread(harness.db, thread.id)).toEqual(thread);
      expect(listPublicProjects(harness.db)).toHaveLength(1);
      expect(harness.db.select().from(events).all()).toHaveLength(1);
    });
  });

  it("returns the existing import after it is archived", async () => {
    await withTestHarness(async (harness) => {
      const { args } = connect(harness);
      const first = await importProviderSession(harness.deps, args);
      archiveThread(harness.db, noopNotifier, first.threadId);
      await expect(importProviderSession(harness.deps, args)).resolves.toEqual({
        threadId: first.threadId,
        created: false,
      });
    });
  });

  it("creates a fresh resumable import after deletion", async () => {
    await withTestHarness(async (harness) => {
      const { args } = connect(harness);
      const first = await importProviderSession(harness.deps, args);
      markThreadDeleted(harness.db, noopNotifier, {
        threadId: first.threadId,
      });
      const next = await importProviderSession(harness.deps, args);
      expect(next).toMatchObject({ created: true });
      expect(next.threadId).not.toBe(first.threadId);
      expect(getStoredProviderSession(harness.db, next.threadId)).toEqual({
        kind: "owned",
        providerThreadId: answer().providerThreadId,
      });
    });
  });

  it("keeps identities host-local and uses title fallbacks", async () => {
    await withTestHarness(async (harness) => {
      const imported = answer();
      imported.session.name = null;
      imported.session.firstMessage = "";
      const a = connect(harness, imported, "host-a");
      const b = connect(harness, imported, "host-b");
      const first = await importProviderSession(harness.deps, a.args);
      const second = await importProviderSession(harness.deps, b.args);
      expect(first.threadId).not.toBe(second.threadId);
      expect(getThread(harness.db, first.threadId)).toMatchObject({
        title: null,
        titleFallback: "Imported pi session",
      });
      expect(listPublicProjects(harness.db)).toHaveLength(2);
    });
  });

  it("rejects relative cwd, missing providers and unavailable artifacts without persisting", async () => {
    await withTestHarness(async (harness) => {
      const imported = answer();
      imported.session.cwd = "relative/path";
      const { args } = connect(harness, imported);
      await expect(
        importProviderSession(harness.deps, args),
      ).rejects.toMatchObject({ status: 422 });
      imported.session.cwd = "/";
      await expect(
        importProviderSession(harness.deps, args),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        importProviderSession(harness.deps, { ...args, hostId: "missing" }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        importProviderSession(harness.deps, { ...args, providerId: "missing" }),
      ).rejects.toMatchObject({ status: 404 });
      seedHost(harness.deps, { id: "disconnected" });
      await expect(
        importProviderSession(harness.deps, {
          ...args,
          hostId: "disconnected",
        }),
      ).rejects.toMatchObject({ status: 502 });
      harness.deps.pluginHostArtifacts.delete("provider-pi");
      await expect(
        importProviderSession(harness.deps, args),
      ).rejects.toMatchObject({ status: 409 });
      expect(listPublicProjects(harness.db)).toHaveLength(0);
    });
  });

  it("rejects absent host selectors and incompatible existing path environments", async () => {
    await withTestHarness(async (harness) => {
      const { args } = connect(harness);
      const response = await harness.app.request(
        "/api/v1/system/providers/pi/sessions",
      );
      expect(response.status).toBe(400);
      const project = findOrCreateProjectByLocalPathSource(
        harness.db,
        noopNotifier,
        {
          name: "Existing",
          source: {
            type: "local_path",
            hostId: args.hostId,
            path: answer().session.cwd,
          },
        },
      ).project;
      createEnvironment(harness.db, noopNotifier, {
        projectId: project.id,
        hostId: args.hostId,
        path: answer().session.cwd,
        providerOwnsPath: true,
        status: "ready",
      });
      await expect(
        importProviderSession(harness.deps, args),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        listThreadsWithPendingInteractionState(harness.db, {}),
      ).toHaveLength(0);
      expect(harness.db.select().from(events).all()).toHaveLength(0);
    });
  });
});
