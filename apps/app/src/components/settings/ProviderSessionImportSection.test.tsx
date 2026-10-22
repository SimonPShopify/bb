// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import type { ProviderSession } from "@bb/server-contract";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { ProviderSessionImportSection } from "./ProviderSessionImportSection";

const mocks = vi.hoisted(() => ({
  hosts: [] as Host[],
  localDaemonHostId: "local-host" as string | null,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { providers: { listSessions: vi.fn(), importSession: vi.fn() } },
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/host-queries")>()),
  useHosts: () => ({ data: mocks.hosts, isPending: false, isError: false }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ localDaemonHostId: mocks.localDaemonHostId }),
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

function setup(disabled = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderSessionImportSection
        providerId="pi"
        displayName="Pi"
        disabled={disabled}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

async function discover() {
  fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
  await screen.findByText("2 sessions found");
}

beforeEach(() => {
  mocks.hosts = [
    makeHost({ id: "remote-host", name: "Builder", status: "connected" }),
    makeHost({ id: "local-host", name: "My Mac", status: "connected" }),
  ];
  mocks.localDaemonHostId = "local-host";
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
  vi.restoreAllMocks();
});

describe("provider session imports in settings", () => {
  it("discovers on the current local machine only on request, then imports all and refreshes navigation", async () => {
    const { queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    expect(
      screen.getByRole("button", { name: "Session import machine" })
        .textContent,
    ).toContain("My Mac");
    expect(sdk.providers.listSessions).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Import all" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await discover();
    expect(sdk.providers.listSessions).toHaveBeenCalledWith({
      providerId: "pi",
      hostId: "local-host",
      signal: expect.any(AbortSignal),
    });
    vi.mocked(sdk.providers.importSession)
      .mockResolvedValueOnce({ threadId: "thread-new", created: true })
      .mockResolvedValueOnce({ threadId: "thread-existing", created: false });
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await screen.findByText("1 created, 1 already imported, 0 failed.");
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["threads"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["sidebarNavigation"],
    });
  });

  it("never imports a previous machine's discovered keys after switching machines", async () => {
    setup();
    await discover();
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Session import machine" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Builder/ }));
    expect(screen.queryByText("2 sessions found")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Import all" })
        .hasAttribute("disabled"),
    ).toBe(true);
    vi.mocked(sdk.providers.listSessions).mockResolvedValueOnce({
      sessions: [session("remote")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
    await screen.findByText("1 session found");
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await screen.findByText("1 created, 0 already imported, 0 failed.");
    expect(sdk.providers.importSession).toHaveBeenCalledExactlyOnceWith({
      providerId: "pi",
      hostId: "remote-host",
      sourceKey: "remote",
    });
  });

  it("shows busy discovery and import states and prevents duplicate submissions and machine changes", async () => {
    let finishDiscovery: (value: {
      sessions: ProviderSession[];
    }) => void = () => {};
    vi.mocked(sdk.providers.listSessions).mockReturnValueOnce(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Discovering…" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("button", { name: "Session import machine" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => finishDiscovery({ sessions: [session("one")] }));
    await screen.findByText("1 session found");
    let finishImport: (value: {
      threadId: string;
      created: boolean;
    }) => void = () => {};
    vi.mocked(sdk.providers.importSession).mockReturnValueOnce(
      new Promise((resolve) => {
        finishImport = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Importing…" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("button", { name: "Discover sessions" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Session import machine" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () =>
      finishImport({ threadId: "thread-1", created: true }),
    );
    await screen.findByText("1 created, 0 already imported, 0 failed.");
  });

  it("keeps the discovery target fixed when local daemon detection finishes later", async () => {
    mocks.localDaemonHostId = null;
    const view = setup();
    await discover();
    mocks.localDaemonHostId = "local-host";
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <ProviderSessionImportSection
          providerId="pi"
          displayName="Pi"
          disabled={false}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Session import machine" })
        .textContent,
    ).toContain("Builder");
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await screen.findByText("2 created, 0 already imported, 0 failed.");
    expect(sdk.providers.importSession).toHaveBeenCalledWith({
      providerId: "pi",
      hostId: "remote-host",
      sourceKey: "one",
    });
  });

  it("disables importing stale discovery after a refresh fails", async () => {
    setup();
    await discover();
    vi.mocked(sdk.providers.listSessions).mockRejectedValueOnce(
      new Error("Machine disconnected"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
    await screen.findByRole("alert");
    expect(
      screen
        .getByRole("button", { name: "Import all" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(sdk.providers.importSession).not.toHaveBeenCalled();
  });

  it("shows discovery errors, permits retry and handles an empty result", async () => {
    vi.mocked(sdk.providers.listSessions).mockRejectedValueOnce(
      new Error("Provider is unavailable"),
    );
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Provider is unavailable",
    );
    expect(
      screen
        .getByRole("button", { name: "Import all" })
        .hasAttribute("disabled"),
    ).toBe(true);
    vi.mocked(sdk.providers.listSessions).mockResolvedValueOnce({
      sessions: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover sessions" }));
    await screen.findByText("0 sessions found");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Import all" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps partial successes visible and retries failures safely", async () => {
    setup();
    await discover();
    vi.mocked(sdk.providers.importSession).mockRejectedValueOnce(
      new Error("Directory is occupied"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await screen.findByText("1 created, 0 already imported, 1 failed.");
    expect(screen.getByRole("alert").textContent).toContain(
      "one: Directory is occupied",
    );
    expect(sdk.providers.importSession).toHaveBeenCalledTimes(2);
    vi.mocked(sdk.providers.importSession)
      .mockResolvedValueOnce({ threadId: "thread-2", created: true })
      .mockResolvedValueOnce({ threadId: "thread-1", created: false });
    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    await screen.findByText("1 created, 1 already imported, 0 failed.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires a connected machine and respects disabled settings", () => {
    mocks.hosts = [makeHost({ status: "disconnected" })];
    setup();
    expect(
      screen.getByText("Connect a machine to discover sessions."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Discover sessions" })
        .hasAttribute("disabled"),
    ).toBe(true);
    cleanup();
    mocks.hosts = [makeHost({ status: "connected" })];
    setup(true);
    expect(
      screen
        .getByRole("button", { name: "Discover sessions" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(sdk.providers.listSessions).not.toHaveBeenCalled();
  });
});
