import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { DockerSandboxSession } from "eve/sandbox/docker";
import type { VercelSandboxSession } from "eve/sandbox/vercel";
import {
  DOCKER_SANDBOX_BACKEND,
  FACTORY_BRANCH_PREFIX,
  FACTORY_REPO,
} from "../constants.js";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Conservative subset of valid git branch names: alphanumeric segments
 * separated by `.`, `_`, `-` or `/`. Everything the git commands interpolate
 * has to match this, so shell metacharacters can never reach the command
 * line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Where the station sandboxes keep the factory repository checkout.
 */
export const REPO_DIR = "/workspace/repo";

/**
 * The URL every clone, fetch, and push targets, literally.
 *
 * @remarks
 * Git remote config inside a sandbox (`pushurl`, `pushDefault`, per-branch
 * remotes) is model-writable and must not be able to redirect the brokered
 * credential, so the git helpers never go through `origin`.
 */
export const REMOTE_URL = `https://github.com/${FACTORY_REPO}.git`;

/**
 * Returns the refusal reason, or null when the branch name may be used in a
 * git command.
 *
 * @remarks
 * `refs/heads/main` and `HEAD` would reach a protected branch under another
 * name, so only plain branch names are accepted, and the protected branches
 * themselves are refused outright: the factory delivers pull requests, never
 * direct pushes to the default branch. The factory branch prefix is required
 * for the same structural reason: the GitHub channel runs the red-CI fix
 * loop only on pull requests whose head branch carries it, so a push under
 * any other prefix would silently lose that safety net. Enforcing it here
 * makes the invariant a property of the pipeline instead of a naming
 * convention the implementer has to remember.
 */
export function validateBranch(branch: string): string | null {
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.includes("..") ||
    branch.includes("//")
  ) {
    return `"${branch}" is not a valid branch name.`;
  }
  if (branch.startsWith("refs/") || branch === "HEAD") {
    return `"${branch}" is not a plain branch name. Pass the branch name without a refs/ prefix.`;
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  if (!branch.startsWith(FACTORY_BRANCH_PREFIX)) {
    return `Branch names must start with "${FACTORY_BRANCH_PREFIX}" (e.g. ${FACTORY_BRANCH_PREFIX}bug-dedupe-reset-emails); "${branch}" is refused. Rename the branch to the ${FACTORY_BRANCH_PREFIX} form and push again.`;
  }
  return null;
}

/**
 * Firewall policy that brokers the installation token onto egress to
 * github.com only, mirroring the shape eve's own channel checkout uses.
 *
 * @remarks
 * The token never enters the sandbox process; the firewall injects the header
 * on the way out. `"*": []` keeps general egress open so package installs and
 * test runs keep working while the policy is active.
 */
export function brokerPolicy(installationToken: string): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(
    `x-access-token:${installationToken}`
  ).toString("base64")}`;
  return {
    allow: {
      "*": [],
      "github.com": [
        { transform: [{ headers: { Authorization: authorization } }] },
      ],
    },
  };
}

/**
 * A sandbox session from either factory backend: hosted Vercel (firewall
 * credential injection) or local Docker (credential-helper injection).
 */
export type FactorySandboxSession = DockerSandboxSession | VercelSandboxSession;

/**
 * Where the Docker backend keeps the git credential store during an armed
 * window. Outside /workspace so no model-authored file operation stumbles
 * over it by accident.
 */
const DOCKER_CREDENTIAL_STORE = "/tmp/.factory-git-credentials";

/**
 * Makes the installation token usable by git inside the sandbox for the
 * duration of one credentialed operation.
 *
 * @remarks
 * Vercel backend: the token is brokered at the sandbox firewall (header
 * injection on egress to github.com only) and never enters the sandbox.
 * Docker backend: the firewall has no injection capability (coarse
 * policies only), so the token is written to a file-backed git credential
 * helper instead. That is the documented self-hosting downgrade: the token
 * is short-lived (one hour), lives only between this call and
 * {@link disarmGitCredentials}, and never appears in a shell command line
 * (the file is written through sandbox file I/O, not `run`).
 *
 * The backend is read from the same `FACTORY_SANDBOX_BACKEND` switch that
 * picked the environment, so the arming always matches the session type;
 * the casts below hold by that construction.
 */
export async function armGitCredentials(
  sandbox: FactorySandboxSession,
  token: string
): Promise<void> {
  if (DOCKER_SANDBOX_BACKEND) {
    const docker = sandbox as DockerSandboxSession;
    await docker.writeTextFile({
      content: `https://x-access-token:${token}@github.com\n`,
      path: DOCKER_CREDENTIAL_STORE,
    });
    await docker.run({
      command: `git config --global credential.helper 'store --file=${DOCKER_CREDENTIAL_STORE}'`,
    });
    return;
  }
  await (sandbox as VercelSandboxSession).setNetworkPolicy(brokerPolicy(token));
}

/**
 * Drops the credential again after a credentialed operation, in a
 * `finally`: Vercel reopens general egress, Docker removes the credential
 * store file and its git config entry.
 */
export async function disarmGitCredentials(
  sandbox: FactorySandboxSession
): Promise<void> {
  if (DOCKER_SANDBOX_BACKEND) {
    const docker = sandbox as DockerSandboxSession;
    await docker.run({
      command:
        "git config --global --unset-all credential.helper >/dev/null 2>&1 || true",
    });
    await docker.removePath({ force: true, path: DOCKER_CREDENTIAL_STORE });
    return;
  }
  await (sandbox as VercelSandboxSession).setNetworkPolicy("allow-all");
}
