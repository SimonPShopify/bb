import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
  experimental_providerSessionImportHostContract,
} from "@get-bb/plugin-sdk/host";
import { resolvePiNativeRoots } from "./native-roots.js";
import {
  importPiStandaloneSession,
  listPiStandaloneSessions,
} from "./session-import.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export default experimental_defineHostEntry({
  contract: {
    ...experimental_nativeRootsHostContract,
    ...experimental_providerSessionImportHostContract,
  },
  handlers: {
    resolveNativeRoots: () =>
      resolvePiNativeRoots({ homeDir: homedir(), env: process.env }),
    listSessions: ({ providerId }, context) => {
      if (providerId !== "pi")
        throw new Error(`Unsupported provider: ${providerId}`);
      return listPiStandaloneSessions({
        homeDir: homedir(),
        env: process.env,
        signal: context.signal,
      });
    },
    importSession: ({ providerId, sourceKey }, context) => {
      if (providerId !== "pi")
        throw new Error(`Unsupported provider: ${providerId}`);
      return importPiStandaloneSession(
        { homeDir: homedir(), env: process.env, signal: context.signal },
        sourceKey,
      );
    },
  },
});
