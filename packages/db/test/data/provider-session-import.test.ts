import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendStoredThreadEvent,
  archiveThread,
  createEnvironment,
  createProject,
  createThread,
  getProviderSessionOwnerThread,
  markThreadDeleted,
  markProjectDeleted,
  noopNotifier,
  upsertHost,
} from "../../src/index.js";
import { threadScope } from "@bb/domain";

describe("provider session duplicate lookup", () => {
  it("scopes indexed identity lookup to import owners of the requested provider and host", () => {
    const db = createMigratedConnection();
    try {
      const host = upsertHost(db, noopNotifier, { name: "host" });
      const otherHost = upsertHost(db, noopNotifier, { name: "other-host" });
      const { project } = createProject(db, noopNotifier, {
        name: "project",
        source: { type: "local_path", hostId: host.id, path: "/work" },
      });
      const environment = createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "/work",
        status: "ready",
        providerOwnsPath: false,
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "pi",
        status: "idle",
      });
      const args = {
        providerId: "pi",
        hostId: host.id,
        providerThreadId: "native",
      };
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        scope: threadScope(),
        providerThreadId: "native",
        type: "thread/identity",
        data: { providerThreadId: "native" },
        createdAt: 12345,
      });
      expect(getProviderSessionOwnerThread(db, args)?.id).toBe(thread.id);
      expect(
        getProviderSessionOwnerThread(db, { ...args, providerId: "other" }),
      ).toBeNull();
      expect(
        getProviderSessionOwnerThread(db, { ...args, hostId: otherHost.id }),
      ).toBeNull();
      expect(
        getProviderSessionOwnerThread(db, {
          ...args,
          providerThreadId: "missing",
        }),
      ).toBeNull();
      const plan = db.all(sql`EXPLAIN QUERY PLAN SELECT threads.id FROM threads
        INNER JOIN environments ON environments.id = threads.environment_id
        INNER JOIN projects ON projects.id = threads.project_id
        WHERE threads.id IN (
            SELECT events.thread_id FROM events
            WHERE events.provider_thread_id = ${args.providerThreadId}
              AND events.type = 'thread/identity'
          )
          AND threads.provider_id = ${args.providerId}
          AND environments.host_id = ${args.hostId}
          AND threads.deleted_at IS NULL
          AND projects.deleted_at IS NULL ORDER BY threads.created_at, threads.id LIMIT 1`);
      expect(JSON.stringify(plan)).toContain("events_provider_identity_idx");
      archiveThread(db, noopNotifier, thread.id);
      expect(getProviderSessionOwnerThread(db, args)?.id).toBe(thread.id);
    } finally {
      db.$client.close();
    }
  });

  it.each(["thread", "project"] as const)(
    "excludes soft-deleted %s owners",
    (kind) => {
      const db = createMigratedConnection();
      try {
        const host = upsertHost(db, noopNotifier, { name: "host" });
        const { project } = createProject(db, noopNotifier, {
          name: "project",
          source: { type: "local_path", hostId: host.id, path: "/work" },
        });
        const environment = createEnvironment(db, noopNotifier, {
          projectId: project.id,
          hostId: host.id,
          path: "/work",
          status: "ready",
          providerOwnsPath: false,
        });
        const thread = createThread(db, noopNotifier, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "pi",
        });
        appendStoredThreadEvent(db, noopNotifier, {
          threadId: thread.id,
          scope: threadScope(),
          providerThreadId: "native",
          type: "thread/identity",
          data: { providerThreadId: "native" },
        });
        if (kind === "thread")
          markThreadDeleted(db, noopNotifier, { threadId: thread.id });
        else markProjectDeleted(db, noopNotifier, { projectId: project.id });
        expect(
          getProviderSessionOwnerThread(db, {
            hostId: host.id,
            providerId: "pi",
            providerThreadId: "native",
          }),
        ).toBeNull();
      } finally {
        db.$client.close();
      }
    },
  );
});
