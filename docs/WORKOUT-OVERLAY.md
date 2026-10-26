# Workout files and the workout overlay

Issues #186 (workout data overlays) and #187 (route map). Built in three steps:

1. **Import and library** (built): a `.fit` file imports like any clip and sits in the library
   with its route as the thumbnail.
2. **The overlay layer** (built): a timeline tile that draws chosen metrics (power, speed, heart
   rate, distance so far, total distance, average power, static map, live map) over the video,
   in the preview and the export.
3. **The graph window** (built): power / elevation / speed / heart-rate graphs against time or
   distance, with trim, split, delete and wheel zoom down to 1 s.

## What it does (built)

- **Import ▸ a `.fit` file** (the picker's Media and "Workouts (.fit)" filters, a window drop, or
  a folder holding one) adds it to the library. The file is decoded once, by Garmin's FIT SDK
  (`@garmin/fitsdk`, bundled into main), never by ffmpeg.
- **The card** shows the route's shape (north up, no map data) with a green dot at the start.
  A file with no GPS (an indoor trainer ride, a pool swim) shows a sparkline of its power, speed
  or heart rate instead; one with none of those shows "FIT". The second line is the sport,
  distance and length: `Ride · 33.2 mi · 1:58:17`. A multisport file (swim, bike, run) reads
  `Multisport`.
- **A planned workout** (TrainingPeaks and Garmin export those as `.fit` too) is refused in the
  import notice: "This FIT file is a planned workout, not a recorded one: it has no data to
  show." So is a course (a planned route), and a file that isn't FIT at all says so. A file cut
  short (a flat battery mid-ride) imports with the samples before the damage.
- **Relink** never swaps a workout for footage or the other way round, even with "Update path
  anyway": the timeline holds the clip as one or the other.
- Selecting a workout in the library doesn't give an empty timeline its length.
- Durations of an hour or more now read `h:mm:ss` everywhere `formatDuration` is used (they
  read `118:17` before).

## The overlay (built)

- **Placing it.** A workout card's **＋ End** adds an overlay at the end of the timeline showing
  the WHOLE recording in 8 s (`WHOLE_WORKOUT_SEC`): a 2-hour ride plays at about 900×.
  **＋ Playhead**, or dropping the card on the timeline, does the same unless there is footage
  there that was filmed during the workout: then it SYNCS (below).
- **The tile** sits in its own Workout lane (shown once one exists), with its speed as a badge
  (`75×`). It shows one stretch of the recording (its ride window) at one speed: dragging its
  right edge trims the window's end at that speed, the left edge its start; **S** splits it into
  two tiles over consecutive stretches at the same speed.
- **Widgets.** A new overlay shows power, speed, heart rate and the live map, those the file
  has data for: readouts along the lower third, the map top right. Each is dragged into place
  on the preview (one undo step). The Inspector's **Shows** list turns each metric on or off,
  with its size and colour; a metric the file has no data for is greyed out with why ("This
  file has no power."). The live map can **draw the route as it's ridden** (the ridden part bold
  over the whole route faint).
- **The metrics:** power (W), speed (mph, or pace: min/mi for a run or walk, per 100 yd for a
  swim, following the leg of a multisport file), heart rate (bpm), distance so far, total
  distance and average power (both for the whole workout, not the stretch shown), the static
  map (the route) and the live map (the route with a dot where the athlete is). The maps are
  the route's shape only, no streets.
- **Readable at speed.** At (near) real time power, speed and heart rate show the recorded
  sample; played faster than 1.5×, the mean of the samples over half a second of screen time,
  so they don't flicker. Distance so far is the distance at that very moment (between samples
  too).
- **The Inspector** (Workout section) also sets the speed, or the length (the speed follows);
  **Starts at** slides the stretch shown without changing the tile; Units (miles / kilometres).
  On a linked tile (a synced overlay) speed and length are locked, like Start/End on
  any linked tile.
- **The export** draws exactly what the preview does: the overlay is rendered frame by frame by
  the export's Chromium from the same shapes (`workoutOverlayShapes`), over the box the widgets
  occupy, and composited above the layers below it (`e2e/workoutExport.spec.ts` checks the live
  map's dot in the exported pixels at two moments). Also compared once by eye (2026-10-25) on the
  owner's race-finish clip with that race's Forerunner file: the exported frame matched the
  preview (484 W, 6:39/mi, 193 bpm at the same moment).
- **The assistant:** `get_timeline` lists a workout tile's stretch (`inSec`/`outSec`, seconds into
  the workout), speed and metrics.

## The graph window (built)

**Inspector ▸ Workout ▸ 📈 Graph…** opens the recording in a window over the editor, like Quick
cut's, with every overlay tile of that recording (on the timeline being edited) as a RANGE:

- **Lines:** power, elevation, speed and heart rate, each with its own vertical scale fitted to
  what is in view (and the samples just beside it), each toggled on or off (one the file has no data for is greyed out). Laps
  are dashed lines, timer pauses shaded.
