/**
 * The concierge agent shares the support demo's DeepSeek env loader so a single
 * repo-root `.env.local` (DEEPSEEK_API_KEY, optional DEEPSEEK_MODEL_ID/BASE_URL)
 * powers both agents. Set DEEPSEEK_MODEL_ID=deepseek-v4-flash for cheap iteration.
 */
export {
  getSupportModel as getConciergeModel,
  loadSupportEnv as loadConciergeEnv,
  resolveSupportModelConfig as resolveConciergeModelConfig,
} from "../support/env";
