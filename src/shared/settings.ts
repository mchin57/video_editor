/** User settings, persisted to <dataDir>/settings.json. */
export interface Settings {
  /** Default folder the export Save dialog opens to. */
  exportDir: string
  /** Niche keywords the checklist scores spoken audio against. */
  keywordBank: string[]
  /** Saved brand colors (hex, 6- or 8-digit) for one-tap apply to overlays /
   *  captions. Global for now; moves under the active profile when the
   *  Platform-profiles system lands. */
  brandColors: string[]
  /** Claude Code connection (AI assistant). */
  assistant: AssistantSettings
  /** Audio extracted from footage joins the Default volume level as it lands
   *  on the timeline (shared/volumeLevels.ts `extractedAudioClip`). On by
   *  default; turning it off never removes clips already in Default. */
  autoJoinDefaultLevel: boolean
}

/** The auto-join setting with its default (on) for a missing/odd value. */
export function withAutoJoinDefault(loaded: unknown): boolean {
  return typeof loaded === 'boolean' ? loaded : true
}

/** Starter brand palette — high-attention colors common in Reels captions.
 *  White first (the default fill); the rest are accents/highlights. */
export const DEFAULT_BRAND_COLORS: string[] = [
  '#FFFFFF', // white — default fill
  '#000000', // black — on light footage / stroke
  '#FFE600', // IG yellow — keyword/last-word highlight
  '#FF3B30', // punch red — urgency
  '#FF9500', // energy orange
  '#A8FF00', // lime — high-energy pop
  '#00D1FF', // cyan — cool accent
  '#0A84FF', // brand blue
  '#FF2D95', // magenta pop
  '#AF52DE' //  purple
]

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

export interface AssistantSettings {
  /** Serve Claude Code over the named pipe (on by default; Settings can switch it off). */
  enabled: boolean
}

export function withAssistantDefaults(loaded: Partial<AssistantSettings> | undefined): AssistantSettings {
  return { enabled: typeof loaded?.enabled === 'boolean' ? loaded.enabled : true }
}

/** The one-time registration line Settings shows. `scriptPath` = absolute path of out/main/mcp.js. */
export function mcpAddCommand(scriptPath: string): string {
  return `claude mcp add --scope user reel-editor -- node "${scriptPath}"`
}
