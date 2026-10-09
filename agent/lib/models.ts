import { createAnthropic } from "@ai-sdk/anthropic";

// One place to change every agent's model. The upstream template uses Vercel AI
// Gateway strings (<provider>/<model>); this fork points every agent at Zhipu's
// Anthropic-compatible endpoint instead, so a GLM Coding Plan subscription
// covers the usage. The key comes from ZHIPU_API_KEY (env), never hardcoded;
// ZHIPU_BASE_URL overrides the endpoint (set it to https://api.z.ai/api/anthropic/v1
// on the international plan). The /v1 suffix is required: @ai-sdk/anthropic v4
// appends /messages to the baseURL without inserting the version segment, and
// Zhipu's gateway answers the versionless path with HTTP 200 and an empty
// stream, which surfaces as AI_NoOutputGeneratedError.
const zhipu = createAnthropic({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL:
    process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic/v1",
});

export const MODELS = {
  analyst: zhipu("glm-5.3"),
  classifier: zhipu("glm-5.3-flash"), // fast triage on the flash tier
  implementer: zhipu("glm-5.3"), // the station that writes the code gets the strongest coding model
  orchestrator: zhipu("glm-5.3"),
  researcher: zhipu("glm-5.3-flash"),
  reviewer: zhipu("glm-5.3"), // same vendor as implementer: the single-provider tradeoff of this fork
} as const;

export type FactoryAgent = keyof typeof MODELS;

// Context window per agent, in tokens. GLM-5.3 is 1M per Zhipu's published
// specs; the flash entry is declared conservatively at 200K until the plan's
// model page confirms its window. eve needs this number to compile compaction
// triggers, and models outside the AI Gateway catalog carry no metadata, so
// each agent.ts passes its entry as `modelContextWindowTokens` alongside
// `model`. Keep the numbers in sync with the model ids above.
export const MODEL_CONTEXT_WINDOW_TOKENS: Record<FactoryAgent, number> = {
  analyst: 1_000_000,
  classifier: 200_000,
  implementer: 1_000_000,
  orchestrator: 1_000_000,
  researcher: 200_000,
  reviewer: 1_000_000,
};
