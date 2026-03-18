// All values injected at build time via Vite environment variables.
// These are set by build.sh reading docnet.config.json.

export const uiConfig = {
  projectName:      import.meta.env.VITE_PROJECT_NAME      || 'Document Network',
  welcomeTitle:     import.meta.env.VITE_WELCOME_TITLE     || 'Welcome',
  welcomeBody:      import.meta.env.VITE_WELCOME_BODY      || '',
  howToUse:         JSON.parse(import.meta.env.VITE_HOW_TO_USE || '[]') as string[],
  searchPlaceholder:import.meta.env.VITE_SEARCH_PLACEHOLDER || 'Search entities...',
  repoUrl:          import.meta.env.VITE_REPO_URL          || null,
  accentColor:      import.meta.env.VITE_ACCENT_COLOR      || 'blue',
  aiAttributionNote:import.meta.env.VITE_AI_ATTRIBUTION_NOTE || '',
  principalName:    import.meta.env.VITE_PRINCIPAL_NAME    || '',
  hopFilterEnabled: import.meta.env.VITE_HOP_FILTER_ENABLED === 'true',
  yearRangeMin:     parseInt(import.meta.env.VITE_YEAR_RANGE_MIN || '1970'),
  yearRangeMax:     parseInt(import.meta.env.VITE_YEAR_RANGE_MAX || '2025'),
  defaultLimit:     parseInt(import.meta.env.VITE_DEFAULT_LIMIT  || '9600'),
  mobileLimit:      parseInt(import.meta.env.VITE_MOBILE_LIMIT   || '3000'),
  includeUndatedDefault: import.meta.env.VITE_INCLUDE_UNDATED_DEFAULT === 'true',
} as const;
