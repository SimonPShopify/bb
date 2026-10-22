import { and, asc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { environments, events, projects, threads } from "../schema.js";

export function getProviderSessionOwnerThread(
  db: DbQueryConnection,
  args: { hostId: string; providerId: string; providerThreadId: string },
) {
  const identities = db
    .select({ threadId: events.threadId })
    .from(events)
    .where(
      and(
        eq(events.providerThreadId, args.providerThreadId),
        eq(events.type, "thread/identity"),
      ),
    );
  return (
    db
      .select(getTableColumns(threads))
      .from(threads)
      .innerJoin(environments, eq(environments.id, threads.environmentId))
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(
        and(
          inArray(threads.id, identities),
          eq(threads.providerId, args.providerId),
          eq(environments.hostId, args.hostId),
          isNull(threads.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(asc(threads.createdAt), asc(threads.id))
      .limit(1)
      .get() ?? null
  );
}
