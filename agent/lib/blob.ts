import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";

/**
 * Which backend the document helpers below use: the hosted Vercel Blob store
 * (`"vercel"`, the default, authorized by the ambient Vercel OIDC
 * credentials) or a local filesystem directory (`"local"`, the self-hosted
 * form, rooted at `FACTORY_DATA_DIR`).
 *
 * @remarks
 * The reserved-namespace registry and every guard above the helpers are
 * backend-independent; only the three document helpers branch, so both forms
 * enforce the same layout.
 */
const FACTORY_BLOB_BACKEND = process.env.FACTORY_BLOB_BACKEND ?? "vercel";

if (FACTORY_BLOB_BACKEND !== "vercel" && FACTORY_BLOB_BACKEND !== "local") {
  throw new Error(
    `FACTORY_BLOB_BACKEND must be "vercel" or "local" (e.g. 'local'), got '${FACTORY_BLOB_BACKEND}'.`
  );
}

const LOCAL_BLOB_BACKEND = FACTORY_BLOB_BACKEND === "local";

/**
 * Root directory for the local backend, resolved at module load so relative
 * values anchor to the process working directory.
 */
const DATA_DIR = resolve(process.env.FACTORY_DATA_DIR ?? ".eve/blob-data");

/**
 * Maps a document key to its local-backend path, refusing keys that would
 * escape the data directory.
 *
 * @remarks
 * Keys are derived by the feature modules (principal ids, `FACTORY_REPO`,
 * pattern-validated artifact ids), never raw model input, but the filesystem
 * backend still gets a containment check: defense in depth costs one
 * comparison.
 */
function localDocumentPath(key: string): string {
  const path = resolve(DATA_DIR, key);
  if (path !== DATA_DIR && !path.startsWith(`${DATA_DIR}${sep}`)) {
    throw new Error(
      `Refusing a document key that escapes the data directory: ${key}`
    );
  }
  return path;
}

/** Extracts the `ENOENT` marker from a filesystem error, or null. */
const enoentCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;

/**
 * The factory's shared Blob layer: the reserved-namespace registry and the document helpers
 * every Blob-backed tool reads and writes through.
 *
 * @remarks
 * Everything the factory stores lives in one Blob store, so the path layout is a shared concern
 * rather than a per-feature one. This module owns that layout: the reserved prefixes, what each
 * holds, and which tool owns it. Any general-purpose Blob tool added later must consult
 * {@link reservedNamespaceForPath} / {@link reservedNamespaceForUrl} before acting, so a managed
 * document (the factory brain, a user's preferences, a handoff artifact) can't be reached or
 * overwritten through a generic file operation.
 *
 * Feature modules import their prefix from here rather than declaring their own. The dependency
 * points toward storage on purpose: adding a namespace is a single edit in this file, and the
 * guards can only be complete if one module sees every prefix.
 *
 * The document helpers carry the store's shared posture (exact pathnames,
 * Markdown) in one place. They stay neutral about errors: storage failures
 * propagate, and each tool maps them to its own output shape. The backend is
 * `FACTORY_BLOB_BACKEND`: the hosted Vercel Blob store (authorized by the
 * ambient Vercel OIDC credentials) or a local filesystem directory
 * (`FACTORY_DATA_DIR`) for the self-hosted form.
 */

/** Blob path prefix holding per-user preference files. */
export const USER_PREFERENCES_PREFIX = "user-preferences/";

/** Blob path prefix holding the shared factory brain. */
export const FACTORY_BRAIN_PREFIX = "factory-brain/";

/** Blob path prefix holding handoff artifacts passed between stations. */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * A Blob path prefix that a general-purpose Blob tool must not touch.
 *
 * @remarks
 * `writeTool` and `readTool` name the tools that own the namespace, so a guard can tell the
 * model where to go instead of only refusing.
 */
interface ReservedNamespace {
  /** Human-readable description of what the namespace holds. */
  readonly label: string;
  /** Tool that reads this namespace. */
  readonly readTool: string;
  /** Tool that owns writes to this namespace. */
  readonly writeTool: string;
}

/**
 * Every reserved prefix, keyed by the prefix itself.
 *
 * @remarks
 * Add a namespace here and every guard call site starts covering it, with no change at the
 * call sites.
 */
const RESERVED_NAMESPACES: Readonly<Record<string, ReservedNamespace>> = {
  [ARTIFACTS_PREFIX]: {
    label: "handoff artifacts",
    readTool: "read_artifact",
    writeTool: "save_artifact",
  },
  [FACTORY_BRAIN_PREFIX]: {
    label: "the shared factory brain",
    readTool: "read_factory_brain",
    writeTool: "update_factory_brain",
  },
  [USER_PREFERENCES_PREFIX]: {
    label: "user preferences",
    readTool: "get_user_preferences",
    writeTool: "save_user_preferences",
  },
};

