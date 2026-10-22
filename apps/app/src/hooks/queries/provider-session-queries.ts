import { useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";

export function useProviderSessions(
  providerId: string,
  hostId: string | null,
  enabled = false,
) {
  return useQuery({
    queryKey: ["providerSessions", providerId, hostId],
    queryFn: ({ signal }) => {
      if (hostId === null) throw new Error("Choose a connected machine first.");
      return sdk.providers.listSessions({ providerId, hostId, signal });
    },
    enabled: enabled && hostId !== null,
    retry: false,
  });
}
