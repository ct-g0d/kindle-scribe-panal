# Kindle Scribe panel

A glanceable e-ink dashboard for a jailbroken Kindle Scribe. A Windows PC renders a grayscale PNG every minute
and pushes it to the Kindle over SSH, where `eips` draws it. Built to be read from across the room: big numbers,
black and white, nothing you have to walk up to.

What it shows:

- **Top strip** - time, date, rain now / next 3 hours (Open-Meteo), Kindle battery, and what the PC is playing
  (any app in the Windows media controls, with its logo)
- **Usage** - token totals and cost for today / 7d / 30d / all, plus a 6-month activity heatmap (from TokeX)
- **To-Do List** - today's tasks from War Plan
- **Limits** - Claude, Codex and Antigravity usage windows with an on/under/over pace verdict for the week
- **T3 Code** - agents that need you or are running (input, done, failed, stopped, running, waiting)
- **Weather** - now plus 5 days for Auckland

## Kindle app

The PC panel needs nothing on the Kindle. To keep it going when the PC is away (and keep the Kindle awake),
open the KOReader plugin (`kindle/kindlepanel.koplugin`); without it a PC outage just leaves the last frame. Open it by tapping
**Kindle Panel.kpanel** in `documents` (or Tools > Kindle Panel). Tap the panel to redraw it, long-press to close it.
While it's open the Kindle doesn't sleep (it sets powerd's `preventScreenSaver`, like the Keep alive plugin).

- **PC sending**: the PC draws its frame every minute, app open or not (as before).
- **PC quiet for 5 minutes**: the Kindle takes over. It shows the last PC data (a frame the PC sends every 5 pushes
  with the clock strip and weather card left empty, a "PC offline · Last data HH:MM" banner) and draws itself:
  a live clock, date and battery every minute, and weather it fetches from Open-Meteo every 30 minutes.
  The next PC push takes the screen back.

`run.js` installs the app over SSH each time it starts: the plugin, the Inter TTFs (`kindle/fonts`, OFL), the
weather icons, and `layout.lua` (positions, so the Kindle's text lines up with the PC's frame) into
`/mnt/us/kindlepanel`. Restart KOReader once after a new plugin version is installed.

## Requirements

- Kindle with a jailbreak and KOReader's SSH server on (port 2222, login without password)
- Windows, Node 22+ (uses `node:sqlite`), Git for Windows (for `ssh.exe`)
- Local data sources: T3 Code, TokeX, War Plan (`D:/CT_Study/warplan.db`, or `WARPLAN_DB`) (each fails independently; the card just says unavailable)

## Run

```
npm install
node run.js --preview   # writes preview.png + preview-offline.png, no Kindle needed
node run.js --once      # one push
node run.js             # loop, every 60 s
```

Settings via environment variables: `KINDLE_HOST`, `KINDLE_PORT`, `INTERVAL_SEC`, `FULL_REFRESH_EVERY`
(flashing full refresh every N pushes, default 10; the pushes in between use the non-flashing GL16 waveform).

On Windows, `start-panel.ps1` keeps the loop alive (restarts it if it exits, logs to `panel.log`);
it's run by the "Kindle Agents Panel" scheduled task. `stop-panel.ps1` stops the task and the loop.

## Files

| File | What it does |
| --- | --- |
| `run.js` | Loop: gather data, render, push over SSH, install the Kindle app |
| `panel.js` | Renderer (canvas, Inter font, 8-bit grayscale PNG) |
| `agents.js` | T3 Code thread status from its local SQLite state |
| `extras.js` | TokeX usage + limits, weather, now playing |
| `warplan.js` | Today's War Plan tasks |
| `nowplaying.ps1` | Reads the Windows media session (title, artist, app) |
| `kindle/kindlepanel.koplugin` | The Kindle app (KOReader plugin): shows the PC's frames, or its own clock / weather / battery |
| `kindle/fonts` | Inter TTFs for the Kindle's own text |
| `make-logos.js` | Builds the black logo PNGs in `assets/` |
