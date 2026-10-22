// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderSession } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { OnboardingPiSessionImport } from "./OnboardingPiSessionImport";

vi.mock("@/lib/sdk", () => ({
  sdk: { providers: { listSessions: vi.fn(), importSession: vi.fn() } },
}));

function session(sourceKey: string): ProviderSession {
  return {
    sourceKey,
    sessionId: sourceKey,
    cwd: "/workspace/project",
    name: "Native session",
    firstMessage: "Hello",
    createdAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T01:00:00Z",
    messageCount: 2,
    model: null,
    reasoningLevel: null,
  };
}

const clients: QueryClient[] = [];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <OnboardingPiSessionImport hostId="local-host" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(sdk.providers.listSessions)
    .mockReset()
    .mockResolvedValue({ sessions: [session("one"), session("two")] });
  vi.mocked(sdk.providers.importSession)
    .mockReset()
    .mockResolvedValue({ threadId: "thread-1", created: true });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("Pi session import during onboarding", () => {
  it("discovers existing sessions automatically and imports them from the setup machine", async () => {
    setup();

    expect(await screen.findByText("2 existing sessions found.")).toBeTruthy();
    expect(sdk.providers.listSessions).toHaveBeenCalledExactlyOnceWith({
      providerId: "pi",
      hostId: "local-host",
      signal: expect.any(AbortSignal),
    });

    fireEvent.click(screen.getByRole("button", { name: "Import 2" }));

    expect(
      await screen.findByText("2 imported, 0 already in bb, 0 failed."),
    ).toBeTruthy();
    expect(sdk.providers.importSession).toHaveBeenNthCalledWith(1, {
      providerId: "pi",
      hostId: "local-host",
      sourceKey: "one",
    });
    expect(sdk.providers.importSession).toHaveBeenNthCalledWith(2, {
      providerId: "pi",
      hostId: "local-host",
      sourceKey: "two",
    });
  });
});
