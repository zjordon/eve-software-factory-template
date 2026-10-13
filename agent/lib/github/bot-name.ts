/**
 * Name used where a resolution failure must not stop the work, like the
 * sandbox commit identity. Matches the template's default persona.
 */
export const FALLBACK_BOT_NAME = "Foreman";

/**
 * Upper bound on a bot name before it is interpolated into a regular
 * expression; GitHub App slugs are far shorter in practice.
 */
const MAX_BOT_NAME_LENGTH = 80;

/**
 * The name the factory answers to in `@mentions`, resolved without setup.
 *
 * @remarks
 * Resolution order: `FACTORY_BOT_NAME`, then `GITHUB_APP_SLUG`, matching
 * the GitHub App this factory acts through. In the self-hosted form the
 * App's slug is a deploy-time fact (the App is created by hand), so an
 * explicit env value is the source of truth and there is no metadata
 * lookup to fall back on.
 *
 * Throws when neither variable is set, and the failure is never cached.
 * That contract is what the channel's lazy `botName` resolution relies on:
 * eve retries a rejection on the next event, so a missing configuration
 * surfaces as a dispatch refusal instead of a silently wrong name. Callers
 * that need an answer no matter what catch and use
 * {@link FALLBACK_BOT_NAME}.
 */
// biome-ignore lint/suspicious/useAwait: the async signature is the contract (eve's lazy botName resolver and every caller await and catch it)
export async function resolveBotName(): Promise<string> {
  const override = process.env.FACTORY_BOT_NAME ?? process.env.GITHUB_APP_SLUG;
  if (
    typeof override !== "string" ||
    override.length === 0 ||
    override.length > MAX_BOT_NAME_LENGTH
  ) {
    throw new Error(
      "Set GITHUB_APP_SLUG (or FACTORY_BOT_NAME) to the GitHub App's slug so @mentions of the factory can be recognized."
    );
  }
  return override;
}

/**
 * Builds the mention matcher for a resolved bot name: `@<name>` on a word
 * boundary, the same shape the channel's built-in comment gate uses.
 *
 * @remarks
 * The name is escaped for literal matching before interpolation, and
 * {@link resolveBotName} bounds its length, so env-supplied data can never
 * change the pattern's meaning.
 */
export function mentionPattern(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu");
}
