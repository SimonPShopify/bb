import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { experimental_providerSessionImportHostContract } from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostEntry from "./host.js";
import { resolvePiSessionFilePath } from "./bridge/session-paths.js";
import { parsePiSessionImport } from "./session-import-parser.js";
import {
  importPiStandaloneSession,
  listPiStandaloneSessions,
} from "./session-import.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const entryTime = "2026-01-02T00:00:00.000Z";
const messageTime = Date.parse("2026-01-03T00:00:00.000Z");
const modifiedAt = "2026-01-04T00:00:00.000Z";
let homeDir: string;
let context: { homeDir: string; env: NodeJS.ProcessEnv; signal: AbortSignal };

beforeEach(async () => {
  homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "bb-pi-session-import-")),
  );
  context = {
    homeDir,
    env: { BB_PI_BRIDGE_SESSION_DIR: join(homeDir, "bridge") },
    signal: new AbortController().signal,
  };
  await mkdir(join(homeDir, "work", "project"), { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function entry(
  type: string,
  id: string,
  parentId: string | null,
  fields: Record<string, unknown> = {},
) {
  return { type, id, parentId, timestamp: entryTime, ...fields };
}

function header(version = 3) {
  return {
    type: "session",
    version,
    id: "original-session-id",
    timestamp: createdAt,
    cwd: join(homeDir, "work", "project"),
  };
}

function rawSession(entries: object[], version = 3): string {
  return (
    [header(version), ...entries]
      .map((value) => JSON.stringify(value))
      .join("\r\n") + "\r\n"
  );
}

async function writeSession(name: string, raw: string): Promise<string> {
  const path = join(homeDir, ".pi", "agent", "sessions", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw);
  await utimes(path, new Date(modifiedAt), new Date(modifiedAt));
  return path;
}

function userEntry(
  id = "user",
  parentId: string | null = null,
  text = "Please inspect this project",
) {
  return entry("message", id, parentId, {
    message: { role: "user", content: text, timestamp: messageTime },
  });
}

async function onlySession() {
  const result = await listPiStandaloneSessions(context);
  expect(result.sessions).toHaveLength(1);
  return result.sessions[0]!;
}

it("exposes the generic host RPCs and refuses another provider before touching the filesystem", async () => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    await expect(
      harness.experimental_call("listSessions", { providerId: "other" }),
    ).rejects.toThrow("Unsupported provider");
    await expect(
      harness.experimental_call("importSession", {
        providerId: "other",
        sourceKey: "pi:key",
      }),
    ).rejects.toThrow("Unsupported provider");
  } finally {
    await harness.experimental_dispose();
  }
});