/** Leading slashes stripped from a pathname or URL path before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Find the reserved namespace a Blob pathname falls under, if any.
 *
 * @remarks
 * Leading slashes are stripped first because `@vercel/blob`'s `put` normalizes a pathname by
 * dropping them, so a caller-supplied `/factory-brain/x.md` would land inside the reserved
 * namespace unless the guard sees the normalized form.
 *
 * @param pathname - A Blob object pathname, e.g. `drafts/post.md`.
 * @returns The matching namespace, or `null` when the path is not reserved.
 */
export const reservedNamespaceForPath = (
  pathname: string
): ReservedNamespace | null => {
  const normalized = pathname.replace(LEADING_SLASHES, "");
  for (const [prefix, namespace] of Object.entries(RESERVED_NAMESPACES)) {
    if (normalized.startsWith(prefix)) {
      return namespace;
    }
  }
  return null;
};

/**
 * Find the reserved namespace a Blob URL points at, if any.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path. Unparseable input is treated as
 * not reserved; the caller's own URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns The matching namespace, or `null` when the URL is not reserved.
 */
export const reservedNamespaceForUrl = (
  url: string
): ReservedNamespace | null => {
  try {
    return reservedNamespaceForPath(new URL(url).pathname);
  } catch {
    return null;
  }
};

/**
 * Build the refusal message for a write blocked by a reserved namespace.
 *
 * @param namespace - The namespace the path or URL fell under.
 * @returns A message naming the owning tool, for the model to act on.
 */
export const reservedWriteMessage = (namespace: ReservedNamespace): string =>
  `That path is reserved for ${namespace.label}: use ${namespace.writeTool} instead.`;

/**
 * Build the refusal message for a read blocked by a reserved namespace.
 *
 * @param namespace - The namespace the path or URL fell under.
 * @returns A message naming the owning read tool.
 */
export const reservedReadMessage = (namespace: ReservedNamespace): string =>
  `That path holds ${namespace.label}: use ${namespace.readTool} instead.`;

/**
 * Read a Markdown document from the store by its exact key.
 *
 * @remarks
 * Reads through the authenticated `get` path rather than listing and fetching a public URL, so
 * one call resolves both existence and content. A missing document is a normal state
 * (`found: false`), not an error; API failures propagate for the caller to map onto its own
 * output shape.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @returns The document `content` and `uploadedAt` (ISO string) when found.
 */
export const readDocument = async (
  key: string
): Promise<
  { found: false } | { content: string; found: true; uploadedAt: string }
> => {
  if (LOCAL_BLOB_BACKEND) {
    const path = localDocumentPath(key);
    try {
      const [content, info] = await Promise.all([
        readFile(path, "utf8"),
        stat(path),
      ]);
      return {
        content,
        found: true,
        uploadedAt: info.mtime.toISOString(),
      };
    } catch (error) {
      if (enoentCode(error) === "ENOENT") {
        return { found: false };
      }
      throw error;
    }
  }
  const result = await get(key, { access: "public" });
  if (!result?.stream) {
    return { found: false };
  }
  return {
    content: await new Response(result.stream).text(),
    found: true,
    uploadedAt: result.blob.uploadedAt.toISOString(),
  };
};

/**
 * Write a Markdown document to the store at its exact key.
 *
 * @remarks
 * Carries the store's shared write posture: public access (the store is provisioned public;
 * unguessability comes from the hashed or suffixed keys the feature modules derive), no random
 * suffix (the key is the identity), Markdown content type. Overwrite is the caller's decision:
 * the singleton documents (brain, preferences) replace themselves, while artifacts are
 * write-once.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @param contents - The full Markdown document.
 * @param options - Whether an existing document at the key may be replaced.
 * @returns The stored blob's metadata (callers report `pathname`).
 */
export const writeDocument = async (
  key: string,
  contents: string,
  options: { allowOverwrite: boolean }
): Promise<{ pathname: string }> => {
  if (LOCAL_BLOB_BACKEND) {
    const path = localDocumentPath(key);
    if (!options.allowOverwrite) {
      try {
        await stat(path);
        throw new Error(
          `A document already exists at ${key} and may not be overwritten.`
        );
      } catch (error) {
        if (enoentCode(error) !== "ENOENT") {
          throw error;
        }
      }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
    return { pathname: key };
  }
  return put(key, contents, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite,
    contentType: "text/markdown",
  });
};

/**
 * Delete a document from the store by its exact key.
 *
 * @remarks
 * Checks existence first so callers can tell "deleted" from "nothing to delete": `del` itself
 * is silent about missing objects, and `clear_user_preferences` reports the difference.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @returns Whether a document existed at the key (and was deleted).
 */
export const deleteDocument = async (
  key: string
): Promise<{ existed: boolean }> => {
  if (LOCAL_BLOB_BACKEND) {
    const path = localDocumentPath(key);
    try {
      await stat(path);
    } catch (error) {
      if (enoentCode(error) === "ENOENT") {
        return { existed: false };
      }
      throw error;
    }
    await unlink(path);
    return { existed: true };
  }
  try {
    await head(key);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return { existed: false };
    }
    throw error;
  }
  await del(key);
  return { existed: true };
};
