/**
 * Which recents this person keeps, as the browser-side gates read it.
 *
 * Its own module, free of the preference schemas (#493): the root layout's
 * history provider needs this and nothing else, and importing it from
 * `preferences.ts` put zod in every route's first load.
 */
export interface HistoryPreferences {
  prompts: boolean;
  recentDashboards: boolean;
  paletteHistory: boolean;
}

export const KEEP_ALL_HISTORY: HistoryPreferences = {
  prompts: true,
  recentDashboards: true,
  paletteHistory: true,
};
