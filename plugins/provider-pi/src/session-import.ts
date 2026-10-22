import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  ExperimentalProviderSession,
  ExperimentalProviderSessionImportResult,
} from "@get-bb/plugin-sdk/host";
import {
  resolvePiBridgeSessionDir,
  resolvePiSessionFilePath,
} from "./bridge/session-paths.js";
import { parsePiSessionImport } from "./session-import-parser.js";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const cachedSourcePaths = new Map<string, { root: string; path: string }>();

interface PiSessionImportContext {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

function sourceKeyFor(root: string, sourcePath: string): string {
  const key = relative(root, sourcePath).split(sep).join("/");
  return `pi:${createHash("sha256").update(key).digest("hex")}`;
}

async function sessionRoot(context: PiSessionImportContext): Promise<string> {
  const path = join(context.homeDir, ".pi", "agent", "sessions");
  return await realpath(path).catch(() => path);
}

async function sessionFiles(context: PiSessionImportContext): Promise<{
  root: string;
  paths: string[];
}> {
  const root = await sessionRoot(context);
  const bridgePath = resolvePiBridgeSessionDir({ env: context.env });
  const bridgeDir = await realpath(bridgePath).catch(() => bridgePath);
  const paths: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    context.signal.throwIfAborted();
    const directory = pending.pop();
    if (!directory || directory === bridgeDir) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        paths.push(path);
    }
  }
  for (const path of paths) {
    cachedSourcePaths.set(sourceKeyFor(root, path), { root, path });
  }
  return { root, paths: paths.sort() };
}

async function loadSession(
  context: PiSessionImportContext,
  root: string,
  path: string,
  includeTranscript = true,
) {
  context.signal.throwIfAborted();
  const canonicalPath = await realpath(path);
  const relativePath = relative(root, canonicalPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Pi session is outside the standalone sessions directory");
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) {
      throw new Error(
        "Pi session must be a regular file no larger than 64 MiB",
      );
    }
    const raw = await file.readFile({ signal: context.signal });
    if (raw.length > MAX_SESSION_BYTES)
      throw new Error("Pi session exceeds 64 MiB");
    const result = parsePiSessionImport({
      contents: new TextDecoder("utf-8", { fatal: true }).decode(raw),
      sourceKey: sourceKeyFor(root, path),
      sourcePath: path,
      modifiedAt: stat.mtime.toISOString(),
      includeTranscript,
    });
    return { ...result, raw };
  } finally {
    await file.close();
  }
}

export async function listPiStandaloneSessions(
  context: PiSessionImportContext,
): Promise<{ sessions: ExperimentalProviderSession[] }> {
  const { root, paths } = await sessionFiles(context);
  const sessions: ExperimentalProviderSession[] = [];
  for (const path of paths) {
    try {
      const result = await loadSession(context, root, path, false);
      sessions.push(result.session);
    } catch {
      context.signal.throwIfAborted();
    }
  }
  sessions.sort(
    (left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt) ||
      left.sourceKey.localeCompare(right.sourceKey),
  );
  return { sessions };
}

async function copySession(
  context: PiSessionImportContext,
  providerThreadId: string,
  raw: Buffer,
): Promise<Buffer> {
  const destination = resolvePiSessionFilePath({
    env: context.env,
    threadId: providerThreadId,
  });
  const directory = resolvePiBridgeSessionDir({ env: context.env });
  await mkdir(directory, { recursive: true });
  const temporaryDir = await mkdtemp(join(directory, ".import-"));
  const temporaryFile = join(temporaryDir, "session.jsonl");
  try {
    const file = await open(temporaryFile, "wx", 0o600);
    try {
      await file.writeFile(raw, { signal: context.signal });
    } finally {
      await file.close();
    }
    context.signal.throwIfAborted();
    try {
      await link(temporaryFile, destination);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      const stat = await lstat(destination);
      if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) {
        throw new Error("Imported Pi session destination is invalid");
      }
      return await readFile(destination);
    }
    return raw;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function importPiStandaloneSession(
  context: PiSessionImportContext,
  sourceKey: string,
): Promise<ExperimentalProviderSessionImportResult> {
  const root = await sessionRoot(context);
  const cached = cachedSourcePaths.get(sourceKey);
  const cachedExists =
    cached?.root === root && (await lstat(cached.path).catch(() => null)) !== null;
  let resolved = cachedExists ? cached : undefined;
  if (resolved === undefined) {
    const discovered = await sessionFiles(context);
    const path = discovered.paths.find(
      (candidate) => sourceKeyFor(discovered.root, candidate) === sourceKey,
    );
    if (path !== undefined) resolved = { root: discovered.root, path };
  }
  if (resolved === undefined) throw new Error("Standalone Pi session not found");
  const source = await loadSession(context, resolved.root, resolved.path);
  const providerThreadId = `pi-import-${createHash("sha256").update(sourceKey).digest("hex")}`;
  const importedRaw = await copySession(context, providerThreadId, source.raw);
  if (importedRaw.equals(source.raw)) {
    return {
      session: source.session,
      providerThreadId,
      transcript: source.transcript,
    };
  }
  const imported = parsePiSessionImport({
    contents: new TextDecoder("utf-8", { fatal: true }).decode(importedRaw),
    sourceKey,
    sourcePath: source.session.sourcePath,
    modifiedAt: source.session.modifiedAt,
  });
  return { ...imported, providerThreadId };
}
