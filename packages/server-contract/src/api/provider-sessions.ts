import { z } from "zod";

export const providerSessionSchema = z
  .object({
    sourceKey: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string(),
    name: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    modifiedAt: z.iso.datetime({ offset: true }),
    messageCount: z.number().int().nonnegative(),
    firstMessage: z.string(),
    model: z.string().min(1).nullable(),
    reasoningLevel: z.string().min(1).nullable(),
  })
  .strict();

export const providerSessionsQuerySchema = z
  .object({
    hostId: z.string().min(1),
  })
  .strict();

export const importProviderSessionRequestSchema = z
  .object({
    hostId: z.string().min(1),
    sourceKey: z.string().min(1),
  })
  .strict();

export const providerSessionsResponseSchema = z
  .object({
    sessions: z.array(providerSessionSchema),
  })
  .strict();

export const importProviderSessionResponseSchema = z
  .object({
    threadId: z.string().min(1),
    created: z.boolean(),
  })
  .strict();

export type ProviderSession = z.infer<typeof providerSessionSchema>;
export type ProviderSessionsQuery = z.infer<typeof providerSessionsQuerySchema>;
export type ImportProviderSessionRequest = z.infer<
  typeof importProviderSessionRequestSchema
>;
export type ProviderSessionsResponse = z.infer<
  typeof providerSessionsResponseSchema
>;
export type ImportProviderSessionResponse = z.infer<
  typeof importProviderSessionResponseSchema
>;
