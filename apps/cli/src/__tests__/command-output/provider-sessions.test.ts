import { describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "@bb/server-contract";
import { makeEnvironment, makeHost } from "@bb/test-helpers/domain-fixtures";
import {
  setupCommandOutputTestEnvironment,
  collectLogPayloads,
  resolveLocalHostIdMock,
  runCommand,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerProviderCommands } from "../../commands/provider.js";

function session(sourceKey: string): ProviderSession {
  return {
    sourceKey,
    sessionId: sourceKey,
    cwd: "/workspace/project",
    name: "Native session",
    firstMessage: "Hello",
    createdAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T01:00:00Z",
    messageCount: 2,
    model: null,
    reasoningLevel: null,
  };
}

const register: CommandRegistrar = (program) =>
  registerProviderCommands(program, () => "http://server");

function stubSessions(sessions = [session("one"), session("two")]) {
  const list = vi.fn(async () => ({ sessions }));
  const importSession = vi.fn(async () => ({
    threadId: "thread-1",
    created: true,
  }));
  const environment = vi.fn(async () =>
    makeEnvironment({ hostId: "environment-host" }),
  );
  stubServerApi({
    "v1.hosts.$get": vi.fn(async () => [
      makeHost({ id: "remote-host", name: "builder", status: "connected" }),
    ]),
    "v1.environments.:id.$get": environment,
    "v1.system.providers.:id.sessions.$get": list,
    "v1.system.providers.:id.sessions.import.$post": importSession,
  });
  return { list, importSession, environment };
}

describe("bb provider native sessions", () => {
  setupCommandOutputTestEnvironment();

  it("discovers on the local daemon by default with wrapped JSON", async () => {
    const { list } = stubSessions();
    await runCommand(["provider", "sessions", "pi", "--json"], register);
    expect(resolveLocalHostIdMock).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      param: { id: "pi" },
      query: { hostId: "host-test-001" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify({ sessions: [session("one"), session("two")] }, null, 2),
    ]);
  });

  it("prints discoverable source keys and directories", async () => {
    stubSessions([session("source-one")]);
    await runCommand(["provider", "sessions", "pi"], register);
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Source key");
    expect(output).toContain("source-one");
    expect(output).toContain("/workspace/project");
  });

  it.each(["--machine", "--host"])(
    "routes sessions through %s",
    async (selector) => {
      const { list } = stubSessions();
      await runCommand(
        ["provider", "sessions", "pi", selector, "builder", "--json"],
        register,
      );
      expect(list).toHaveBeenCalledWith({
        param: { id: "pi" },
        query: { hostId: "remote-host" },
      });
      expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
    },
  );

  it("uses the environment's host for machine-wide import", async () => {
    const { environment, importSession } = stubSessions([session("one")]);
    await runCommand(
      ["provider", "import-sessions", "pi", "--environment", "env-1"],
      register,
    );
    expect(environment).toHaveBeenCalledWith({ param: { id: "env-1" } });
    expect(importSession).toHaveBeenCalledWith({
      param: { id: "pi" },
      json: { hostId: "environment-host", sourceKey: "one" },
    });
    expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
  });

  it("imports all by default and prints created and existing thread IDs", async () => {
    const { importSession } = stubSessions();
    importSession
      .mockResolvedValueOnce({ threadId: "thread-new", created: true })
      .mockResolvedValueOnce({ threadId: "thread-existing", created: false });
    await runCommand(["provider", "import-sessions", "pi"], register);
    expect(importSession).toHaveBeenCalledTimes(2);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Created thread thread-new",
      "Existing thread thread-existing",
      "1 created, 1 already imported, 0 failed",
    ]);
    expect(console.error).toHaveBeenCalledWith("Importing 2 sessions from pi…");
  });

  it("imports only repeated source keys, deduplicates them and emits no progress in JSON mode", async () => {
    const { importSession } = stubSessions();
    await runCommand(
      [
        "provider",
        "import-sessions",
        "pi",
        "--source-key",
        "two",
        "--source-key",
        "two",
        "--json",
      ],
      register,
    );
    expect(importSession).toHaveBeenCalledOnce();
    expect(importSession).toHaveBeenCalledWith({
      param: { id: "pi" },
      json: { hostId: "host-test-001", sourceKey: "two" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        {
          results: [{ sourceKey: "two", threadId: "thread-1", created: true }],
          created: 1,
          skipped: 0,
          failed: 0,
        },
        null,
        2,
      ),
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects unknown selections before creating any threads", async () => {
    const { importSession } = stubSessions();
    await expect(
      runCommand(
        [
          "provider",
          "import-sessions",
          "pi",
          "--source-key",
          "one",
          "--source-key",
          "missing",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(importSession).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Error: Sessions not found on this machine: missing",
    );
  });

  it("preserves successes and continues after a failed import with a nonzero exit", async () => {
    const { importSession } = stubSessions();
    importSession.mockRejectedValueOnce(new Error("Path is occupied"));
    await expect(
      runCommand(["provider", "import-sessions", "pi", "--json"], register),
    ).rejects.toThrow("process.exit:1");
    expect(importSession).toHaveBeenCalledTimes(2);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        {
          results: [
            { sourceKey: "one", error: "Path is occupied" },
            { sourceKey: "two", threadId: "thread-1", created: true },
          ],
          created: 1,
          skipped: 0,
          failed: 1,
        },
        null,
        2,
      ),
    ]);
  });

  it("handles empty discovery and import without mutations", async () => {
    const { importSession } = stubSessions([]);
    await runCommand(["provider", "sessions", "pi"], register);
    await runCommand(["provider", "import-sessions", "pi"], register);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No sessions found",
      "0 created, 0 already imported, 0 failed",
    ]);
    expect(importSession).not.toHaveBeenCalled();
  });

  it.each([
    ["--machine", "builder", "--environment", "env-1"],
    ["--machine", "builder", "--host", "remote-host"],
  ])("rejects conflicting routing selectors %s", async (...selectors) => {
    const { list } = stubSessions();
    await expect(
      runCommand(["provider", "import-sessions", "pi", ...selectors], register),
    ).rejects.toThrow("process.exit:1");
    expect(list).not.toHaveBeenCalled();
  });

  it("reports unavailable discovery without importing", async () => {
    const { list, importSession } = stubSessions();
    list.mockRejectedValueOnce(
      new Error("Provider does not support session import"),
    );
    await expect(
      runCommand(["provider", "import-sessions", "other"], register),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      "Error: Provider does not support session import",
    );
    expect(importSession).not.toHaveBeenCalled();
  });
});
