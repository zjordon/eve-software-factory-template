import { eveChannel } from "eve/channels/eve";
import { operatorRouteAuth } from "../lib/route-auth.js";

/**
 * The eve route channel (`/eve/v1`), authenticated with the shared operator
 * policy.
 *
 * @remarks
 * The policy itself lives in `agent/lib/route-auth.ts` (extracted when the
 * dashboard channel needed the same credentials): HTTP Basic in every form,
 * plus the dev-TUI identity inside `eve dev`. See that module for the
 * self-hosting posture the Basic entry carries.
 */
export default eveChannel({ auth: operatorRouteAuth });
