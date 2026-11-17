/**
 * A clip's or image's colour look as the ffmpeg fragment that draws it — the
 * export twin of the preview's choice between the CSS filters and the WebGL
 * colour table (components/preview/GradeCanvas.tsx):
 *
 * - only the old three sliders and the colour wash → `gradeFilter`, today's
 *   `lutrgb` / `colorchannelmixer` strings, byte for byte;
 * - a newer control or a LUT → the whole look baked into one table
 *   (`bakeGradeTable`, shared/grade.ts), written as a `.cube` into the render's
 *   temp folder and applied with ONE `lut3d` (tetrahedral, as the preview's
 *   shader). ffmpeg runs with that folder as its working directory, so the
 *   filter names the file without a path (no Windows drive-letter escaping).
 *
 * Verified against the real binary and the preview's shader: FFMPEG-NOTES
 * "Colour table".
 */

import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { activeLut, bakeGradeTable, GRADE_TABLE_SIZE, needsGradeTable, type ColorLook } from '@shared/grade'
import { writeCube } from '@shared/cube'
import { gradeFilter } from './ffmpegFilters'
import { readLut } from './luts'

/** The `lut3d` filter for a table file in ffmpeg's working directory. */
export const lut3dFilter = (file: string): string => `lut3d=file=${file}:interp=tetrahedral`

/**
 * The fragment for `look` ('' when it changes nothing). A table goes into
 * `dir` as `grade_<hash>.cube` — the same look twice writes one file. `root`
 * is the project folder the look's LUT (`luts/`) is read from; a LUT that has
 * gone missing fails the export with its name rather than exporting without it.
 */
export async function lookFilter(look: ColorLook, dir: string, root: string): Promise<string> {
  if (!needsGradeTable(look)) return gradeFilter(look.color, look.tint)
  const ref = activeLut(look.lut)
  let table = null
  if (ref) {
    try {
      table = await readLut(root, ref.file)
    } catch (error) {
      throw new Error(`The LUT “${ref.name}” can’t be read: ${(error as Error).message}`, { cause: error })
    }
  }
  const text = writeCube(GRADE_TABLE_SIZE, bakeGradeTable(look, table))
  const file = `grade_${createHash('sha1').update(text).digest('hex').slice(0, 12)}.cube`
  const path = join(dir, file)
  if (!existsSync(path)) await fsp.writeFile(path, text, 'utf8')
  return lut3dFilter(file)
}
