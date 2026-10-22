import { describe, expect, it } from "vitest";
import {
  experimental_providerSessionImportHostContract,
  experimental_providerSessionSchema,
  experimental_providerSessionTranscriptItemSchema,
} from "../host.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const session = {
  sourceKey: "opaque-provider-key",
  sourcePath: "/home/user/provider/session.jsonl",
  sessionId: "original-session-id",
  cwd: "/workspace",
  name: null,
  createdAt: timestamp,
  modifiedAt: timestamp,
  messageCount: 1,
  firstMessage: "First prompt",
  model: null,
  reasoningLevel: null,
};

describe("experimental provider session import host contract", () => {
  it("requires a provider and a stable key rather than accepting arbitrary path or destination inputs", () => {
    const { listSessions, importSession } =
      experimental_providerSessionImportHostContract;
    expect(listSessions.input.parse({ providerId: "pi" })).toEqual({
      providerId: "pi",
    });
    expect(
      importSession.input.parse({
        providerId: "pi",
        sourceKey: session.sourceKey,
      }),
    ).toEqual({ providerId: "pi", sourceKey: session.sourceKey });
    for (const input of [
      { providerId: "pi", sourcePath: session.sourcePath },
      {
        providerId: "pi",
        sourceKey: session.sourceKey,
        providerThreadId: "chosen-destination",
      },
      { providerId: "", sourceKey: session.sourceKey },
      { providerId: "pi", sourceKey: "" },
    ])
      expect(importSession.input.safeParse(input).success).toBe(false);
  });

  it("requires explicit nullable metadata and rejects invalid timestamps or counts", () => {
    expect(experimental_providerSessionSchema.parse(session)).toEqual(session);
    for (const invalid of [
      { ...session, name: undefined },
      { ...session, model: undefined },
      { ...session, reasoningLevel: undefined },
      { ...session, createdAt: "invalid" },
      { ...session, modifiedAt: "2026-01-01" },
      { ...session, messageCount: -1 },
      { ...session, messageCount: 1.5 },
    ])
      expect(
        experimental_providerSessionSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it("carries normalized text, reasoning, image, tool call and result lanes with stable ids and timestamps", () => {
    const base = { id: "item", timestamp };
    const transcript = [
      { ...base, id: "user", type: "text", role: "user", text: "Prompt" },
      {
        ...base,
        id: "assistant",
        type: "text",
        role: "assistant",
        text: "Answer",
      },
      { ...base, id: "reasoning", type: "reasoning", text: "Thoughts" },
      {
        ...base,
        id: "image",
        type: "image",
        role: "user",
        data: "image-bytes",
        mimeType: "image/png",
      },
      {
        ...base,
        id: "call",
        type: "toolCall",
        toolCallId: "tool-1",
        toolName: "read",
        arguments: { path: "file", flags: [true, null, 1] },
      },
      {
        ...base,
        id: "result",
        type: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        text: "Output",
        content: [{ type: "text", text: "Output" }],
        details: null,
        isError: false,
      },
    ];
    const result = { session, providerThreadId: "destination-id", transcript };
    expect(
      experimental_providerSessionImportHostContract.importSession.output.parse(
        result,
      ),
    ).toEqual(result);
    expect(
      experimental_providerSessionTranscriptItemSchema.safeParse({
        ...base,
        type: "text",
        role: "tool",
        text: "invalid role",
      }).success,
    ).toBe(false);
    expect(
      experimental_providerSessionTranscriptItemSchema.safeParse({
        ...transcript[4],
        arguments: { value: Infinity },
      }).success,
    ).toBe(false);
    expect(
      experimental_providerSessionTranscriptItemSchema.safeParse({
        ...transcript[5],
        isError: undefined,
      }).success,
    ).toBe(false);
  });
});
