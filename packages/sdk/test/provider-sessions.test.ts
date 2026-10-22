import { describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("provider session import SDK", () => {
  it("routes listing and import to an explicit provider and host with cancellation", async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/import"))
          return Response.json({ threadId: "thread", created: false });
        return Response.json({ sessions: [] });
      },
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch,
      }),
    });
    expect(
      await sdk.providers.listSessions({
        providerId: "pi",
        hostId: "host",
        signal,
      }),
    ).toEqual({ sessions: [] });
    expect(
      await sdk.providers.importSession({
        providerId: "pi",
        hostId: "host",
        sourceKey: "opaque-source",
        signal,
      }),
    ).toEqual({ threadId: "thread", created: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = fetch.mock.calls[0]!;
    expect(String(listUrl)).toBe(
      "http://bb.test/api/v1/system/providers/pi/sessions?hostId=host",
    );
    expect(listInit?.signal).toBe(signal);
    const [importUrl, importInit] = fetch.mock.calls[1]!;
    expect(String(importUrl)).toBe(
      "http://bb.test/api/v1/system/providers/pi/sessions/import",
    );
    expect(importInit?.method).toBe("POST");
    expect(importInit?.signal).toBe(signal);
    expect(JSON.parse(String(importInit?.body))).toEqual({
      hostId: "host",
      sourceKey: "opaque-source",
    });
  });

  it("propagates host/provider import failures", async () => {
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch: async () =>
          Response.json(
            { code: "provider_unavailable", message: "No live artifact" },
            { status: 409 },
          ),
      }),
    });
    await expect(
      sdk.providers.importSession({
        providerId: "pi",
        hostId: "host",
        sourceKey: "session",
      }),
    ).rejects.toThrow("No live artifact");
  });
});
