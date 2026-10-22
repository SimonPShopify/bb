import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  githubPrStatusRpcContract,
  type PullRequest,
} from "bb-plugin-bb--github-pr-status/contract";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
} from "@/lib/plugin-sdk-hooks";

export interface EnvironmentPullRequestState {
  isLoading: boolean;
  pullRequest: PullRequest | null;
}

export function useEnvironmentPullRequest(
  environmentId: string | null | undefined,
  options: { enabled?: boolean } = {},
): EnvironmentPullRequestState {
  const enabled = (options.enabled ?? true) && Boolean(environmentId);
  const query = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusRpcContract,
    method: "pullRequests",
    keys: enabled && environmentId ? [environmentId] : [],
    enabled,
  });
  const row = environmentId ? query.data?.[environmentId] : undefined;
  return {
    isLoading: enabled && query.error === null && row === undefined,
    pullRequest: row?.outcome === "available" ? row.pullRequest : null,
  };
}

export function usePullRequestActions() {
  const markReady = experimental_useRpcMutation({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusRpcContract,
    method: "markReady",
  });
  const markDraft = experimental_useRpcMutation({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusRpcContract,
    method: "markDraft",
  });
  const merge = experimental_useRpcMutation({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusRpcContract,
    method: "merge",
  });
  return {
    isPending: markReady.isPending || markDraft.isPending || merge.isPending,
    markReady: markReady.mutate,
    markDraft: markDraft.mutate,
    merge: merge.mutate,
  };
}
