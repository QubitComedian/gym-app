# Gym program — v1 as of 2026-04-14

Derived from your trainer brief and all logged sessions to date. This is the current state; it will evolve.

## Goal hierarchy (from brief)

**Now (next 3–6 months):** build muscle, don't waste beginner gains, pick exercises that fit a tall frame, keep running in as a background habit.

**Next (6–18 months):** maintain muscle with lower volume, layer in mobility, handstand/gymnastic work, triathlon-capable cardio.

**Constraints:** recovering from a March injury — exercise selection matters; poor mobility currently; tall, so hypertrophy takes consistency; prior runner background.

## Weekly structure

4-day rotation: **A → B → C → D**, repeating. Runs go on rest days, typically 2–3× / week, 5–7 km easy. Full rest 1×/week.

| Day | Focus | Key movements |
|---|---|---|
| A | Push — chest / shoulders / tri | Incline DB press, flat DB press, seated DB OHP, DB lateral raise, face pull, tricep pressdown, hanging knee raise |
| B | Pull — back / biceps | Pull-ups EMOM, neutral pulldown, chest-supported DB row, single-arm cable row, incline DB curl, hammer curl, side plank |
| C | Legs | Front-foot elevated split squat, single-leg RDL, lying hamstring curl, hip thrust, calf raise, hanging knee raise |
| D | Shoulders + Arms | Pull-ups (quality), DB lateral raise, rear delt fly, incline DB curl, overhead tricep ext, pressdown, ab circuit |

## Exercise memory — respect these always

| Exercise | Status | Why |
|---|---|---|
| Romanian Deadlift (barbell) | **banned** | You disliked it; hard to feel in hamstrings, too much lower-back. Logged Feb 2: "let's not do anymore." Replaced with Single-Leg RDL. |
| Cable lateral raise (low stack) | **banned** | 5 lb minimum too light — use DB version. |
| Single-Leg RDL | **liked** | Works hamstring without lower-back load. |
| Pull-ups EMOM | **liked** | Producing clear pull-up density progress. |
| Hanging core work | **watch** | Forearm grip fails before abs do. Consider wrist straps if this keeps being the limiter. |

The app (`index.html` → Exercises tab) is the living source for this list. Any new likes/dislikes get added there.

## Progression rules

- **Incline DB press, flat press, OHP:** if the last prescribed set is 10 clean reps at ≤1 RIR → bump 2.5–5 lb next session.
- **Lateral raise:** earn reps before weight. 15 clean reps at target weight × all sets → bump.
- **Pull-ups EMOM:** 2/min easy → 3/min OR extend to 12 min. Target: weeks 6–7, switch to 4–5 sets × max reps.
- **Split squat, hamstring curl, hip thrust, calf:** add weight when top of rep range is hit cleanly.
- **Pressdown, face pull, curls:** chase rep quality at current weight; bump when all sets hit top of range at RIR 1.

## What the app is for

The web app under this folder (`index.html`) is your v0 logger:

- Pick today's day (it suggests the next one in rotation).
- Each exercise shows your **last-time numbers faintly under the input boxes** so you know what to beat.
- Log weight × reps × RIR per set; add notes per set or per session; rate the session.
- History tab shows every past session; tap one to see the detail.
- Exercises tab is your preference memory — add to it any time an exercise becomes a "nope" or a "keep."
- Settings → Export JSON backs up everything for when we move to the cloud version.

## What the app is NOT yet (and what comes next)

See `README.md` for the v1 roadmap: Claude auto-review after each session, dynamic calendar sync, multi-device access.
