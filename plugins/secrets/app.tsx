import { useMemo, useState } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import { useQuestionFormHost } from "@/components/ui/question-form-host";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import ViewIcon from "@hugeicons/core-free-icons/ViewIcon";
import ViewOffSlashIcon from "@hugeicons/core-free-icons/ViewOffSlashIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SECRET_REQUEST_RENDERER_ID,
  secretRequestPayloadSchema,
  secretRequestResponseSchema,
} from "./src/secret-request.js";
import { reconcileDotenv } from "./src/dotenv.js";

function SecretRequestInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => secretRequestPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [pathExpanded, setPathExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "submit" | "cancel" | null
  >(null);
  const busy = pendingAction !== null;
  const [formError, setFormError] = useState<string | null>(null);
  const { density, closeInline } = useQuestionFormHost();
  const compact = density === "compact";

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This secret request is invalid.
        </p>
        <Button
          variant="outline"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;
  const submitValues = async () => {
    const validated = secretRequestResponseSchema.safeParse({ values });
    if (!validated.success) {
      setFormError(
        "Every secret must be a non-empty single-line value no larger than 16 KiB.",
      );
      return;
    }
    try {
      reconcileDotenv("", validated.data.values);
    } catch {
      setFormError(
        "One value cannot be represented safely in a dotenv assignment.",
      );
      return;
    }
    setFormError(null);
    setPendingAction("submit");
    try {
      await submit({ values });
    } catch {
      setPendingAction(null);
    }
  };
  const cancelRequest = async () => {
    if (closeInline) {
      closeInline();
      return;
    }
    setPendingAction("cancel");
    try {
      await cancel();
    } catch {
      setPendingAction(null);
    }
  };

  const textInset = compact ? "px-2.5" : undefined;

  return (
    <form
      className="flex min-w-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submitValues();
      }}
    >
      <div className={cn("space-y-1", textInset)}>
        {payload.purpose ? (
          <p
            title={compact ? payload.purpose : undefined}
            className={cn(
              "text-pretty text-xs text-foreground",
              compact && "line-clamp-2",
            )}
          >
            {payload.purpose}
          </p>
        ) : null}
        <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">Writes to</span>
          <button
            type="button"
            aria-expanded={pathExpanded}
            aria-label={`Destination ${payload.destination.path}`}
            title={payload.destination.path}
            onClick={() => setPathExpanded((expanded) => !expanded)}
            className="min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {pathExpanded ? (
              <code className="block break-all rounded bg-surface-raised px-1 py-px font-mono text-foreground">
                {payload.destination.path}
              </code>
            ) : (
              <code
                dir="rtl"
                className="block w-min max-w-full truncate rounded bg-surface-raised px-1 py-px font-mono text-foreground"
              >
                {`\u200e${formatHomePathForDisplay(payload.destination.path)}\u200e`}
              </code>
            )}
          </button>
        </p>
      </div>

      <div className={compact ? "mt-2 space-y-2" : "mt-3 space-y-2.5"}>
        {payload.fields.map((field) => {
          const inputId = `secret-${interaction.id}-${field.name}`;
          const isRevealed = revealed[field.name] ?? false;
          return (
            <div key={field.name} className="min-w-0 space-y-1">
              <div
                className={
                  compact
                    ? "flex min-w-0 flex-wrap items-baseline gap-x-2 px-2.5"
                    : "space-y-0.5"
                }
              >
                <Label
                  htmlFor={inputId}
                  className="min-w-0 break-all font-mono text-xs font-medium text-foreground"
                  translate="no"
                >
                  {field.name}
                </Label>
                {field.description ? (
                  <p
                    title={compact ? field.description : undefined}
                    className={cn(
                      "text-xs text-muted-foreground",
                      compact && "min-w-0 grow basis-24 truncate",
                    )}
                  >
                    {field.description}
                  </p>
                ) : null}
              </div>
              <div className="relative">
                <Input
                  id={inputId}
                  name={field.name}
                  type={isRevealed ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  disabled={busy}
                  className={cn(
                    "bg-card pr-9 font-mono text-xs",
                    compact
                      ? "h-7 max-md:pointer-coarse:h-8"
                      : "h-8 max-md:pointer-coarse:h-9",
                  )}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
                  aria-label={`${isRevealed ? "Hide" : "Show"} ${field.name}`}
                  aria-pressed={isRevealed}
                  onClick={() =>
                    setRevealed((current) => ({
                      ...current,
                      [field.name]: !current[field.name],
                    }))
                  }
                  disabled={busy}
                >
                  <HugeiconsIcon
                    icon={isRevealed ? ViewOffSlashIcon : ViewIcon}
                    className="size-3.5"
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {formError ? (
        <p
          className="mt-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
          aria-live="polite"
        >
          {formError}
        </p>
      ) : null}

      <div
        className={cn(
          "flex items-center justify-between gap-2",
          compact
            ? "mt-1.5"
            : "sticky -bottom-3 z-10 -mb-3 mt-1 border-t border-border/70 bg-surface-recessed-solid pb-3 pt-2",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={compact ? "font-normal" : undefined}
          disabled={busy}
          onClick={() => void cancelRequest()}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className={compact ? "font-normal" : undefined}
          disabled={busy}
        >
          {pendingAction === "submit" ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              className="size-3 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          Add secrets
        </Button>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: SECRET_REQUEST_RENDERER_ID,
    component: SecretRequestInteraction,
  });
});
