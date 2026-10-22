import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";

export type ComposerPlaceholderState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed"; onRetry: () => void }
  | { kind: "crashed"; pluginTitle: string; onReload: () => void };

export function ComposerPlaceholder({
  state,
}: {
  state: ComposerPlaceholderState;
}) {
  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading composer"
        data-composer-placeholder="loading"
        className="rounded-xl border border-border bg-background shadow-lift"
      >
        <Skeleton className="m-3 h-3 w-1/2 rounded-sm" />
        <div className="h-[68px]" />
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <div
        role="status"
        data-composer-placeholder="missing"
        className="px-1 py-2 text-sm text-muted-foreground"
      >
        No composer plugin is enabled.
      </div>
    );
  }
  const alert =
    state.kind === "failed"
      ? {
          message: "The composer couldn't load.",
          action: "Retry",
          onClick: state.onRetry,
        }
      : {
          message: `${state.pluginTitle} stopped working.`,
          action: "Reload",
          onClick: state.onReload,
        };
  return (
    <div
      role="alert"
      data-composer-placeholder={state.kind}
      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground"
    >
      <span>{alert.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={alert.onClick}>
        {alert.action}
      </Button>
    </div>
  );
}
