import { upsertProjectExecutionDefaults } from "@bb/db";
import { describe, expect, it } from "vitest";
import type { ThreadCreateServiceRequestInput } from "../../src/services/threads/thread-create-request.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("child creation execution defaults", () => {
  const cases = [
    {
      name: "inherits same-provider parent model and reasoning",
      parentProviderId: "codex",
      hasParentExecution: true,
      request: {},
      expected: {
        providerId: "codex",
        model: "parent-model",
        reasoningLevel: "low",
      },
    },
    {
      name: "inherits parent provider ahead of project defaults",
      parentProviderId: "claude-code",
      hasParentExecution: true,
      request: {},
      expected: {
        providerId: "claude-code",
        model: "parent-model",
        reasoningLevel: "low",
      },
    },
    {
      name: "does not inherit incompatible execution with an explicit provider",
      parentProviderId: "claude-code",
      hasParentExecution: true,
      request: { providerId: "codex" },
      expected: {
        providerId: "codex",
        model: "project-model",
        reasoningLevel: "medium",
      },
    },
    {
      name: "keeps parent defaults with an explicit matching provider",
      parentProviderId: "claude-code",
      hasParentExecution: true,
      request: { providerId: "claude-code" },
      expected: {
        providerId: "claude-code",
        model: "parent-model",
        reasoningLevel: "low",
      },
    },
    {
      name: "honors explicit model and reasoning ahead of the parent",
      parentProviderId: "codex",
      hasParentExecution: true,
      request: { model: "requested-model", reasoningLevel: "high" },
      expected: {
        providerId: "codex",
        model: "requested-model",
        reasoningLevel: "high",
      },
    },
    {
      name: "falls back to project defaults without parent execution",
      parentProviderId: "claude-code",
      hasParentExecution: false,
      request: {},
      expected: {
        providerId: "codex",
        model: "project-model",
        reasoningLevel: "medium",
      },
    },
    {
      name: "ignores unowned picker values before inheriting parent execution",
      parentProviderId: "claude-code",
      hasParentExecution: true,
      request: {
        providerId: "codex",
        model: "stale-model",
        reasoningLevel: "high",
        executionInputSources: {},
      },
      expected: {
        providerId: "claude-code",
        model: "parent-model",
        reasoningLevel: "low",
      },
    },
  ] satisfies {
    name: string;
    parentProviderId: string;
    hasParentExecution: boolean;
    request: Pick<
      ThreadCreateServiceRequestInput,
      "providerId" | "model" | "reasoningLevel" | "executionInputSources"
    >;
    expected: { providerId: string; model: string; reasoningLevel: string };
  }[];

  it.each(cases)(
    "$name",
    async ({ parentProviderId, hasParentExecution, request, expected }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const parent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: parentProviderId,
        });
        if (hasParentExecution) {
          seedThreadRuntimeState(harness.deps, {
            threadId: parent.id,
            environmentId: environment.id,
            providerThreadId: "parent-session",
            model: "parent-model",
            reasoningLevel: "low",
            permissionMode: "auto",
          });
        }
        upsertProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          providerId: "codex",
          model: "project-model",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
        });

        const child = await createThreadFromRequest(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          environment: { type: "reuse", environmentId: environment.id },
          input: textInput("Check execution defaults"),
          origin: "cli",
          startedOnBehalfOf: null,
          ...request,
        });
        const start = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === child.id,
        );
        expect(start.command.type).toBe("thread.start");
        if (start.command.type !== "thread.start") {
          throw new Error("Expected child start command");
        }
        expect({
          providerId: child.providerId,
          model: start.command.options.model,
          reasoningLevel: start.command.options.reasoningLevel,
        }).toEqual(expected);
      });
    },
  );
});
