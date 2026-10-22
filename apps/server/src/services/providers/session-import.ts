import {
  appendStoredThreadEventsInTransaction,
  createEnvironment,
  createThread,
  findOrCreateProjectByLocalPathSource,
  findProjectEnvironmentByHostPath,
  getProviderSessionOwnerThread,
  setThreadExecutionOverride,
} from "@bb/db";
import {
  isAbsoluteHostPath,
  isHostPathRoot,
  isWindowsHostPath,
} from "@bb/domain";
import type {
  ImportProviderSessionResponse,
  ProviderSessionsResponse,
} from "@bb/server-contract";
import { experimental_providerSessionImportHostContract as contract } from "@get-bb/plugin-sdk/host";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { callPluginHostRpc } from "../plugins/plugin-host-rpc.js";
import { providerSessionTranscriptEvents } from "./session-import-transcript.js";

interface ProviderSessionHost {
  providerId: string;
  hostId: string;
}

async function providerArtifact(
  deps: WorkSessionDeps,
  args: ProviderSessionHost,
) {
  requireConnectedHostSession(deps, args.hostId);
  await deps.providerRegistry.whenRegistrationsSettled();
  const registration = deps.providerRegistry.get(args.providerId);
  if (registration === null) {
    throw new ApiError(404, "provider_not_found", "Provider not found");
  }
  const artifact = deps.pluginHostArtifacts.get(registration.pluginId);
  if (artifact === undefined) {
    throw new ApiError(
      409,
      "provider_unavailable",
      "Provider has no live host artifact",
    );
  }
  return { artifact, pluginId: registration.pluginId };
}

export async function listProviderSessions(
  deps: WorkSessionDeps,
  args: ProviderSessionHost,
): Promise<ProviderSessionsResponse> {
  const owner = await providerArtifact(deps, args);
  const listed = contract.listSessions.output.parse(
    await callPluginHostRpc(deps, {
      ...owner,
      contract,
      hostId: args.hostId,
      method: "listSessions",
      input: { providerId: args.providerId },
    }),
  );
  return {
    sessions: listed.sessions.map(({ sourcePath: _, ...session }) => session),
  };
}

export async function importProviderSession(
  deps: WorkSessionDeps,
  args: ProviderSessionHost & { sourceKey: string },
): Promise<ImportProviderSessionResponse> {
  const owner = await providerArtifact(deps, args);
  const imported = contract.importSession.output.parse(
    await callPluginHostRpc(deps, {
      ...owner,
      contract,
      hostId: args.hostId,
      method: "importSession",
      input: { providerId: args.providerId, sourceKey: args.sourceKey },
    }),
  );
  const { session, providerThreadId } = imported;
  if (session.sourceKey !== args.sourceKey) {
    throw new ApiError(
      502,
      "invalid_provider_session",
      "Provider returned a different source session",
    );
  }
  const path = session.cwd;
  if (!isAbsoluteHostPath(path) || path.includes("\0")) {
    throw new ApiError(
      422,
      "invalid_provider_session",
      "Session cwd must be an absolute host path",
    );
  }
  if (isHostPathRoot(path)) {
    throw new ApiError(
      422,
      "invalid_provider_session",
      "Session cwd cannot be a filesystem root",
    );
  }
  const platform = deps.hub.getDaemonPlatformForHost(args.hostId);
  if (
    platform !== null &&
    platform !== "unknown" &&
    (platform === "win32") !== isWindowsHostPath(path)
  ) {
    throw new ApiError(
      422,
      "invalid_provider_session",
      "Session cwd does not match the host platform",
    );
  }

  const notifications = new NotificationBuffer();
  const outcome = deps.db.transaction(
    (tx) => {
      const existing = getProviderSessionOwnerThread(tx, {
        ...args,
        providerThreadId,
      });
      if (existing !== null) return { thread: existing, created: false };
      const { project } = findOrCreateProjectByLocalPathSource(
        tx,
        notifications,
        {
          name: path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path,
          source: { type: "local_path", hostId: args.hostId, path },
        },
      );
      const existingEnvironment = findProjectEnvironmentByHostPath(
        tx,
        project.id,
        args.hostId,
        path,
      );
      if (
        existingEnvironment !== null &&
        (existingEnvironment.status !== "ready" ||
          existingEnvironment.providerOwnsPath ||
          existingEnvironment.environmentProviderId !== null)
      ) {
        throw new ApiError(
          409,
          "environment_unavailable",
          "Session path already belongs to an environment that is not ready and unmanaged",
        );
      }
      const environment =
        existingEnvironment ??
        createEnvironment(tx, notifications, {
          projectId: project.id,
          hostId: args.hostId,
          path,
          status: "ready",
          providerOwnsPath: false,
          environmentProvider: null,
        });
      const thread = createThread(tx, notifications, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: args.providerId,
        title: session.name?.trim() || null,
        titleFallback:
          session.firstMessage.trim().slice(0, 120) ||
          `Imported ${args.providerId} session`,
        status: "idle",
        visibility: "visible",
      });
      setThreadExecutionOverride(tx, {
        threadId: thread.id,
        modelOverride: session.model,
        reasoningLevelOverride: session.reasoningLevel,
      });
      const sequences = appendStoredThreadEventsInTransaction(
        tx,
        providerSessionTranscriptEvents({
          threadId: thread.id,
          environmentId: environment.id,
          imported,
        }),
      );
      notifications.notifyThread(thread.id, ["events-appended"], {
        timelineSequence: sequences.at(-1),
      });
      return { thread, created: true };
    },
    { behavior: "immediate" },
  );

  notifications.flushInto(deps.hub);
  return { threadId: outcome.thread.id, created: outcome.created };
}
