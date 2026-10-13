import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GitHubChannelCredentials } from "eve/channels/github";
import { requireEnv } from "../constants.js";

/**
 * The self-held GitHub App's id, required at module load so a missing value
 * fails discovery instead of the first authenticated call.
 */
const GITHUB_APP_ID = requireEnv("GITHUB_APP_ID", "123456");

/**
 * The App installation the factory acts through (the one installed on the
 * factory repository), required at module load for the same reason.
 */
const GITHUB_INSTALLATION_ID = requireEnv("GITHUB_INSTALLATION_ID", "42");

/**
 * Reads the App's private key.
 *
 * @remarks
 * `GITHUB_APP_PRIVATE_KEY_PATH` is preferred: it points at the `.pem` file
 * on the host, avoiding the escaping a multi-line PEM suffers inside an
 * env var. `GITHUB_APP_PRIVATE_KEY` (the value itself) is accepted as a
 * fallback, with literal `\n` sequences converted back to newlines the way
 * hosted platforms store them. Read lazily, once per mint, so a moved file
 * fails the first token mint with a clear error rather than the whole
 * module load.
 */
function readPrivateKey(): string {
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFileSync(path, "utf8");
  }
  const value = requireEnv(
    "GITHUB_APP_PRIVATE_KEY",
    "-----BEGIN RSA PRIVATE KEY----- ..."
  );
  return value.replace(/\\n/g, "\n");
}

/**
 * Creates the short-lived RS256 JWT that authenticates as the App itself.
 *
 * @remarks
 * Issued 60 seconds in the past to absorb clock drift and expiring after 9
 * minutes (GitHub rejects App JWTs that live longer than 10). Signed with
 * Node's native crypto; the PEM never leaves this module.
 */
function createAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: now + 540,
    iat: now - 60,
    iss: GITHUB_APP_ID,
  })}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    createPrivateKey(readPrivateKey())
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** One minted installation token with GitHub's own expiry for it. */
interface Installation {
  expiresAt: Date;
  token: string;
}

/**
 * How long before the reported expiry a cached token is considered stale,
 * so a mint never races the wall clock into using a token GitHub just
 * revoked.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Mints a fresh installation token from the GitHub API.
 *
 * @remarks
 * The error message names the two usual culprits per status code (401: App
 * id or private key; 403/404: installation id or the App not being
 * installed on the factory repository) and quotes a bounded excerpt of
 * GitHub's response body, which never carries credentials.
 */
async function mintInstallation(): Promise<Installation> {
  const response = await fetch(
    `https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "POST",
    }
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const hint =
      response.status === 401
        ? "Check GITHUB_APP_ID and the App private key (GITHUB_APP_PRIVATE_KEY_PATH)."
        : "Check GITHUB_INSTALLATION_ID and that the App is installed on the factory repository.";
    throw new Error(
      `Minting the GitHub installation token failed with HTTP ${response.status}. ${hint} GitHub said: ${detail}`
    );
  }
  const body = (await response.json()) as {
    expires_at?: unknown;
    token?: unknown;
  };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new Error(
      "The GitHub installation token response carries no token or expires_at."
    );
  }
  return { expiresAt: new Date(body.expires_at), token: body.token };
}

let cached: Installation | undefined;
let pending: Promise<Installation> | undefined;

/**
 * Resolves the installation token every GitHub surface of the factory acts
 * with: the channel's API calls, the `github` extension's tools, and the
 * station git operations.
 *
 * @remarks
 * Tokens are minted through eve's native App JWT exchange path (JWT signed
 * with the local PEM, exchanged at the installations endpoint) and cached
 * in process memory until shortly before GitHub's reported expiry; GitHub
 * issues them for one hour. Concurrent callers share one mint via the
 * pending promise. The token reaches the model through no path: it rides
 * the channel's credentials, the extension's token provider, and the
 * sandbox credential arming, none of which expose it.
 */
export async function mintInstallationToken(): Promise<string> {
  if (
    cached !== undefined &&
    cached.expiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()
  ) {
    return cached.token;
  }
  pending ??= mintInstallation().finally(() => {
    pending = undefined;
  });
  cached = await pending;
  return cached.token;
}

/**
 * Bring-your-own GitHub App credentials for the channel, per eve's BYO
 * shape: `appId`/`privateKey` resolved from env, `webhookSecret` left to
 * the channel's own `GITHUB_WEBHOOK_SECRET` fallback, and the minted
 * installation token attached so the git helpers' credential arming can
 * resolve it through the same object.
 */
export const githubCredentials: GitHubChannelCredentials = {
  appId: GITHUB_APP_ID,
  installationToken: mintInstallationToken,
  privateKey: readPrivateKey,
};