- **Axis:** Time or Distance (Distance is greyed out for a file with no distance). On the
  distance axis a stop collapses to the moment it began, so a cut there lands at the stop's
  start.
- **Zoom:** the wheel zooms about the pointer, from the whole recording down to 1 s across the
  whole width (10 m on the distance axis); Shift+wheel or the bar under the graph pans; **Fit**
  shows it all again.
- **The cursor:** a press puts it there (and selects the range under it); ←/→ move it 1 s
  (Shift: 10 s). It is the graph's own: the editor's playhead doesn't move.
- **Cutting**, as in Quick cut: drag a range's handles to trim its ends; **S** or ✂ Split cuts
  the range under the cursor (both halves at least the shortest tile); **Del** or Delete range
  removes the selected one (never the last; deleting the overlay itself is the timeline's
  job); a selected range's **Speed** can be set here (typing it is one undo step). Undo / redo
  inside the window: Ctrl+Z / Ctrl+Y.
- **Ranges are tiles.** The edits are the timeline's own (`splitWorkout`, `trimWorkoutStart` /
  `trimWorkoutEnd`, `withWorkoutSpeed`), driven in ride time: a split here makes the two tiles
  S makes on the timeline (the right half right after the left); a deleted range leaves a gap
  on the timeline; a left-end trim moves the tile's start, as on the timeline.
