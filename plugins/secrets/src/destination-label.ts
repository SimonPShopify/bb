export interface DestinationParts {
  stem: string;
  extension: string;
  folder: string | null;
}

const DRIVE = /^[A-Za-z]:$/;

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

export function splitDestination(path: string): DestinationParts {
  const separator = lastSeparator(path);
  const name = path.slice(separator + 1);
  if (!name) return { stem: path, extension: "", folder: null };
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  if (separator < 0) return { stem, extension, folder: null };
  const folder = path.slice(0, separator) || path.slice(0, 1);
  return {
    stem,
    extension,
    folder: DRIVE.test(folder) ? `${folder}${path[separator]}` : folder,
  };
}

export function lastFolderLabel(folder: string): string {
  const trimmed = folder.length > 1 ? folder.replace(/[\\/]+$/, "") : folder;
  const separator = lastSeparator(trimmed);
  if (separator < 0) return folder;
  const last = trimmed.slice(separator + 1);
  if (!last) return folder;
  const parent = trimmed.slice(0, separator);
  if (!parent || DRIVE.test(parent)) return trimmed;
  return `…${trimmed[separator]}${last}`;
}