describe("standalone Pi discovery", () => {
  it("handles missing directories and recursively finds sessions with stable metadata keys", async () => {
    await expect(listPiStandaloneSessions(context)).resolves.toEqual({
      sessions: [],
    });
    const sourcePath = await writeSession(
      "project/deep/source.jsonl",
      rawSession([
        entry("model_change", "model", null, {
          provider: "anthropic",
          modelId: "claude-sonnet",
        }),
        entry("thinking_level_change", "thinking", "model", {
          thinkingLevel: "high",
        }),
        userEntry("user", "thinking"),
        entry("session_info", "name", "user", {
          name: "Project investigation",
        }),
      ]),
    );
    const session = await onlySession();
    expect(session).toEqual({
      sourceKey: expect.stringMatching(/^pi:[a-f0-9]{64}$/),
      sourcePath,
      sessionId: "original-session-id",
      cwd: join(homeDir, "work", "project"),
      name: "Project investigation",
      createdAt,
      modifiedAt,
      messageCount: 1,
      firstMessage: "Please inspect this project",
      model: "anthropic/claude-sonnet",
      reasoningLevel: "high",
    });
    expect((await onlySession()).sourceKey).toBe(session.sourceKey);
    expect(
      experimental_providerSessionImportHostContract.listSessions.output.parse({
        sessions: [session],
      }),
    ).toEqual({ sessions: [session] });
  });

  it("skips malformed, unsupported, oversized, non-session and symlink sources without losing good sessions", async () => {
    await writeSession("valid.jsonl", rawSession([userEntry()]));
    await writeSession("broken.jsonl", rawSession([userEntry()]) + "{partial");
    await writeSession("not-session.jsonl", "{}\n");
    await writeSession("unknown-version.jsonl", rawSession([], 99));
    const oversized = await writeSession("large.jsonl", "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    const outside = join(homeDir, "outside.jsonl");
    await writeFile(outside, rawSession([userEntry()]));
    const root = join(homeDir, ".pi", "agent", "sessions");
    await symlink(outside, join(root, "linked.jsonl"));
    await symlink(homeDir, join(root, "loop"), "dir");
    const session = await onlySession();
    expect(session.sourcePath).toBe(join(root, "valid.jsonl"));
  });

  it("excludes the configured BB bridge subtree from standalone discovery", async () => {
    await writeSession("source.jsonl", rawSession([userEntry()]));
    context.env.BB_PI_BRIDGE_SESSION_DIR = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "bb",
    );
    const original = await onlySession();
    await importPiStandaloneSession(context, original.sourceKey);
    expect(await onlySession()).toEqual(original);
  });

  it("does not swallow cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      listPiStandaloneSessions({ ...context, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("standalone Pi import", () => {
  it("copies raw bytes, preserves all normalized message lanes and timestamps, and retries idempotently", async () => {
    const content = [
      { type: "text", text: "Starting inspection" },
      { type: "thinking", thinking: "Need to inspect the tree" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "package.json", nested: [1, true, null] },
      },
    ];
    const resultContent = [
      { type: "text", text: "package contents" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ];
    const raw = rawSession([
      userEntry(),
      entry("message", "assistant", "user", {
        message: {
          role: "assistant",
          content,
          provider: "openai",
          model: "gpt",
          timestamp: messageTime + 1000,
        },
      }),
      entry("message", "result", "assistant", {
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: resultContent,
          details: { truncated: false },
          isError: true,
        },
      }),
    ]);
    const path = await writeSession("project/source.jsonl", raw);
    const source = await onlySession();
    const first = await importPiStandaloneSession(context, source.sourceKey);
    expect(first.providerThreadId).toMatch(/^pi-import-[a-f0-9]{64}$/);
    expect(first.session.model).toBe("openai/gpt");
    expect(first.transcript).toEqual([
      {
        id: "user:0",
        timestamp: new Date(messageTime).toISOString(),
        type: "text",
        role: "user",
        text: "Please inspect this project",
      },
      {
        id: "assistant:0",
        timestamp: new Date(messageTime + 1000).toISOString(),
        type: "text",
        role: "assistant",
        text: "Starting inspection",
      },
      {
        id: "assistant:1",
        timestamp: new Date(messageTime + 1000).toISOString(),
        type: "reasoning",
        text: "Need to inspect the tree",
      },
      {
        id: "assistant:2",
        timestamp: new Date(messageTime + 1000).toISOString(),
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "read",
        arguments: content[2]!.arguments,
      },
      {
        id: "result",
        timestamp: entryTime,
        type: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: null,
        details: null,
        isError: true,
        text: "package contents",
      },
    ]);
    const destination = resolvePiSessionFilePath({
      env: context.env,
      threadId: first.providerThreadId,
    });
    expect(await readFile(destination)).toEqual(Buffer.from(raw));
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(
      experimental_providerSessionImportHostContract.importSession.output.parse(
        first,
      ),
    ).toEqual(first);
    await expect(
      importPiStandaloneSession(context, source.sourceKey),
    ).resolves.toEqual(first);
    expect(await readdir(dirname(destination))).toEqual([
      `${first.providerThreadId}.jsonl`,
    ]);
  });

  it("imports only the active branch and its settings while retaining history across compaction", async () => {
    await writeSession(
      "tree.jsonl",
      rawSession([
        entry("model_change", "model", null, {
          provider: "openai",
          modelId: "original",
        }),
        userEntry("user", "model", "Original prompt"),
        entry("message", "abandoned", "user", {
          message: { role: "assistant", content: "Discarded answer" },
        }),
        entry("model_change", "discarded-model", "abandoned", {
          provider: "openai",
          modelId: "discarded",
        }),
        entry(
          "thinking_level_change",
          "discarded-thinking",
          "discarded-model",
          { thinkingLevel: "high" },
        ),
        entry("message", "active", "user", {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Active answer" }],
          },
        }),
        entry("compaction", "compaction", "active", {
          summary: "Summary of the retained history",
          firstKeptEntryId: "active",
        }),
        entry("thinking_level_change", "thinking", "compaction", {
          thinkingLevel: "off",
        }),
        userEntry("next", "thinking", "Next prompt"),
      ]),
    );
    const source = await onlySession();
    const result = await importPiStandaloneSession(context, source.sourceKey);
    expect(result.session).toMatchObject({
      model: "openai/original",
      reasoningLevel: "none",
      messageCount: 3,
      firstMessage: "Original prompt",
    });
    expect(
      result.transcript.map((item) =>
        item.type === "text" ? item.text : item.type,
      ),
    ).toEqual(["Original prompt", "Active answer", "Next prompt"]);
  });

  it("publishes atomically and reuses the imported destination after either session continues", async () => {
    const path = await writeSession("source.jsonl", rawSession([userEntry()]));
    const source = await onlySession();
    const [first, second] = await Promise.all([
      importPiStandaloneSession(context, source.sourceKey),
      importPiStandaloneSession(context, source.sourceKey),
    ]);
    expect(second).toEqual(first);
    const destination = resolvePiSessionFilePath({
      env: context.env,
      threadId: first.providerThreadId,
    });
    await writeFile(
      destination,
      rawSession([
        userEntry(),
        userEntry("bb-followup", "user", "Continued in BB"),
      ]),
    );
    await expect(
      importPiStandaloneSession(context, source.sourceKey),
    ).resolves.toMatchObject({
      transcript: [
        expect.objectContaining({
          type: "text",
          text: "Please inspect this project",
        }),
        expect.objectContaining({ type: "text", text: "Continued in BB" }),
      ],
    });
    await writeFile(
      path,
      rawSession([userEntry(), userEntry("followup", "user", "More work")]),
    );
    expect((await onlySession()).sourceKey).toBe(source.sourceKey);
    const retried = await importPiStandaloneSession(context, source.sourceKey);
    expect(retried.transcript).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Please inspect this project",
      }),
      expect.objectContaining({ type: "text", text: "Continued in BB" }),
    ]);
    expect(await readFile(destination, "utf8")).not.toContain("More work");
    expect(await readdir(dirname(destination))).toEqual([
      `${first.providerThreadId}.jsonl`,
    ]);
  });

  it("rejects path inputs, missing sources and invalidated source data without creating a destination", async () => {
    await expect(
      importPiStandaloneSession(context, "../../outside.jsonl"),
    ).rejects.toThrow("not found");
    const path = await writeSession("source.jsonl", rawSession([userEntry()]));
    const source = await onlySession();
    await writeFile(path, "not JSON");
    await expect(
      importPiStandaloneSession(context, source.sourceKey),
    ).rejects.toThrow();
    await expect(
      readdir(context.env.BB_PI_BRIDGE_SESSION_DIR!),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path);
    await expect(
      importPiStandaloneSession(context, source.sourceKey),
    ).rejects.toThrow("not found");
  });

  it("refuses symlink destinations without touching their target", async () => {
    await writeSession("source.jsonl", rawSession([userEntry()]));
    const source = await onlySession();
    const first = await importPiStandaloneSession(context, source.sourceKey);
    const destination = resolvePiSessionFilePath({
      env: context.env,
      threadId: first.providerThreadId,
    });
    const outside = join(homeDir, "protected");
    await writeFile(outside, "protected data");
    await rm(destination);
    await symlink(outside, destination);
    await expect(
      importPiStandaloneSession(context, source.sourceKey),
    ).rejects.toThrow("destination is invalid");
    expect(await readFile(outside, "utf8")).toBe("protected data");
  });
});