- **Save** puts the result on the timeline as ONE undo step, every tile keeping its place in
  the layer stack (a split's right half right after its left); **Cancel** (or Escape) changes
  nothing. Keys pressed while the window is open never reach the editor's shortcuts, and a
  recording that can't be read still shows Close. If the timeline's tiles of that recording
  changed while the window was open (the assistant can edit meanwhile), Save refuses, saying
  so, rather than overwrite them.
- **A range linked to a clip** (a synced overlay) is drawn dashed with 🔗 and can't be trimmed,
  split or deleted here ("Linked to a clip: edit it on the timeline (or unlink it first)."):
  cutting it would leave it out of step with its footage.

## Syncing to footage

Placed at the playhead over a video clip (an original: a clip the editor made, such as a Quick
cut piece, carries its source's recording time and is never synced to), the overlay looks up
when that clip was filmed (its
container's recording-time tag, read with ffprobe when needed: FFMPEG-NOTES "Recording time").
When the recording covers it, the overlay takes the clip's window on the timeline, plays at 1×,
shows the stretch of the workout that was happening while the clip was filmed, and is LINKED to
the clip (moves, trims, splits and deletes with it). Only the part of the clip the recording
covers gets an overlay. A clip that is sped up, ramped or frozen isn't synced to (its frames no
longer map one-to-one onto clock time), and nor is one filmed at another time: those get the
whole-recording overlay.

Linked, the overlay is held to what the recording can give: a synced overlay that already
starts at the recording's first sample (or ends at its last) can't grow that way, so a group
trim that would extend the clip that way stops there, as any link group stops at its most
constrained member.

The recording time is taken as the moment the clip STARTED recording. The tags don't say which
end they mark; the reasons for reading it as the start are in FFMPEG-NOTES. If a clip turns out
a few seconds off, the Inspector's **Starts at** slides the stretch by hand.

Checked once by hand on the owner's own files (2026-10-25, not a repeatable test): the
2026-08-02 race-finish clip (IMG_1594, filmed 13:57:01 UTC) with that race's Forerunner file
synced to 8736 s into the workout (2:25:36, the last 17 s of the run), linked to the clip.

## FIT files: what the real files showed (2026-10-25)

Decoded with the SDK (21.218.0) from the owner's own files: a Garmin Edge 530 indoor ride, a
Garmin Forerunner 965 triathlon (open-water swim, T1, bike, T2, run), a 2021 Garmin road ride, a
Zwift ride, a TrainingPeaks Virtual ride, a TrainingPeaks yoga session and a planned workout.
Each decoded in under 60 ms (the largest, 1 MB, 9,579 samples), with no errors. The parser
(`seriesFromMessages`) follows from these:

- **Positions are semicircles** (×180/2³¹ → degrees). Zwift and TrainingPeaks Virtual write
  real-world coordinates for their virtual courses, so their routes draw.
- **Samples are not 1 per second.** The 2021 road ride records every ~3 s (smart recording);
  the run gaps up to 8 s. Nothing assumes a fixed rate.
- **TrainingPeaks Virtual writes several samples in one second** (2,620 of 9,712), with the
  distance still advancing between them. They are spread evenly across their second, not
  dropped.
- **An indoor ride records distance 0 throughout**, and a device without a strap can record
  heart rate 0. A channel is kept only when it has a real (non-zero) value; altitude is kept
  whenever present.
- **Speed and altitude** come from `enhancedSpeed` / `enhancedAltitude` when present.
- **Average power:** the plain mean of the recorded power samples matched the device's own
  session average (Edge 530: 183.9 vs 184; Zwift: 187.5 vs 187), so that is what the summary
  reports.
- **A multisport file has one session per leg** (`swimming`, `transition`, `cycling`, …). They
  are kept as `legs`; the file's sport is its one discipline, else `multisport` (transitions
  don't count).
- **Timer events** give the pauses: each `stop` / `stopAll` to the next `start`. TrainingPeaks
  writes a stop and start in the same second at a lap; that is no pause.
- **The first sample can be after the session start** (TrainingPeaks: 2 minutes). Time 0 is the
  first sample; `startUtc` is its wall-clock time.

## Data

- **`WorkoutSeries`** (`shared/workout.ts`): `t` (seconds from the first sample) plus aligned
  arrays for each channel present (`lat`/`lon`, `distanceM`, `speedMps`, `powerW`, `heartRate`,
  `cadence`, `altitudeM`), and `legs`, `laps`, `pauses`. Cached as `cache/<id>/workout.json`,
  the workout's "proxy" (`proxyReady` = that file exists). Disposable like the rest of the
  cache: a missing one is rebuilt by the proxy step (not covered by a test), and
  `workoutSeries(id)` (what the overlay reads, over IPC `getWorkout`) decodes the original again
  when the cached `version` is not `WORKOUT_SERIES_VERSION` (`e2e/workoutOverlay.spec.ts`
  replaces a stale cache that way).
- **`WorkoutSummary`** rides in the library record's probe (`ProbeInfo.workout`, saved in the
  `.reel`): sport, `startUtc`, channels, total distance, average power. Such a probe has no
  streams; `durationSec` is first sample to last. The record's `kind` is `workout`.
- **Thumbnail:** `cache/<id>/thumb.svg`, from `workoutThumbSvg`, served by `reelmedia://` as
  `image/svg+xml`.
- **The tile** (`WorkoutContent`, layer kind `workout`, project v30): `mediaId`, the ride window
  `inSec`/`outSec` (seconds of the recording), `speed` (ride seconds per timeline second),
  `widgets` (each: metric, centre and size in canonical px, colour, `trace` for the live map) and
  `units`. The layer's own x/y/scale are unused. `endSec − startSec = (outSec − inSec) / speed`
  always: every edit goes through `shared/workoutOverlay.ts`.

## Code

| | |
|---|---|
| Types, summary, route shape, thumbnail SVG, distance and sport words | `shared/workout.ts` + test |
| Decode (SDK boundary `decodeWorkout`, pure `seriesFromMessages`), library probe | `main/services/workoutParse.ts` + test |
| Kind, extension | `shared/media.ts` (`WORKOUT_EXTS`, `isWorkoutAsset`) |
| Import, cache, thumbnail, relink | `main/services/mediaStore.ts` (`probeSource`, `workoutSeries`) |
| Card | `renderer/components/ClipCard.tsx` (`WorkoutThumb`), `Library.tsx` |
| Overlay: timing, edits, sync, metric registry, shapes | `shared/workoutOverlay.ts` + test |
| Placing (sync or whole ride) | `renderer/lib/workout.ts` (`placeWorkout`) |
| Preview + widget drag | `renderer/components/preview/workout.tsx` |
| Inspector | `renderer/components/inspector/WorkoutSection.tsx` |
| Timeline split / trim | `renderer/lib/timeline.ts` (`splitWorkoutLayer`, `trimLayerEdge`), `useTileDrags.ts` |
| Export | `main/services/exportWorkout.ts` |
| Recording time | `main/services/ffprobe.ts` (`probeRecordedUtc`), `ffprobeParse.ts` (`recordedUtcFromTags`) |
| Test FIT files (written by the SDK's encoder) | `main/services/__fixtures__/fitFile.ts` |
| Graph: axes, zoom, line sampling, ticks | `shared/workoutGraph.ts` + test |
| Graph: the working copy's edits, Save | `renderer/lib/workoutGraph.ts` + test |
| Graph window | `renderer/components/WorkoutGraphDialog.tsx` (opened from `WorkoutSection.tsx`) |
| Specs | `e2e/workoutImport.spec.ts`, `e2e/workoutOverlay.spec.ts`, `e2e/workoutExport.spec.ts`, `e2e/workoutGraph.spec.ts` |

## Not in this version

- Playing the overlay inside the graph window, or the window following the editor's playhead.
- Closing the gap a deleted range leaves (ripple delete, #115).
- Lap / split timer (#188).
- A widget's font, or a background panel behind readouts. Readouts use the bundled Montserrat
  ExtraBold with a thin outline.
- The library card's distance always reads in miles; an overlay's units are per tile.
- GPX / TCX files. The parser's output (`WorkoutSeries`) doesn't depend on FIT, so another
  reader can produce it.
- The assistant can read overlays (`get_timeline`) but not place or edit them.
