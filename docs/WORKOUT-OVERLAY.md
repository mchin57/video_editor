# Workout files and the workout overlay

Issues #186 (workout data overlays) and #187 (route map). Built in three steps:

1. **Import and library** (this document's built part): a `.fit` file imports like any clip and
   sits in the library with its route as the thumbnail.
2. **The overlay layer**: a timeline tile that draws chosen metrics (power, speed, heart rate,
   distance so far, total distance, average power, static map, live map) over the video, in the
   preview and the export. Not built yet.
3. **The graph window**: power / elevation / speed / heart-rate graphs against time or distance,
   with trim, split, delete and wheel zoom down to 1 s. Not built yet.

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
- **Nothing to place yet.** A workout card has no ＋ Playhead / ＋ End buttons and can't be
  dragged, and selecting it doesn't give an empty timeline its length.
- Durations of an hour or more now read `h:mm:ss` everywhere `formatDuration` is used (they
  read `118:17` before).

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
  cache: a missing one is rebuilt by the proxy step, and `workoutSeries(id)` decodes the original
  again when the cached `version` is not `WORKOUT_SERIES_VERSION`. Neither rebuild is covered
  by a test yet; the overlay step, the first reader of `workoutSeries`, will add one.
- **`WorkoutSummary`** rides in the library record's probe (`ProbeInfo.workout`, saved in the
  `.reel`): sport, `startUtc`, channels, total distance, average power. Such a probe has no
  streams; `durationSec` is first sample to last. The record's `kind` is `workout`.
- **Thumbnail:** `cache/<id>/thumb.svg`, from `workoutThumbSvg`, served by `reelmedia://` as
  `image/svg+xml`.

## Code

| | |
|---|---|
| Types, summary, route shape, thumbnail SVG, distance and sport words | `shared/workout.ts` + test |
| Decode (SDK boundary `decodeWorkout`, pure `seriesFromMessages`), library probe | `main/services/workoutParse.ts` + test |
| Kind, extension | `shared/media.ts` (`WORKOUT_EXTS`, `isWorkoutAsset`) |
| Import, cache, thumbnail, relink | `main/services/mediaStore.ts` (`probeSource`, `workoutSeries`) |
| Card | `renderer/components/ClipCard.tsx` (`WorkoutThumb`), `Library.tsx` |
| Test FIT files (written by the SDK's encoder) | `main/services/__fixtures__/fitFile.ts` |
| Spec | `e2e/workoutImport.spec.ts` |

## Not in this version

- Placing a workout on the timeline, and everything the overlay draws (steps 2 and 3 above).
- Units: distances read in miles (`DEFAULT_DISTANCE_UNITS`) until the overlay's unit setting
  exists.
- GPX / TCX files. The parser's output (`WorkoutSeries`) doesn't depend on FIT, so another
  reader can produce it.
- The assistant: `list_media` reports `kind: "workout"`, nothing more.
