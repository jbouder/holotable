/**
 * Optional secrets, set with `wrangler secret put` when the demo should call a
 * model. Not in `secrets.required` because the demo runs without them, so
 * `wrangler types` does not generate them.
 */
interface Env {
  AI_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_API?: string;
}
