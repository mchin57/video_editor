/**
 * Project-name rule, shared by the New-project window (live feedback) and main
 * (which re-checks before creating `<location>/<Name>/<Name>.reel`). The name
 * becomes a Windows folder AND file name, so it follows Windows' rules.
 * Callers use the TRIMMED name; this judges the trimmed form.
 * @see docs/MEDIA-POINTERS.md "The project folder"
 */

/** Longest name accepted (the folder name; `.reel` is appended for the file). */
export const PROJECT_NAME_MAX = 100

/** Windows device names, alone or with any extension ("con", "COM1", "nul.txt"). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/

/** `null` when `name` (trimmed) is a valid project name, else a short user-facing reason. */
export function validateProjectName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a name.'
  if (n.length > PROJECT_NAME_MAX) return `Keep the name to ${PROJECT_NAME_MAX} characters or fewer.`
  if (FORBIDDEN.test(n)) return 'A name can’t contain < > : " / \\ | ? * or control characters.'
  if (n.endsWith('.')) return 'A name can’t end with a dot.'
  if (RESERVED.test(n)) return `“${n}” is reserved by Windows. Choose another name.`
  return null
}
