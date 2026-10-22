# Provider-native session import

List sessions on a connected host, then import the opaque source key:

```ts
const { sessions } = await sdk.providers.listSessions({
  providerId: "pi",
  hostId,
});
const session = sessions[0];
if (session) {
  const { threadId, created } = await sdk.providers.importSession({
    providerId: "pi",
    hostId,
    sourceKey: session.sourceKey,
  });
}
```

Both methods accept an optional `signal: AbortSignal`.

HTTP equivalents:

- `GET /api/v1/system/providers/:id/sessions?hostId=HOST_ID` returns
  `{ sessions: ProviderSession[] }`.
- `POST /api/v1/system/providers/:id/sessions/import` accepts
  `{ hostId, sourceKey }` and returns `{ threadId, created }`.

The host and provider are explicit. The server uses the provider's owning live
plugin host artifact, not the server filesystem. Only providers implementing the
session-import host contract support these operations; Pi is the first provider.

Importing an already-owned provider session on the same host returns its existing
thread with `created: false`, without appending history or changing its state.
Concurrent imports do not create duplicate threads. Archived imports remain the
owner and can be unarchived; deleted threads and deleted projects are not returned.

New imports use a local-path project for the session's absolute, non-root cwd on
that host, with a ready unmanaged environment for that path. A path already occupied
by an incompatible environment is rejected with HTTP 409, never converted or
taken over. Relative or empty cwd values are rejected with HTTP 422. Subdirectories
are not silently replaced with a parent project or repository root.

The new thread is idle and visible. It retains the native name or a first-message
title fallback, normalized transcript timestamps, provider session identity, and
available model/reasoning metadata. Normal thread send APIs resume that provider
session. If the native session has no model metadata and the project has no model
default, select a model when sending the first follow-up. Import does not start a
turn, provision a managed checkout, or change project execution defaults.

The same flow is available through `bb provider sessions`,
`bb provider import-sessions`, and Settings → Providers.
