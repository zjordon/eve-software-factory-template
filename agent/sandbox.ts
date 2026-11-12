import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { VercelSandbox } from "eve/sandbox/vercel";
import { DOCKER_SANDBOX_BACKEND } from "./lib/constants.js";
import { FACTORY_SANDBOX_CREATE_OPTIONS } from "./lib/github/repo-sandbox.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Follows `FACTORY_SANDBOX_BACKEND`: local Docker containers (self-hosted
 * form, no Vercel linkage required) or the hosted Vercel Sandbox backend
 * (cloud form, requires the project to be linked and authenticated to
 * Vercel). The same switch governs the station sandboxes and how git
 * credentials travel into them (`agent/lib/github/git-remote.ts`).
 *
 * The post-open init marks `/workspace` as a safe git directory before the
 * GitHub channel's built-in per-turn checkout runs there. The sandbox
 * filesystem is owned by the builder uid, not the session user, so without
 * this git aborts every command with "detected dubious ownership in
 * repository at '/workspace'", the channel swallows the failed checkout,
 * and the turn runs with no working tree. The station sandboxes handle the
 * same hazard for `/workspace/repo` in `agent/lib/github/repo-sandbox.ts`.
 */
export const environment = DOCKER_SANDBOX_BACKEND
  ? DockerSandbox.environment()
  : VercelSandbox.environment(FACTORY_SANDBOX_CREATE_OPTIONS);

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  const result = await sandbox.run({
    command: "git config --global --add safe.directory /workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout
      ).trim()}`
    );
  }
  return sandbox;
});
