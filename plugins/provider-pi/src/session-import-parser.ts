import { z } from "zod";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type {
  ExperimentalProviderSession,
  ExperimentalProviderSessionTranscriptItem,
} from "@get-bb/plugin-sdk/host";
import { toCanonicalPiModelId } from "./model-list.js";

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);
const timestampSchema = z.iso.datetime({ offset: true });
const headerSchema = z.object({
  type: z.literal("session"),
  version: z.number().int().min(1).max(3).default(1),
  id: z.string().min(1),
  cwd: z.string().default(""),
  timestamp: timestampSchema,
});
const entrySchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1).optional(),
  parentId: z.string().min(1).nullable().optional(),
  timestamp: timestampSchema.optional(),
});
const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({
    type: z.literal("toolCall"),
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonSchema,
  }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string().min(1),
  }),
]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);
const messageTimestampSchema = z
  .union([
    z
      .number()
      .finite()
      .refine((value) => Number.isFinite(new Date(value).getTime())),
    timestampSchema,
  ])
  .optional();
const messageSchema = z.object({
  role: z.string(),
  timestamp: messageTimestampSchema,
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const toolResultSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: jsonSchema,
  details: jsonSchema.default(null),
  isError: z.boolean(),
});
const bashMessageSchema = z.object({
  command: z.string(),
  output: z.string(),
  exitCode: z.number().nullable().optional(),
  cancelled: z.boolean(),
});
const textResultSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);
const payloadSchema = z.object({ message: jsonSchema });
const modelChangeSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
const thinkingChangeSchema = z.object({ thinkingLevel: z.string().min(1) });
const sessionInfoSchema = z.object({ name: z.string().optional() });
const summarySchema = z.object({ summary: z.string() });
const customMessageSchema = z.object({ content: contentSchema });
const MAX_TOOL_VALUE_CHARACTERS = 4_096;
const MAX_MESSAGE_CHARACTERS = 131_072;
const MAX_IMAGE_CHARACTERS = 262_144;
const MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024;

function boundedJson(value: JsonValue): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded.length <= MAX_TOOL_VALUE_CHARACTERS) return value;
  return {
    truncated: true,
    preview: encoded.slice(0, MAX_TOOL_VALUE_CHARACTERS),
  };
}

function boundedText(value: string): string {
  if (value.length <= MAX_TOOL_VALUE_CHARACTERS) return value;
  return `${value.slice(0, MAX_TOOL_VALUE_CHARACTERS)}\n… native tool output truncated for BB history`;
}

function boundedMessage(value: string): string {
  if (value.length <= MAX_MESSAGE_CHARACTERS) return value;
  return `${value.slice(0, MAX_MESSAGE_CHARACTERS)}\n… native message truncated for BB history`;
}

function boundedMetadataText(value: string): string {
  return value.length <= MAX_TOOL_VALUE_CHARACTERS
    ? value
    : `${value.slice(0, MAX_TOOL_VALUE_CHARACTERS)}…`;
}

function boundedTranscript(
  items: ExperimentalProviderSessionTranscriptItem[],
): ExperimentalProviderSessionTranscriptItem[] {
  const result: ExperimentalProviderSessionTranscriptItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes + itemBytes > MAX_TRANSCRIPT_BYTES) {
      const timestamp = item.timestamp;
      const marker: ExperimentalProviderSessionTranscriptItem = {
        id: `transcript-truncated:${item.id}`,
        timestamp,
        type: "text",
        role: "system",
        text: "Additional native history remains available to the resumed Pi session but is omitted from the BB timeline.",
      };
      if (
        bytes + Buffer.byteLength(JSON.stringify(marker)) <=
        MAX_TRANSCRIPT_BYTES
      ) {
        result.push(marker);
      }
      break;
    }
    result.push(item);
    bytes += itemBytes;
  }
  return result;
}

interface ParsedEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  data: JsonValue;
}

function appendContent(
  items: ExperimentalProviderSessionTranscriptItem[],
  entry: ParsedEntry,
  content: z.infer<typeof contentSchema>,
  role: "user" | "assistant" | "system",
): void {
  const blocks =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;
  for (const [index, block] of blocks.entries()) {
    const base = { id: `${entry.id}:${index}`, timestamp: entry.timestamp };
    switch (block.type) {
      case "text":
        items.push({
          ...base,
          type: "text",
          role,
          text: boundedMessage(block.text),
        });
        break;
      case "thinking":
        items.push({
          ...base,
          type: "reasoning",
          text: boundedMessage(block.thinking),
        });
        break;
      case "image":
        if (block.data.length <= MAX_IMAGE_CHARACTERS) {
          items.push({
            ...base,
            type: "image",
            role,
            data: block.data,
            mimeType: block.mimeType,
          });
        } else {
          items.push({
            ...base,
            type: "text",
            role,
            text: `[${block.mimeType} image omitted from BB history]`,
          });
        }
        break;
      case "toolCall":
        items.push({
          ...base,
          type: "toolCall",
          toolCallId: block.id,
          toolName: block.name,
          arguments: boundedJson(block.arguments),
        });
        break;
    }
  }
}

function resultText(content: JsonValue): string {
  if (typeof content === "string") return content;
  const parsed = textResultSchema.safeParse(content);
  return parsed.success
    ? parsed.data
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
    : "";
}

