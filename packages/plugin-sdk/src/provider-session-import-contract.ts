import { z } from "zod";
import { defineRpcContract } from "./rpc-contract.js";
import type { JsonValue } from "./json-value.js";

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
const itemBase = { id: z.string().min(1), timestamp: timestampSchema };
const roleSchema = z.enum(["user", "assistant", "system"]);

export const experimental_providerSessionSchema = z
  .object({
    sourceKey: z.string().min(1),
    sourcePath: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string(),
    name: z.string().nullable(),
    createdAt: timestampSchema,
    modifiedAt: timestampSchema,
    messageCount: z.number().int().nonnegative(),
    firstMessage: z.string(),
    model: z.string().min(1).nullable(),
    reasoningLevel: z.string().min(1).nullable(),
  })
  .strict();

export const experimental_providerSessionTranscriptItemSchema =
  z.discriminatedUnion("type", [
    z
      .object({
        ...itemBase,
        type: z.literal("text"),
        role: roleSchema,
        text: z.string(),
      })
      .strict(),
    z
      .object({
        ...itemBase,
        type: z.literal("image"),
        role: roleSchema,
        data: z.string(),
        mimeType: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...itemBase,
        type: z.literal("reasoning"),
        text: z.string(),
      })
      .strict(),
    z
      .object({
        ...itemBase,
        type: z.literal("toolCall"),
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        arguments: jsonSchema,
      })
      .strict(),
    z
      .object({
        ...itemBase,
        type: z.literal("toolResult"),
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        text: z.string(),
        content: jsonSchema,
        details: jsonSchema,
        isError: z.boolean(),
      })
      .strict(),
  ]);

export const experimental_providerSessionImportHostContract = defineRpcContract(
  {
    listSessions: {
      input: z.object({ providerId: z.string().min(1) }).strict(),
      output: z
        .object({ sessions: z.array(experimental_providerSessionSchema) })
        .strict(),
    },
    importSession: {
      input: z
        .object({
          providerId: z.string().min(1),
          sourceKey: z.string().min(1),
        })
        .strict(),
      output: z
        .object({
          session: experimental_providerSessionSchema,
          providerThreadId: z.string().min(1),
          transcript: z.array(experimental_providerSessionTranscriptItemSchema),
        })
        .strict(),
    },
  },
);

export type ExperimentalProviderSession = z.infer<
  typeof experimental_providerSessionSchema
>;
export type ExperimentalProviderSessionTranscriptItem = z.infer<
  typeof experimental_providerSessionTranscriptItemSchema
>;
export type ExperimentalProviderSessionImportHostContract =
  typeof experimental_providerSessionImportHostContract;
export type ExperimentalProviderSessionImportResult = z.infer<
  typeof experimental_providerSessionImportHostContract.importSession.output
>;
