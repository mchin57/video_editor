/**
 * Windows file-name rules, shared by the renderer (live feedback in a dialog)
 * and main (which re-checks before touching the disk). The project-name rule
 * (`projectName.ts`) and generated media's `safeFileName` (main
 * `projectLayout.ts`) use the same character and device-name tables.
 * @see docs/MEDIA-POINTERS.md "Rename"
 */

/** Characters Windows refuses in a file or folder name (plus control characters). */
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

/** Windows device names, alone or with any extension ("con", "COM1", "nul.txt"). */
export const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Longest file name (one path component, extension included) NTFS accepts. */
export const FILE_NAME_MAX = 255

/** The last segment of a path, with either separator. */
export function pathBaseName(path: string): string {
  const m = /[^\\/]*$/.exec(path)
  return m ? m[0] : path
}

/**
 * A file name split into its stem and extension, the way Explorer and
 * `path.extname` do: the extension is the last `.xxx`; a leading dot alone
 * (".gitignore") is not one. `stem + ext === name`.
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.')
  if (i <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, i), ext: name.slice(i) }
}

/**
 * `null` when `stem` (trimmed) plus the fixed `ext` makes a valid Windows file
 * name, else a short user-facing reason. Judged after trimming, so a trailing
 * space can never reach the disk; a trailing dot is refused outright.
 */
export function validateFileStem(stem: string, ext: string): string | null {
  const s = stem.trim()
  if (!s) return 'Enter a name.'
  if (FORBIDDEN_NAME_CHARS.test(s)) return 'A name can’t contain < > : " / \\ | ? * or control characters.'
  if (s.endsWith('.')) return 'A name can’t end with a dot.'
  if (RESERVED_DEVICE_NAME.test(s) || RESERVED_DEVICE_NAME.test(s + ext)) {
    return `“${s}” is reserved by Windows. Choose another name.`
  }
  const max = FILE_NAME_MAX - ext.length
  if (s.length > max) return `Keep the name to ${max} characters or fewer.`
  return null
}
