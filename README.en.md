# Clock-out Countdown

> A floating workday companion for the DeepSeek Harness Web UI: clock in, count down, get reminded when it is time to clock out.

[中文](README.md) | **English**

A small pill in the corner of the interface that walks a workday with you: it prompts you to clock in when your shift starts, then counts down quietly, turns amber as the end approaches, and fills with colour, breathes and shakes when it is time to leave.

- No sound. The colour and the motion are loud enough.
- Runs in the Harness Web UI only, not the TUI.

<!-- Suggest a screenshot here: img/screenshot.png -->
<!-- ![Screenshot](img/screenshot.png) -->

## Features

- **Clock in** — at your shift's start time the pill shows a "Clock in" button, which is itself the reminder to do it. One click covers the whole day; a refresh or restart remembers it.
- **Countdown** — after clocking in it counts down quietly in the corner.
- **Heads-up** — inside the lead window (15 minutes by default) the border and the countdown switch to a warning colour.
- **Clock-out reminder** — at the end of the shift the whole card fills with your accent colour, breathes and shakes, the text becomes "Time to clock out", and a "Got it" button dismisses it for the day.
  - **Shown whether or not you clocked in.** Forgetting to clock in must not cost you the one reminder that matters most.
- **Reminder window** — the reminder lasts a bounded time (4 hours by default) and then goes quiet, so an 18:00 finish does not nag you at midnight.
- **Night shifts** — a start time later than the end time is a shift that crosses midnight, handled by the same code. At 01:00 the pill correctly recognises the shift that began at 22:00 the evening before.
- **Custom colours** — nine presets plus any colour you pick. Presets carry a light and a dark fill, and the text colour is derived for contrast.
- **Free dragging** — drag the pill anywhere and it stays there. The position is stored as a fraction of the travel range, so a resized window keeps it against the same edge instead of pushing it off-screen.
- **Two places to configure** — the gear beside the pill, or this plugin's page under Plugins. Both render the same form, so either works.
- **Adjustable** — shift times, lead time, breathing pace (1.2 / 1.8 / 3 s), reminder window, weekdays, colour, position (corner presets or free drag), and visibility.

## Two design decisions

**Why "Clock in" is a button, not automatic**

It maps to a real action. Clocking in at work is something you already do every day; using it to start the countdown is honest about what is happening and doubles as the reminder to clock in.

**Why the clock-out reminder does not depend on it**

If it did, someone who forgot to clock in would also miss the reminder at the end of the day — and not forgetting to clock out is the whole point of this plugin. Losing the daytime countdown is acceptable; missing the clock-out reminder is not.

## Install

```bash
git clone <this repository>
dsh plugin add ./offwork-countdown
```

Live immediately after install. Replacing an already-installed copy needs a Harness restart to load the new module.

You can also ask the model inside Harness to install it with `plugin_manager`, pointing at the cloned directory.

## Usage

1. When your shift starts, the "Clock in" button appears in the corner. Click it to start the countdown.
2. Drag the pill wherever it is out of your way; the position is remembered.
3. Click the gear to change times, colour and reminder pacing.

Settings live in `~/.dsh/offwork-countdown/state.json` (honouring `DSH_HOME`).

## Implementation notes

Notes for anyone writing a Harness plugin of their own:

- **Renders into `shell.overlay`**, the frame-wide floating layer the app declares above every column and outside their scroll containers. The layer is click-through; each occupant opts back in, so the pill never blocks the app underneath.
- **All time comparisons use the local wall clock.** Date keys are built from local year/month/day, never `toISOString()` — that reports UTC, and a reader in UTC+8 would get the previous day until 08:00.
- **A shift belongs to the day it starts.** That single rule is what makes night shifts work: clock-in and dismissal marks are keyed by the start date, so an action at 01:00 belongs to the shift that began the evening before, not to a new day.
- **Dragged positions are stored as fractions, not pixels.** The travel range is `(window − pill)`, so `1` always means flush against the edge. A pixel offset saved in a wide window falls outside a narrow one.
- **Defer `setPointerCapture` until a drag is confirmed.** Capturing on `pointerdown` retargets the following click to the pill and the panel can never be opened by clicking it again.
- **Slot wrappers use `display:contents`** and therefore have no layout box — `getBoundingClientRect()` on the parent returns zeros. Measure via `offsetParent` to find the element that actually positions you.
- **`useSyncExternalStore`'s `getSnapshot` must return a stable reference.** A fresh object per call makes React treat the store as changed on every render, which re-renders forever and blanks the slot entry.
- One tick per second drives both the countdown text and the phase; there is no second timer deciding "due".
- The phase statement sits in a live region that announces once; the ticking number is deliberately outside it, or a screen reader would read the countdown every second.
- Motion honours `prefers-reduced-motion`.
- Settings are not in `localStorage`: the Web GUI's port changes between launches and browser storage is keyed by origin, so they would quietly disappear.

## Layout

| File | Purpose |
| --- | --- |
| `host.js` | Host half: validates and persists the settings to a JSON file |
| `client.js` | Client half: renders the pill, the settings popover and the plugin-page section |
| `cordis.patch.yml` | Inserts the Host row into the profile's layer stack |
| `locale/{zh,en}.json` | Title and description shown by the Plugin Manager |
| `icon.svg` | Icon: a clock pointing at the end of the shift, with a check mark |

## Language

The UI ships Chinese and English text and follows DSH's Settings → General → Language.

If the locale service is unavailable (plugin not active, or the service failed), the fallback consults the system language first (`navigator.language`, which in the Desktop build is Electron's system language) rather than always showing English.

## Known limitations

- No sound, and the UI does not pretend otherwise.
- Renders in the Harness Web UI only, not the TUI.
- No multi-monitor placement beyond the saved position.

## License

[MIT](LICENSE)
