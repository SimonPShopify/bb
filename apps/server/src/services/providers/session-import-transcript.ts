import type { AppendStoredThreadEventArgs } from "@bb/db";
import { threadScope, turnScope, type ThreadEventItem } from "@bb/domain";
import type {
  ExperimentalProviderSessionImportResult,
  ExperimentalProviderSessionTranscriptItem,
} from "@get-bb/plugin-sdk/host";

function presentation(label: string) {
  return {
    label: { pending: label, completed: label },
    icon: { glyph: "message-square" },
  };
}

function transcriptItem(
  item: ExperimentalProviderSessionTranscriptItem,
): ThreadEventItem {
  switch (item.type) {
    case "text":
      return item.role === "user"
        ? {
            type: "userMessage",
            id: item.id,
            content: [{ type: "text", text: item.text }],
          }
        : {
            type: "agentMessage",
            id: item.id,
            text: item.text,
            ...(item.role === "system"
              ? { presentation: presentation("System") }
              : {}),
          };
    case "image": {
      const url = `data:${item.mimeType};base64,${item.data}`;
      return item.role === "user"
        ? {
            type: "userMessage",
            id: item.id,
            content: [{ type: "image", url }],
          }
        : {
            type: "imageGeneration",
            id: item.id,
            result: url,
            path: null,
            prompt: null,
            error: null,
            status: "completed",
            transparentBackground: false,
            presentation: presentation(
              item.role === "system" ? "System image" : "Assistant image",
            ),
          };
    }
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: [],
        content: [item.text],
      };
    case "toolCall":
      return {
        type: "toolCall",
        id: item.toolCallId,
        tool: item.toolName,
        arguments:
          item.arguments !== null &&
          typeof item.arguments === "object" &&
          !Array.isArray(item.arguments)
            ? item.arguments
            : { input: item.arguments },
        status: "pending",
      };
    case "toolResult":
      return {
        type: "toolCall",
        id: item.toolCallId,
        tool: item.toolName,
        status: item.isError ? "failed" : "completed",
        result: {
          text: item.text,
          content: item.content,
          details: item.details,
        },
        ...(item.isError ? { error: item.text } : {}),
      };
  }
}

export function providerSessionTranscriptEvents(args: {
  threadId: string;
  environmentId: string;
  imported: ExperimentalProviderSessionImportResult;
}): AppendStoredThreadEventArgs[] {
  const { threadId, environmentId, imported } = args;
  const { providerThreadId } = imported;
  const base = { threadId, environmentId, providerThreadId };
  const result: AppendStoredThreadEventArgs[] = [
    {
      ...base,
      scope: threadScope(),
      type: "thread/identity",
      data: { providerThreadId },
      createdAt: Date.parse(imported.session.createdAt),
    },
  ];
  const pendingTools = new Map<
    string,
    Extract<ThreadEventItem, { type: "toolCall" }>
  >();
  let turnId: string | null = null;
  let previousWasUser = false;
  let turnHasOutput = false;
  let lastTimestamp = Date.parse(imported.session.createdAt);
  const completeTurn = () => {
    if (turnId === null) return;
    const interrupted = pendingTools.size > 0 || !turnHasOutput;
    for (const item of pendingTools.values()) {
      result.push({
        ...base,
        scope: turnScope(turnId),
        type: "item/completed",
        data: { providerThreadId, item: { ...item, status: "interrupted" } },
        createdAt: lastTimestamp,
      });
    }
    pendingTools.clear();
    result.push({
      ...base,
      scope: turnScope(turnId),
      type: "turn/completed",
      data: {
        providerThreadId,
        status: interrupted ? "interrupted" : "completed",
      },
      createdAt: lastTimestamp,
    });
  };
  for (const [index, source] of imported.transcript.entries()) {
    const normalized = transcriptItem(source);
    const pending =
      normalized.type === "toolCall"
        ? pendingTools.get(normalized.id)
        : undefined;
    const item =
      normalized.type === "toolCall" && source.type === "toolResult"
        ? { ...pending, ...normalized }
        : normalized;
    const isUser = item.type === "userMessage";
    if (turnId === null || (isUser && !previousWasUser)) {
      completeTurn();
      turnId = `import-${index}`;
      turnHasOutput = false;
      result.push({
        ...base,
        scope: turnScope(turnId),
        type: "turn/started",
        data: { providerThreadId },
        createdAt: Date.parse(source.timestamp),
      });
    }
    lastTimestamp = Date.parse(source.timestamp);
    if (item.type === "toolCall") {
      if (source.type === "toolCall") pendingTools.set(item.id, item);
      else pendingTools.delete(item.id);
    }
    result.push({
      ...base,
      scope: turnScope(turnId),
      type: source.type === "toolCall" ? "item/started" : "item/completed",
      data: { providerThreadId, item },
      createdAt: lastTimestamp,
    });
    if (!isUser) turnHasOutput = true;
    previousWasUser = isUser;
  }
  completeTurn();
  return result;
}
