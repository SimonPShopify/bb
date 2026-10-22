import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useImportProviderSessions } from "@/hooks/mutations/provider-mutations";
import { useProviderSessions } from "@/hooks/queries/provider-session-queries";

export function OnboardingPiSessionImport({ hostId }: { hostId: string }) {
  const sessionsQuery = useProviderSessions("pi", hostId, true);
  const importSessions = useImportProviderSessions();
  const sessions = sessionsQuery.data?.sessions;
  const results = importSessions.data;
  const created =
    results?.filter((result) => result.ok && result.created).length ?? 0;
  const skipped =
    results?.filter((result) => result.ok && !result.created).length ?? 0;
  const failures = results?.filter((result) => !result.ok) ?? [];
  const busy = sessionsQuery.isFetching || importSessions.isPending;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-hairline pt-3">
      <div className="flex items-start gap-2">
        <Icon
          name="Clock"
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Bring your Pi history into bb</p>
          <p className="text-xs text-muted-foreground">
            Existing Pi sessions become idle threads that you can continue in
            bb.
          </p>
        </div>
        {sessions !== undefined && sessions.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (results !== undefined && failures.length === 0)}
            onClick={() =>
              importSessions.mutate({
                providerId: "pi",
                hostId,
                sourceKeys: sessions.map((session) => session.sourceKey),
              })
            }
          >
            {importSessions.isPending
              ? "Importing…"
              : results !== undefined && failures.length === 0
                ? "Imported"
                : failures.length > 0
                  ? "Retry import"
                  : `Import ${sessions.length}`}
          </Button>
        ) : null}
      </div>
      {sessionsQuery.isPending || sessionsQuery.isFetching ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking for existing sessions…
        </p>
      ) : sessionsQuery.isError ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {sessionsQuery.error.message}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void sessionsQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : sessions?.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          No existing Pi sessions found.
        </p>
      ) : results === undefined ? (
        <p role="status" className="text-xs text-muted-foreground">
          {sessions?.length} existing{" "}
          {sessions?.length === 1 ? "session" : "sessions"} found.
        </p>
      ) : (
        <p
          role={failures.length > 0 ? "alert" : "status"}
          className={
            failures.length > 0
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {created} imported, {skipped} already in bb, {failures.length} failed.
        </p>
      )}
    </div>
  );
}
