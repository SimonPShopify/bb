import type {
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemProviderCatalogEntry,
  SystemProvidersQuery,
  ProviderSession,
  ProviderSessionsResponse,
  ImportProviderSessionResponse,
} from "@bb/server-contract";
import {
  readExecutionOptions,
  signalRequestArgs,
  type CreateSdkAreaArgs,
} from "./common.js";

export type ProviderHostRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export type ProviderListArgs = ProviderHostRoutingArgs & {
  capability?: SystemProvidersQuery["capability"];
  signal?: AbortSignal;
};
export type ProviderModelsArgs = (
  | { environmentId: string; hostId?: never; projectId?: never }
  | { environmentId?: never; hostId: string; projectId?: string }
  | { environmentId?: never; hostId?: never; projectId?: string }
) & {
  providerId?: string;
  signal?: AbortSignal;
};

export type ProviderListResult = SystemProviderInfo[];
export type ProviderModelsResult = SystemExecutionOptionsResponse;

export type ProviderSessionListArgs = {
  providerId: string;
  hostId: string;
  signal?: AbortSignal;
};
export type ProviderSessionImportArgs = ProviderSessionListArgs & {
  sourceKey: string;
};
export type ProviderSessionListResult = ProviderSessionsResponse;
export type ProviderSessionImportResult = ImportProviderSessionResponse;
export type { ProviderSession };

export interface ProvidersArea {
  listSessions(
    args: ProviderSessionListArgs,
  ): Promise<ProviderSessionListResult>;
  importSession(
    args: ProviderSessionImportArgs,
  ): Promise<ProviderSessionImportResult>;
  catalog(): Promise<SystemProviderCatalogEntry[]>;
  setEnabled(args: {
    providerId: string;
    enabled: boolean;
  }): Promise<SystemProviderCatalogEntry[]>;
  list(args?: ProviderListArgs): Promise<ProviderListResult>;
  models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
}

export function createProvidersArea(args: CreateSdkAreaArgs): ProvidersArea {
  const { transport } = args;
  return {
    async listSessions(input) {
      return transport.readJson(
        transport.api.v1.system.providers[":id"].sessions.$get(
          {
            param: { id: input.providerId },
            query: { hostId: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async importSession(input) {
      return transport.readJson(
        transport.api.v1.system.providers[":id"].sessions.import.$post(
          {
            param: { id: input.providerId },
            json: { hostId: input.hostId, sourceKey: input.sourceKey },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async catalog() {
      return transport.readJson(
        transport.api.v1.system.providers.catalog.$get(),
      );
    },
    async setEnabled(input) {
      return transport.readJson(
        transport.api.v1.system.providers[":id"].enabled.$put({
          param: { id: input.providerId },
          json: { enabled: input.enabled },
        }),
      );
    },
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.$get(
          {
            query: {
              capability: input.capability,
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async models(input = {}) {
      return readExecutionOptions(transport, input);
    },
  };
}
