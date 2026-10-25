/**
 * A `.fit` workout imports like any clip (docs/WORKOUT-OVERLAY.md): it lands in
 * the library with its route as the thumbnail and its sport, distance and
 * length on the card. A planned-workout FIT (no recording) is refused in words.
 * Placing it as an overlay is e2e/workoutOverlay.spec.ts.
 *
 * ARRANGE real FIT files written by Garmin's encoder and stub the Open picker,
 * ACT with a real click on Import, ASSERT on the card's DOM (the thumbnail
 * actually decoded), the import notice and the project's mediaIds.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { buildFitFile, loopRide } from '../src/main/services/__fixtures__/fitFile'

const pickNext = (app: ElectronApplication, filePaths: string[]): Promise<void> =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
  }, filePaths)

const mediaIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project?.mediaIds ?? [])

test('a FIT ride imports with its route thumbnail; a planned workout is refused', async ({
  appPage: page,
  electronApp,
  scratchDir
}) => {
  const ride = join(scratchDir, 'Morning Ride.fit')
  writeFileSync(ride, buildFitFile({ samples: loopRide(120) }))
  const plan = join(scratchDir, 'Tuesday intervals.fit')
  writeFileSync(plan, buildFitFile({ type: 'workout', samples: [] }))

  await pickNext(electronApp, [ride, plan])
  await page.getByRole('button', { name: 'Import video' }).click()

  const notice = page.getByTestId('import-failures')
  await expect(notice).toContainText("Couldn't import 1 file")
  await expect(notice).toContainText('Tuesday intervals.fit')
  await expect(notice).toContainText('planned workout')
  await expect.poll(() => mediaIds(page).then((ids) => ids.length)).toBe(1)

  const card = page.locator('[data-clip-card]', { hasText: 'Morning Ride.fit' })
  // 119 one-second samples at 8 m apart: 952 m, 1:59 long.
  await expect(card).toContainText('Ride · 0.6 mi · 1:59')
  // The route thumbnail is served (as SVG) and really decodes.
  const thumb = card.getByTestId('workout-thumb').locator('img')
  await expect(thumb).toHaveAttribute('src', /thumb\.svg/)
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)

  // It places like any clip: add buttons, and the card drags.
  await expect(card.getByRole('button', { name: /Playhead|End/ })).toHaveCount(2)
  await expect(card).toHaveAttribute('draggable', 'true')

  // Regression: selecting a workout used to give the EMPTY timeline the
  // workout's length (a 2-hour ride read "0:00.0 / 118:17.0").
  await card.click()
  await expect(card).toHaveClass(/border-sky-400/)
  await expect(page.getByTestId('timeline-clock')).toHaveText(/\/ 0:00\.0$/)
})
