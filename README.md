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

If the PC stops sending for 5 minutes, a watchdog running on the Kindle covers the Now Playing box with a
"PC offline" banner; the frozen clock shows since when.

## Requirements

- Kindle with a jailbreak and KOReader's SSH server on (port 2222, login without password)
- Windows, Node 22+ (uses `node:sqlite`), Git for Windows (for `ssh.exe`)
- Local data sources: T3 Code, TokeX, War Plan (each fails independently; the card just says unavailable)

## Run

```
npm install
node run.js --preview   # writes preview.png, no Kindle needed
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
| `run.js` | Loop: gather data, render, push over SSH, install the Kindle watchdog |
| `panel.js` | Renderer (canvas, Inter font, 8-bit grayscale PNG) |
| `agents.js` | T3 Code thread status from its local SQLite state |
| `extras.js` | TokeX usage + limits, weather, now playing |
| `warplan.js` | Today's War Plan tasks |
| `nowplaying.ps1` | Reads the Windows media session (title, artist, app) |
| `panel-watchdog.sh` | Runs on the Kindle; shows the "PC offline" banner |
| `make-logos.js` | Builds the black logo PNGs in `assets/` |
