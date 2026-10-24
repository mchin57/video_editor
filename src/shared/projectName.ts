/**
 * Project-name rule, shared by the New-project window (live feedback) and main
 * (which re-checks before creating `<location>/<Name>/<Name>.reel`). The name
 * becomes a Windows folder AND file name, so it follows Windows' rules (the
 * tables live in `fileName.ts`). Callers use the TRIMMED name; this judges the
 * trimmed form.
 * @see docs/MEDIA-POINTERS.md "The project folder"
 */

import { BIDI_CONTROL_CHARS, BIDI_CONTROL_REASON, FORBIDDEN_NAME_CHARS, RESERVED_DEVICE_NAME } from './fileName'

/** Longest name accepted (the folder name; `.reel` is appended for the file). */
export const PROJECT_NAME_MAX = 100

/** `null` when `name` (trimmed) is a valid project name, else a short user-facing reason. */
export function validateProjectName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a name.'
  if (n.length > PROJECT_NAME_MAX) return `Keep the name to ${PROJECT_NAME_MAX} characters or fewer.`
  if (FORBIDDEN_NAME_CHARS.test(n)) return 'A name can’t contain < > : " / \\ | ? * or control characters.'
  if (BIDI_CONTROL_CHARS.test(n)) return BIDI_CONTROL_REASON
  if (n.endsWith('.')) return 'A name can’t end with a dot.'
  if (RESERVED_DEVICE_NAME.test(n)) return `“${n}” is reserved by Windows. Choose another name.`
  return null
}
