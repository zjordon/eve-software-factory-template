/**
 * Reads a required environment variable, throwing if it is unset so
 * misconfiguration fails fast instead of surfacing mid-request.
 *
 * @remarks
 * Call it at module load when the value is needed for discovery (connector
 * UIDs, channel credentials), or inside a handler when a missing value
 * should not prevent the rest of the agent from loading.
 *
 * @param name - The environment variable name.
 * @param example - An example value, included in the error message.
 * @returns The environment variable's value.
 */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is not set (e.g. '${example}').`
    );
  }
  return value;
}

/**
 * The repository the factory works on, as `owner/repo`.
 *
 * @remarks
 * Required at module load so a missing value fails discovery instead of
 * producing a factory with no target. Every surface reads this one constant:
 * the GitHub extension's default context, the station sandboxes' clone, and
 * the push URL.
 */
export const FACTORY_REPO = requireEnv("FACTORY_REPO", "acme/widgets");

// GitHub's own naming rules: owner is alphanumeric with inner hyphens, repo
// adds dots and underscores. Catching a malformed value here fails discovery
// with a clear message instead of a cryptic clone error on a station's first session.
const FACTORY_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

if (!FACTORY_REPO_PATTERN.test(FACTORY_REPO)) {
  throw new Error(
    `FACTORY_REPO must reference an existing GitHub repository in owner/repo format (e.g. 'acme/widgets'), got '${FACTORY_REPO}'.`
  );
}

const [factoryOwner = "", factoryRepoName = ""] = FACTORY_REPO.split("/");

/**
 * {@link FACTORY_REPO} split into the `owner` / `repo` fields GitHub tools
 * take, validated at module load.
 */
export const factoryRepo = { owner: factoryOwner, repo: factoryRepoName };

/**
 * The GitHub label that hands an issue to the factory. Overridable with the
 * `FACTORY_LABEL` environment variable.
 *
 * @remarks
 * Applying it requires triage permission on the repository, so the trigger is
 * maintainer-initiated even though the resulting run is unattended.
 */
export const FACTORY_LABEL = process.env.FACTORY_LABEL ?? "factory";

/**
 * Branch-name prefix for the factory's own feature branches. Overridable
 * with the `FACTORY_BRANCH_PREFIX` environment variable.
 *
 * @remarks
 * The implementer names its branches `factory/<type>-<slug>`; the GitHub
 * channel uses the prefix to recognize the factory's own pull requests, so
 * the red-CI fix loop never runs on branches people pushed, and
 * `validateBranch` refuses git operations outside the prefix so the two
 * can't drift apart. The git tool descriptions interpolate this constant
 * directly; the implementer's instructions still carry the default prefix
 * as prose, so an override should keep them in sync
 * (`agent/subagents/implementer/instructions.md`).
 */
export const FACTORY_BRANCH_PREFIX =
  process.env.FACTORY_BRANCH_PREFIX ?? "factory/";

/**
 * Which sandbox backend the factory's sandboxes open.
 *
 * @remarks
 * `"vercel"` (the default) opens hosted Vercel Sandboxes and brokers the
 * git credential at the sandbox firewall; `"docker"` opens local Docker
 * containers and passes the credential through an in-container git
 * credential helper instead. The switch is read by every factory sandbox
 * environment (root and stations) plus the git credential arm/disarm pair
 * in `agent/lib/github/git-remote.ts`, so both halves of a session always
 * agree on how credentials travel.
 */
const FACTORY_SANDBOX_BACKEND = process.env.FACTORY_SANDBOX_BACKEND ?? "vercel";

if (
  FACTORY_SANDBOX_BACKEND !== "vercel" &&
  FACTORY_SANDBOX_BACKEND !== "docker"
) {
  throw new Error(
    `FACTORY_SANDBOX_BACKEND must be "vercel" or "docker" (e.g. 'docker'), got '${FACTORY_SANDBOX_BACKEND}'.`
  );
}

/**
 * Whether the factory runs on the local Docker sandbox backend.
 */
export const DOCKER_SANDBOX_BACKEND = FACTORY_SANDBOX_BACKEND === "docker";
