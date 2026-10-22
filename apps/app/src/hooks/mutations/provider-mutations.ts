import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { applyProviderAvailabilityChange } from "../cache-owners/system-cache-effects";
import {
  invalidateProjectSourceQueries,
  invalidateThreadListQueries,
} from "../cache-owners/mutation-cache-effects";

interface ImportProviderSessionsArgs {
  providerId: string;
  hostId: string;
  sourceKeys: string[];
}

type SessionImportResult =
  | { sourceKey: string; threadId: string; created: boolean; ok: true }
  | { sourceKey: string; error: string; ok: false };

export function useImportProviderSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { showErrorToast: false },
    mutationFn: async ({
      providerId,
      hostId,
      sourceKeys,
    }: ImportProviderSessionsArgs) => {
      const results: SessionImportResult[] = [];
      for (const sourceKey of new Set(sourceKeys)) {
        try {
          const result = await sdk.providers.importSession({
            providerId,
            hostId,
            sourceKey,
          });
          results.push({ ...result, sourceKey, ok: true });
        } catch (error) {
          results.push({
            sourceKey,
            error:
              error instanceof Error
                ? error.message
                : "Could not import session.",
            ok: false,
          });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      if (!results.some((result) => result.ok && result.created)) return;
      invalidateProjectSourceQueries({ queryClient, projectId: undefined });
      invalidateThreadListQueries({ queryClient });
    },
  });
}

export function useSetProviderEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Could not change provider availability." },
    mutationFn: (args: { providerId: string; enabled: boolean }) =>
      sdk.providers.setEnabled(args),
    onSuccess: (catalog) =>
      applyProviderAvailabilityChange({ queryClient, catalog }),
  });
}
