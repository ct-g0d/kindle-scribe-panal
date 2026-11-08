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
- **Weather** - wherever the PC is: now (with feels like), the next 12 hours as a line, and the next 3 days.
  Keyless, works in New Zealand and China alike: Windows location picks the place, Open-Meteo gives the forecast
  (the next day, fetched hourly), and the nearest airport's live report (METAR) checks it: "now" is what the
  airport measured, and the forecast temperatures are shifted by the model's current error, fading over 6 hours.
  Set `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_CITY` to pin a place instead.

## Kindle app

The PC panel needs nothing on the Kindle. To keep it going when the PC is away (and keep the Kindle awake),
open the KOReader plugin (`kindle/kindlepanel.koplugin`); without it a PC outage just leaves the last frame. Open it by tapping
**Kindle Panel.kpanel** in `documents` (or Tools > Kindle Panel). Tap the panel to redraw it, long-press or swipe to close it.
While it's open the Kindle doesn't sleep on its own (it resets powerd's idle timer every minute), but the power
button still puts it to sleep; the PC skips drawing while it's asleep.

- **PC sending**: the PC sends its frame every minute, but only draws it while the app is open and the Kindle is awake.
- **PC quiet for 5 minutes**: the Kindle takes over. It shows the last PC data (a frame the PC sends every 5 pushes
  with the clock strip and weather card left empty, a "PC offline · Last data HH:MM" banner) and draws itself:
  a live clock, date and battery every minute, and weather it fetches from Open-Meteo every 30 minutes.
  The next PC push takes the screen back.

`run.js` installs the app over SSH each time it starts: the plugin, the Inter TTFs (`kindle/fonts`, OFL), the
weather icons, and `layout.lua` (positions, so the Kindle's text lines up with the PC's frame, and where the PC is) into
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

### Running in the background (all Windows accounts)

Run `install-task.ps1` once (it asks for admin to register the task, then starts your copy). It registers the
"Kindle Agents Panel" scheduled task for every account: whoever signs in gets their own copy of `start-panel.ps1`
(keeps the loop alive, restarts it if it exits), in their own session with their own data, and no window at all
(it runs under a headless `conhost`, so Windows Terminal can't take it over and closing a window can't kill it).

- **The account on screen pushes.** Before each push, `session-active.ps1` checks whether this session is the one
  in use (an active Remote Desktop session wins, else the active console session); the others skip that minute.
  Switch accounts and the Kindle switches data within a minute, with a full refresh. With nobody signed in, nothing
  pushes and the Kindle takes over after 5 minutes.
- **Per-account files**: `panel-<username>.log`, `panel-<username>.pid`, `limits-cache-<username>.json`
  (`weather-cache.json` is shared).
- `stop-panel.ps1` stops your own account's copy; other accounts' keep running. It starts again at your next
  sign-in, or run `install-task.ps1` again.

## Files

| File | What it does |
| --- | --- |
| `run.js` | Loop: gather data, render, push over SSH, install the Kindle app |
| `panel.js` | Renderer (canvas, Inter + LXGW WenKai for Chinese, 8-bit grayscale PNG) |
| `assets/fonts` | LXGW WenKai Regular / Medium (霞鹜文楷, OFL), the Chinese fallback under Inter |
| `start-panel.ps1` / `stop-panel.ps1` | Keep this account's loop alive / stop it |
| `install-task.ps1` | Registers the scheduled task for all accounts (headless, no window) |
| `session-active.ps1` | Prints 1 if this Windows session is the one in use, else 0 |
| `agents.js` | T3 Code thread status from its local SQLite state |
| `extras.js` | TokeX usage + limits, now playing |
| `weather.js` | Place, Open-Meteo forecast, airport observation check |
| `location.ps1` | Reads Windows location (lat, lon) |
| `warplan.js` | Today's War Plan tasks |
| `nowplaying.ps1` | Reads the Windows media session (title, artist, app) |
| `kindle/kindlepanel.koplugin` | The Kindle app (KOReader plugin): shows the PC's frames, or its own clock / weather / battery |
| `kindle/fonts` | Inter TTFs for the Kindle's own text |
| `make-logos.js` | Builds the black logo PNGs in `assets/` |
