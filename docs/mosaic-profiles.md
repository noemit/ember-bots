# Mosaic active profiles

The approved v3 profile fixture is `tests/fixtures/mosaicApprovedProfiles.json`.
`mosaicProfiles.ts` maps preview **working** to production **busy**. Working is
intentionally changed, not a preservation of the old cluster planner. There is no
runtime settings panel. Theme, shape, colour, face and motion identity still resolve
through the existing chat identity; the preview's Stone / Curious comet context is
not a global preference.

## Timing and geometry

Both profiles birth every 100ms on a repeating 40s schedule. Each birth requests one
pixel or an opposite-side pair (Thinking .45, Working .44 probability). Each pixel
keeps its full independently selected lifetime while newer births continue:
Thinking continuously samples 100–1800ms, Working holds exactly 300ms. Values are
not rounded to integer beats (matching independent-trails-v2). Ink samples .1–1.
Thinking selects touching candidates with .95 probability, Working with 0. A gap
means **no Manhattan edge-adjacent body cell**, not an offset measured only from
the originating edge cell. All candidates are whole cells, 1 or 2 cells from an
outer edge, outside the body, and inside the existing SVG canvas.

Coordinate reuse is allowed, including while an older pixel at that coordinate is
still alive. This can composite ink. A birth's cells are bounded to two; total live
DOM slots never exceed 64. Missing requested side/gap candidates and budget-full
cell requests are counted separately. Skipped requests never shorten existing lives
or substitute illegal geometry. Static circular interval colouring reserves the
same slot across the seam; crossing lives become two CSS segments, not a clear.
Only used slots are mounted. All animation is CSS, without per-avatar JS playback.

Thinking alone has the explicitly approved **.7** peak rainbow (superseding .1).
Its seeded period is 2–15s, pass 1.6s, diagonal stagger .1s, direction seeded, profile
phase 0. The shoulders are .28 opacity; the peak spans .32–.96s within each band's
pass. The face is rendered above it. Busy has no wash. Reduced motion removes active
pixels/wash and leaves the original static face and decision badges. Hidden-document
pause retains CSS clock progress. Keyframe names belong to the mounted React id;
mood-specific trail keys replace old trail DOM on profile changes. Crew mood
alternation remains appearance-only; no operational session state changes here.

## Seed comparison

Production uses the resolved chat `motionSeed`, not a shared preview seed. The
planner's PRNG input is `mosaic-independent-trails-v2:<motionSeed>`; the preview used
`preview-independent-trails-v2:<context.seed>:<renderer seed>`. Random draw order,
birth/lifetime selection, actual adjacency filtering and circular allocation match
the preview algorithm, but those differently salted inputs intentionally do not
produce the same example sequence. For exact sequence comparison, run the preview
planner with its hash input replaced by the production input above (do not change
chat identity). Independent phase PRNG `mosaic-trail-phase:<motionSeed>` chooses a
negative CSS delay without consuming birth draws. Rainbow uses
`mosaic-profile-rainbow-v1:<motionSeed>` for period/direction and
`mosaic-rainbow-phase:<motionSeed>` for chat delay; profile phase 0 is preserved and
does not synchronize the rail. Plans and serialized trail frames are memoized per
mounted avatar; styles disappear on unmount. No shared unbounded plan cache exists.

## Verification

Unit coverage includes exact profile values, all 12 shapes × 8 seeds × both active
moods, complete lifetimes and seam preservation, new birth cadence, opposite pairs,
actual adjacency, coordinate overlap, honest skips, deterministic seeds, canvas and
pool bounds, all eight moods, and unique animation names. Browser tests use actual
computed styles and a separate unseeked wall-clock trace; they exercise light/dark,
phase variation, hidden pause and reduced motion. Existing gallery and crew tests
remain part of the acceptance run. Native hardware and physical-device appearance
still need human review; headless Chromium metrics are not hardware FPS promises.
