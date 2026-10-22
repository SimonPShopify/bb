import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { SettingsSection } from "@/components/ui/settings-section";
import { useImportProviderSessions } from "@/hooks/mutations/provider-mutations";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useProviderSessions } from "@/hooks/queries/provider-session-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { ChoiceDropdownSetting } from "./ChoiceDropdownSetting";

export function ProviderSessionImportSection({
  providerId,
  displayName,
  disabled,
}: {
  providerId: string;
  displayName: string;
  disabled: boolean;
}) {
  const hostsQuery = useHosts();
  const { localDaemonHostId } = useHostDaemon();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const hosts = selectHosts(hostsQuery.data, "persistent");
  const connectedHosts = hosts.filter((host) => host.status === "connected");
  const host =
    selectedHostId === null
      ? (connectedHosts.find((entry) => entry.id === localDaemonHostId) ??
        connectedHosts[0])
      : hosts.find((entry) => entry.id === selectedHostId);
  const hostId = host?.id ?? null;
  const sessionsQuery = useProviderSessions(providerId, hostId);
  const importSessions = useImportProviderSessions();
  const busy = sessionsQuery.isFetching || importSessions.isPending;
  const canDiscover = !disabled && !busy && host?.status === "connected";
  const sessions = sessionsQuery.data?.sessions;
  const results =
    importSessions.variables?.hostId === hostId
      ? importSessions.data
      : undefined;
  const created =
    results?.filter((result) => result.ok && result.created).length ?? 0;
  const skipped =
    results?.filter((result) => result.ok && !result.created).length ?? 0;
  const failures = results?.filter((result) => !result.ok) ?? [];

  return (
    <SettingsSection
      title={`Import ${displayName} sessions`}
      description="Bring native sessions into BB as idle threads with their history. Projects are matched or created from each session’s directory on the selected machine. Existing imports are skipped."
    >
      <div className="space-y-3">
        <ChoiceDropdownSetting
          label="Machine"
          description="Discover sessions on a connected machine without opening a project."
          triggerAriaLabel="Session import machine"
          options={hosts.map((entry) => ({
            key: entry.id,
            title: entry.name,
            description:
              entry.status === "connected" ? "Connected" : "Disconnected",
            disabled: entry.status !== "connected",
          }))}
          selected={{
            key: hostId ?? "",
            title: host?.name ?? "No connected machines",
          }}
          disabled={disabled || busy || hosts.length === 0}
          onSelect={(id) => {
            setSelectedHostId(id);
            importSessions.reset();
          }}
        />
        {hostsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {hostsQuery.error.message}
          </p>
        ) : null}
        {hostsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading machines…</p>
        ) : connectedHosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect a machine to discover sessions.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canDiscover}
            onClick={() => {
              setSelectedHostId(hostId);
              importSessions.reset();
              void sessionsQuery.refetch();
            }}
          >
            {sessionsQuery.isFetching ? "Discovering…" : "Discover sessions"}
          </Button>
          <Button
            size="sm"
            disabled={
              !canDiscover || sessionsQuery.isError || !sessions?.length
            }
            onClick={() => {
              if (hostId === null || sessions === undefined) return;
              importSessions.mutate({
                providerId,
                hostId,
                sourceKeys: sessions.map((session) => session.sourceKey),
              });
            }}
          >
            {importSessions.isPending ? "Importing…" : "Import all"}
          </Button>
          {sessions !== undefined &&
          !sessionsQuery.isFetching &&
          !sessionsQuery.isError ? (
            <span role="status" className="text-sm text-muted-foreground">
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}{" "}
              found
            </span>
          ) : null}
        </div>
        {sessionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {sessionsQuery.error.message}
          </p>
        ) : null}
        {importSessions.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {importSessions.error.message}
          </p>
        ) : null}
        {results !== undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            {created} created, {skipped} already imported, {failures.length}{" "}
            failed.
          </p>
        ) : null}
        {failures.length > 0 ? (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>Retry safely with Import all; existing threads are skipped.</p>
            {failures.map((result) => (
              <p key={result.sourceKey} className="break-words">
                {result.sourceKey}: {result.error}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
