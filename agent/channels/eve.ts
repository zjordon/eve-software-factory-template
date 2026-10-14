import {
  type AuthFn,
  httpBasic,
  localDev,
  withAuthChallenges,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { requireEnv } from "../lib/constants.js";

const basicAuth = httpBasic({
  password: requireEnv(
    "ROUTE_AUTH_BASIC_PASSWORD",
    "a-random-secret-of-32-characters-or-more"
  ),
  username: requireEnv("ROUTE_AUTH_BASIC_USERNAME", "foreman"),
});

/**
 * Self-hosted production auth: HTTP Basic against a shared operator
 * credential from the environment.
 *
 * @remarks
 * `eve start` (the pm2-resident form) fails closed: `localDev()` authenticates
 * nothing outside an `eve dev` process and there is no Vercel environment for
 * `vercelOidc()`, so without this entry the resident service would reject every
 * request. The credential holder is the operator themselves; keep the password
 * long and random, and treat it as live on whatever network the port is
 * reachable from (HTTPS arrives with the M3 tunnel).
 */
const upgradeBasic: AuthFn<Request> = async (request) => {
  const basic = await basicAuth(request);
  // Same upgrade the dev shim applies: the factory's preference tools key
  // storage on a `principalType: "user"` session, and the Basic credential
  // holder is a person. This grants no trust: approval policies read the
  // trusted/autonomous stamps, which Basic never sets, so callers still park
  // on approvals exactly like the dev TUI does.
  return basic ? { ...basic, principalType: "user" } : null;
};

// withAuthChallenges restamps the Basic scheme this wrapper satisfies: a bare
// AuthFn declares no challenge, so routeAuth's 401 would fall back to Bearer.
const basicUser = withAuthChallenges(upgradeBasic, [
  { parameters: { charset: "UTF-8", realm: "eve" }, scheme: "Basic" },
]);

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The user-preference tools key their storage on a `principalType: "user"` session. In
 * production the channels supply one; the eve dev TUI authenticates with `localDev()`,
 * whose `local-dev` principal is not a user, so user-scoped tool calls fail with
 * `principal_required`. This shim defers the trust decision to `localDev()` — returning `null`
 * for anything it would reject, so it never affects production — and only upgrades the resolved
 * principal to a user. Drop it if you don't exercise user-scoped tools from the dev TUI.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local ? { ...local, principalType: "user" } : null;
};

export default eveChannel({ auth: [basicUser, localDevUser] });
