import { Command } from "commander";
import { collectDeclaredSessionOptions, type AvailableModel } from "@bb/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProviderInfo,
} from "@bb/server-contract";
import { action, CliExitError } from "../action.js";
import { resolveLocalHostId } from "../daemon.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable, truncateCell } from "../table.js";
import { collectOption, getErrorMessage, outputJson } from "./helpers.js";
import { resolveMachineEnvironmentRouting } from "./machine.js";

interface ProviderListCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  all?: boolean;
  machine?: string;
}

interface ProviderModelsCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  machine?: string;
  project?: string;
  selectedModel?: string;
}

interface ProviderSessionsCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  machine?: string;
  sourceKey?: string[];
}

interface IncludeSelectedOnlyModelArgs {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  selectedModel?: string;
}

function addProviderRoutingOptions(command: Command): Command {
  return command
    .option("--machine <id-or-name>", "Machine whose providers should be used")
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--environment <id>",
      "Environment whose machine providers should be used",
    );
}

export function registerProviderCommands(
  program: Command,
  getUrl: () => string,
): void {
  const provider = program
    .command("provider")
    .description("Manage providers, models and native sessions");

  addProviderRoutingOptions(provider.command("list"))
    .description("List available providers")
    .option(
      "--all",
      "Include disabled providers and providers whose plugins are disabled",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ProviderListCommandOptions) => {
        const serverUrl = getUrl();
        const sdk = createCliBbSdk(serverUrl);
        if (opts.all) {
          if (opts.machine || opts.host || opts.environment)
            throw new Error(
              "--all shows the global provider catalog; omit --machine, --host and --environment.",
            );
          const catalog = await sdk.providers.catalog();
          if (outputJson(opts, catalog)) return;
          const rows = catalog.map((entry) => [
            entry.id,
            entry.displayName,
            !entry.pluginEnabled
              ? "Plugin disabled"
              : !entry.enabled
                ? "Disabled"
                : entry.available
                  ? "Enabled"
                  : "Unavailable",
          ]);
          printBorderlessTable(
            {
              head: ["ID", "Name", "Status"],
              colWidths: columnWidths(rows, [4, 4, 6]),
            },
            rows,
          );
          return;
        }
        const providers = await sdk.providers.list(
          await resolveMachineEnvironmentRouting(opts, serverUrl),
        );
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No providers available");
          return;
        }
        printProviderTable(providers);
      }),
    );

  addProviderRoutingOptions(provider.command("sessions <providerId>"))
    .description(
      "Discover native provider sessions on a machine (local by default)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (providerId: string, opts: ProviderSessionsCommandOptions) => {
          const serverUrl = getUrl();
          const hostId = await resolveSessionHostId(opts, serverUrl);
          const result = await createCliBbSdk(serverUrl).providers.listSessions(
            {
              providerId,
              hostId,
            },
          );
          if (outputJson(opts, result)) return;
          if (result.sessions.length === 0) {
            console.log("No sessions found");
            return;
          }
          const rows = result.sessions.map((session) => [
            session.sourceKey,
            truncateCell(
              session.name || session.firstMessage || session.sessionId,
              60,
            ),
            session.cwd,
            String(session.messageCount),
          ]);
          printBorderlessTable(
            {
              head: ["Source key", "Name", "Directory", "Messages"],
              colWidths: columnWidths(rows, [10, 4, 9, 8]),
            },
            rows,
          );
        },
      ),
    );

  addProviderRoutingOptions(provider.command("import-sessions <providerId>"))
    .description("Import native provider sessions as threads (all by default)")
    .option(
      "--source-key <key>",
      "Import only this source key (repeatable)",
      (value: string, previous: string[] = []) =>
        collectOption(value, previous),
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (providerId: string, opts: ProviderSessionsCommandOptions) => {
          const serverUrl = getUrl();
          const sdk = createCliBbSdk(serverUrl);
          const hostId = await resolveSessionHostId(opts, serverUrl);
          const { sessions } = await sdk.providers.listSessions({
            providerId,
            hostId,
          });
          const availableKeys = new Set(
            sessions.map((session) => session.sourceKey),
          );
          const sourceKeys = [...new Set(opts.sourceKey ?? availableKeys)];
          const missing = sourceKeys.filter((key) => !availableKeys.has(key));
          if (missing.length > 0) {
            throw new Error(
              `Sessions not found on this machine: ${missing.join(", ")}`,
            );
          }
          const results = [];
          let created = 0;
          let skipped = 0;
          let failed = 0;
          if (!opts.json && sourceKeys.length > 0) {
            console.error(
              `Importing ${sourceKeys.length} sessions from ${providerId}…`,
            );
          }
          for (const sourceKey of sourceKeys) {
            try {
              const result = await sdk.providers.importSession({
                providerId,
                hostId,
                sourceKey,
              });
              results.push({ sourceKey, ...result });
              if (result.created) created += 1;
              else skipped += 1;
              if (!opts.json)
                console.log(
                  `${result.created ? "Created" : "Existing"} thread ${result.threadId}`,
                );
            } catch (error) {
              const message = getErrorMessage(error);
              results.push({ sourceKey, error: message });
              failed += 1;
              if (!opts.json) console.error(`${sourceKey}: ${message}`);
            }
          }
          if (!outputJson(opts, { results, created, skipped, failed })) {
            console.log(
              `${created} created, ${skipped} already imported, ${failed} failed`,
            );
          }
          if (failed > 0)
            throw new CliExitError(
              `${failed} sessions could not be imported. Retry safely; existing threads are skipped.`,
              1,
            );
        },
      ),
    );

  for (const enabled of [true, false]) {
    provider
      .command(`${enabled ? "enable" : "disable"} <providerId>`)
      .description(
        enabled
          ? "Enable a provider and its supplying plugin if needed"
          : "Disable a provider without uninstalling its CLI or disabling its plugin",
      )
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (providerId: string, opts: { json?: boolean }) => {
          const catalog = await createCliBbSdk(getUrl()).providers.setEnabled({
            providerId,
            enabled,
          });
          if (outputJson(opts, catalog)) return;
          console.log(`${providerId} ${enabled ? "enabled" : "disabled"}`);
        }),
      );
  }

  addProviderRoutingOptions(provider.command("models [providerId]"))
    .description("List available models for a provider")
    .option(
      "--project <id>",
      "Project whose checkout on the machine the provider reads its models and options from",
    )
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--selected-model <model>",
      "Include a selected-only model if it matches",
    )
    .action(
      action(
        async (
          providerId: string | undefined,
          opts: ProviderModelsCommandOptions,
        ) => {
          if (opts.project !== undefined && opts.environment !== undefined) {
            throw new Error(
              "Cannot combine --project with --environment; the environment already selects its workspace.",
            );
          }
          const serverUrl = getUrl();
          const sdk = createCliBbSdk(serverUrl);
          const routing = await resolveMachineEnvironmentRouting(
            opts,
            serverUrl,
          );
          const executionOptions = await sdk.providers.models({
            ...(routing.environmentId !== undefined ||
            opts.project === undefined
              ? routing
              : { ...routing, projectId: opts.project }),
            ...(providerId ? { providerId } : {}),
          });
          const models = includeSelectedOnlyModel({
            models: executionOptions.models,
            selectedOnlyModels: executionOptions.selectedOnlyModels,
            selectedModel: opts.selectedModel,
          });
          printModelLoadError(executionOptions.modelLoadError);
          if (outputJson(opts, models)) return;
          if (models.length === 0) {
            console.log("No models available");
            return;
          }
          printModelTable(models, providerId);
        },
      ),
    );
}