describe("Pi session boundary parsing", () => {
  function parse(contents: string) {
    return parsePiSessionImport({
      contents,
      sourceKey: "pi:test",
      sourcePath: "/session.jsonl",
      modifiedAt,
    });
  }

  it("supports legacy linear sessions, images and shell executions while hiding provider context", () => {
    const raw = [
      header(1),
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "bashExecution",
          command: "ls",
          output: "output",
          exitCode: 2,
          cancelled: false,
        },
      },
      { type: "custom_message", content: "Extension context" },
      { type: "branch_summary", summary: "Prior branch summary" },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    const first = parse(raw);
    expect(parse(raw)).toEqual(first);
    expect(first.session).toMatchObject({
      model: null,
      reasoningLevel: null,
      name: null,
      messageCount: 2,
      firstMessage: "Look",
    });
    expect(first.transcript.map((item) => item.type)).toEqual([
      "text",
      "image",
      "toolCall",
      "toolResult",
    ]);
    expect(first.transcript[3]).toMatchObject({
      isError: true,
      text: "output",
      timestamp: createdAt,
    });
  });

  it("bounds oversized visible payloads while retaining them in the raw session", () => {
    const result = parse(
      rawSession([
        entry("message", "large", null, {
          message: {
            role: "user",
            content: [
              { type: "text", text: "x".repeat(200_000) },
              {
                type: "image",
                data: "a".repeat(300_000),
                mimeType: "image/png",
              },
            ],
          },
        }),
      ]),
    );
    expect(result.session.firstMessage.length).toBeLessThan(5_000);
    expect(result.transcript).toEqual([
      expect.objectContaining({ type: "text", role: "user" }),
      expect.objectContaining({
        type: "text",
        role: "user",
        text: "[image/png image omitted from BB history]",
      }),
    ]);
    expect(
      result.transcript[0]?.type === "text"
        ? result.transcript[0].text.length
        : 0,
    ).toBeLessThan(132_000);
  });

  it.each([
    [userEntry(), userEntry()],
    [userEntry("missing-parent", "unknown")],
    [
      entry("message", "user", "user", {
        message: { role: "user", content: "cycle" },
      }),
    ],
    [
      entry("message", "bad", null, {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "read",
              arguments: undefined,
            },
          ],
        },
      }),
    ],
    [
      entry("message", "bad", null, {
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [],
          isError: "no",
        },
      }),
    ],
    [
      entry("message", "bad", null, {
        message: {
          role: "user",
          content: "text",
          timestamp: "not a timestamp",
        },
      }),
    ],
  ])(
    "rejects invalid trees and message payloads instead of silently dropping history: %j",
    (...entries) => {
      expect(() => parse(rawSession(entries))).toThrow();
    },
  );
});
