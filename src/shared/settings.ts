/** User settings, persisted to <dataDir>/settings.json. */
export interface Settings {
  /** Default folder the export Save dialog opens to. */
  exportDir: string
  /** Niche keywords the checklist scores spoken audio against. */
  keywordBank: string[]
}

/** Default niche keyword bank (triathlon coaching, from the strategy notes). */
export const DEFAULT_KEYWORD_BANK: string[] = [
  'triathlon training',
  'triathlon coach',
  'ironman 70.3',
  'first triathlon',
  'sprint triathlon',
  'olympic triathlon',
  'swim technique',
  'open water swimming',
  'freestyle technique',
  'brick workout',
  'zone 2',
  'race day nutrition',
  'transition tips',
  'masters swimming'
]