async function resolveSessionHostId(
  opts: ProviderSessionsCommandOptions,
  serverUrl: string,
): Promise<string> {
  const routing = await resolveMachineEnvironmentRouting(opts, serverUrl);
  if (routing.environmentId !== undefined) {
    return (
      await createCliBbSdk(serverUrl).environments.get({
        environmentId: routing.environmentId,
      })
    ).hostId;
  }
  return routing.hostId ?? (await resolveLocalHostId());
}

function includeSelectedOnlyModel(
  args: IncludeSelectedOnlyModelArgs,
): AvailableModel[] {
  if (!args.selectedModel) {
    return args.models;
  }
  if (args.models.some((model) => model.model === args.selectedModel)) {
    return args.models;
  }
  const selectedOnlyModel = args.selectedOnlyModels.find(
    (model) => model.model === args.selectedModel,
  );
  return selectedOnlyModel ? [selectedOnlyModel, ...args.models] : args.models;
}

function printProviderTable(providers: SystemProviderInfo[]): void {
  const rows = providers.map((provider) => [provider.id, provider.displayName]);
  printBorderlessTable(
    {
      head: ["ID", "Name"],
      colWidths: columnWidths(rows, [4, 4]),
    },
    rows,
  );
}

function printModelLoadError(
  modelLoadError: SystemExecutionOptionsModelLoadError | null,
): void {
  if (modelLoadError === null) {
    return;
  }
  console.error(
    `Could not load models for ${modelLoadError.providerId} (${modelLoadError.code})`,
  );
  if (modelLoadError.detail !== null) {
    console.error(`  ${modelLoadError.detail}`);
  }
}

function printModelTable(models: AvailableModel[], providerId?: string): void {
  if (providerId) {
    console.log(`Models for ${providerId}:`);
  }

  const listsServiceTiers = models.some(
    (model) => model.supportedServiceTiers !== undefined,
  );
  const rows = models.map((model) => [
    model.model,
    model.displayName ?? model.model,
    model.isDefault ? "*" : "",
    ...(listsServiceTiers
      ? [
          model.supportedServiceTiers === undefined
            ? ""
            : model.supportedServiceTiers.length === 0
              ? "-"
              : model.supportedServiceTiers.map((tier) => tier.id).join(", "),
        ]
      : []),
  ]);
  printBorderlessTable(
    {
      head: [
        "Model",
        "Name",
        "Default",
        ...(listsServiceTiers ? ["Service tiers"] : []),
      ],
      colWidths: columnWidths(
        rows,
        listsServiceTiers ? [5, 4, 7, 13] : [5, 4, 7],
      ),
      trimTrailingWhitespace: true,
    },
    rows,
  );
  for (const line of formatDeclaredSessionOptions(models)) {
    console.log(line);
  }
}

export function formatDeclaredSessionOptions(
  models: readonly AvailableModel[],
): string[] {
  const options = collectDeclaredSessionOptions(models);
  if (options.length === 0) {
    return [];
  }
  return [
    "",
    "Options (set with bb thread spawn --option <id>=<value>):",
    ...options.map((option) =>
      option.type === "boolean"
        ? `  ${option.id} (${option.label}): true | false, default ${String(option.value)}`
        : `  ${option.id} (${option.label}): ${option.values
            .map((value) => value.id)
            .join(" | ")}, default ${option.value}`,
    ),
  ];
}
