/**
 * The response header that names a first generation attempt, so the browser
 * can ask for its one repair (#21). Its own module because the browser needs
 * it and the rest of `repair.ts` is server-side.
 */
export const GENERATION_ID_HEADER = "X-Generation-Id";