export function parsePiSessionImport(args: {
  contents: string;
  sourceKey: string;
  sourcePath: string;
  modifiedAt: string;
  includeTranscript?: boolean;
}): {
  session: ExperimentalProviderSession;
  transcript: ExperimentalProviderSessionTranscriptItem[];
} {
  const includeTranscript = args.includeTranscript ?? true;
  const lines = args.contents.split("\n").filter((line) => line.trim());
  const header = headerSchema.parse(JSON.parse(lines[0] ?? "null"));
  const entries: ParsedEntry[] = [];
  const byId = new Map<string, ParsedEntry>();
  let previousId: string | null = null;
  let name: string | null = null;
  for (const [index, line] of lines.slice(1).entries()) {
    const data = jsonSchema.parse(JSON.parse(line));
    const parsed = entrySchema.parse(data);
    if (parsed.type === "session")
      throw new Error("Duplicate Pi session header");
    if (header.version >= 2 && (!parsed.id || parsed.parentId === undefined)) {
      throw new Error("Pi session entry is missing its tree identity");
    }
    const id = parsed.id ?? `legacy-${index}`;
    const parentId =
      header.version < 2 ? previousId : (parsed.parentId ?? null);
    if (byId.has(id) || (parentId !== null && !byId.has(parentId))) {
      throw new Error("Invalid Pi session tree");
    }
    const entry = {
      ...parsed,
      id,
      parentId,
      timestamp: parsed.timestamp ?? header.timestamp,
      data,
    };
    entries.push(entry);
    byId.set(id, entry);
    previousId = id;
    if (entry.type === "session_info")
      name = sessionInfoSchema.parse(data).name ?? null;
  }
  const branch: ParsedEntry[] = [];
  let leaf = entries.at(-1);
  while (leaf) {
    branch.push(leaf);
    leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
  }
  branch.reverse();
  const transcript: ExperimentalProviderSessionTranscriptItem[] = [];
  let model: string | null = null;
  let reasoningLevel: string | null = null;
  let messageCount = 0;
  let firstMessage = "";
  let foundFirstMessage = false;
  for (const entry of branch) {
    switch (entry.type) {
      case "model_change": {
        const change = modelChangeSchema.parse(entry.data);
        model = toCanonicalPiModelId(change.provider, change.modelId);
        break;
      }
      case "thinking_level_change": {
        const change = thinkingChangeSchema.parse(entry.data);
        reasoningLevel =
          change.thinkingLevel === "off" ? "none" : change.thinkingLevel;
        break;
      }
      case "message": {
        messageCount += 1;
        const payload = payloadSchema.parse(entry.data).message;
        const message = messageSchema.parse(payload);
        const timestamp =
          message.timestamp === undefined
            ? entry.timestamp
            : new Date(message.timestamp).toISOString();
        const messageEntry = { ...entry, timestamp };
        const base = { id: entry.id, timestamp };
        switch (message.role) {
          case "assistant":
          case "user": {
            if (
              message.role === "assistant" &&
              message.provider &&
              message.model
            ) {
              model = toCanonicalPiModelId(message.provider, message.model);
            }
            if (
              !includeTranscript &&
              (message.role === "assistant" || foundFirstMessage)
            ) {
              break;
            }
            const content = customMessageSchema.parse(payload).content;
            if (message.role === "user" && !foundFirstMessage) {
              firstMessage =
                typeof content === "string"
                  ? content
                  : content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("\n");
              foundFirstMessage = true;
            }
            if (includeTranscript) {
              appendContent(transcript, messageEntry, content, message.role);
            }
            break;
          }
          case "system":
          case "custom":
          case "hookMessage":
            break;
          case "toolResult": {
            if (!includeTranscript) break;
            const result = toolResultSchema.parse(payload);
            transcript.push({
              ...base,
              type: "toolResult",
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              text: boundedText(resultText(result.content)),
              content: null,
              details: null,
              isError: result.isError,
            });
            break;
          }
          case "bashExecution": {
            if (!includeTranscript) break;
            const bash = bashMessageSchema.parse(payload);
            const toolCallId = `bash:${entry.id}`;
            transcript.push(
              {
                ...base,
                id: `${entry.id}:call`,
                type: "toolCall",
                toolCallId,
                toolName: "bash",
                arguments: { command: bash.command },
              },
              {
                ...base,
                id: `${entry.id}:result`,
                type: "toolResult",
                toolCallId,
                toolName: "bash",
                text: boundedText(bash.output),
                content: null,
                details: {
                  exitCode: bash.exitCode ?? null,
                  cancelled: bash.cancelled,
                },
                isError:
                  bash.cancelled ||
                  (bash.exitCode != null && bash.exitCode !== 0),
              },
            );
            break;
          }
          case "branchSummary":
          case "compactionSummary":
            if (includeTranscript) summarySchema.parse(payload);
            break;
          default:
            throw new Error(`Unsupported Pi message role: ${message.role}`);
        }
        break;
      }
      case "custom_message":
        if (includeTranscript) customMessageSchema.parse(entry.data);
        break;
      case "compaction":
      case "branch_summary":
        if (includeTranscript) summarySchema.parse(entry.data);
        break;
    }
  }
  return {
    session: {
      sourceKey: args.sourceKey,
      sourcePath: args.sourcePath,
      sessionId: header.id,
      cwd: header.cwd,
      name: name === null ? null : boundedMetadataText(name),
      createdAt: header.timestamp,
      modifiedAt: args.modifiedAt,
      messageCount,
      firstMessage: boundedMetadataText(firstMessage),
      model,
      reasoningLevel,
    },
    transcript: includeTranscript ? boundedTranscript(transcript) : [],
  };
}
