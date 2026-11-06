--[[--
Kindle Panel: a full-screen dashboard you open by tapping "Kindle Panel.kpanel" (or Tools > Kindle Panel).

While the PC is sending (run.js pushes and draws /tmp/agents.png every minute, app open or not),
the PC's frame is shown as is. When the pushes stop for STALE seconds, the Kindle carries on alone:
the last PC frame (sent as /tmp/panel-base.png, with the clock strip and weather card left empty)
plus a live clock, date and battery, and weather it fetches itself from Open-Meteo.

Drawing goes straight to the framebuffer with fbink/eips (same as the PC push), so KOReader only
paints a blank white screen underneath. Tap: redraw. Long-press: close.
Keeps the Kindle awake while open (powerd preventScreenSaver, like the Keep alive plugin).
--]]--

local Blitbuffer = require("ffi/blitbuffer")
local Device = require("device")
local DocumentRegistry = require("document/documentregistry")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
local PluginShare = require("pluginshare")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local _ = require("gettext")

local DIR = "/mnt/us/kindlepanel"
local PC_IMG = "/tmp/agents.png"       -- latest PC frame
local BASE_IMG = "/tmp/panel-base.png" -- last PC data, live parts left empty

local FBINK = "/mnt/us/koreader/fbink"
local STALE = 300                      -- seconds without a PC push before the Kindle takes over
local WEATHER_EVERY = 30 * 60
local WEATHER_RETRY = 5 * 60
local FLASH_EVERY = 10                 -- minutes between flashing refreshes of the clock (clears ghosting)

-- Inter, as on the PC. fbink's px is the line height (ascent + descent), so convert from the canvas
-- font size (em) the PC uses; ASC puts the baseline where the PC's is.
local FONT = {
    light = DIR .. "/fonts/Inter-Light.ttf", regular = DIR .. "/fonts/Inter-Regular.ttf",
    medium = DIR .. "/fonts/Inter-Medium.ttf", semi = DIR .. "/fonts/Inter-SemiBold.ttf",
    bold = DIR .. "/fonts/Inter-Bold.ttf",
}
local LH, ASC = (1984 + 494) / 2048, 1984 / 2048

local ok_layout, L = pcall(dofile, DIR .. "/layout.lua")
if not ok_layout then
    logger.warn("KindlePanel: no layout.lua yet, using defaults", L)
    L = { W = 1860, H = 2480, M = 60, P = 44, topY = 50, topH = 200, sep1 = 701, ix = 741, blockW = 480,
          sep2 = 1261, mx = 1301, mw = 499, boxY = 68, boxH = 170,
          wx = { x = 60, y = 1920, w = 1740, h = 500, nowW = 520 }, icon = 160, city = "Auckland",
          lat = "-36.85", lon = "174.76", tz = "Pacific/Auckland" }
end

-- ---------- drawing helpers ----------
local function sh(cmd)
    local r = os.execute(cmd)
    return r == 0 or r == true
end
local function q(s) return "'" .. (tostring(s):gsub("'", "'\\''")) .. "'" end
local function round(n) return math.floor(n + 0.5) end

-- text at x / baseline, canvas-style. o.w: centre within [x, x+w]; o.white: white on black.
local function text(s, size, face, x, baseline, o)
    o = o or {}
    local top = round(baseline - ASC * size)
    local margins = "left=" .. round(x)
    if o.w then margins = margins .. ",right=" .. round(L.W - x - o.w) end
    sh(string.format("%s -q -b %s %s -t regular=%s,px=%d,top=%d,%s %s", FBINK,
        o.white and "-h" or "-O", o.w and "-m" or "", -- -h: white text (on the black banner); -O: dark text on light
        FONT[face], round(size * LH), top, margins, q(s)))
end
local function clear(x, y, w, h, color)
    sh(string.format("%s -q -b -B %s -k top=%d,left=%d,width=%d,height=%d", FBINK, color, y, x, w, h))
end
local function refresh(x, y, w, h, flash)
    sh(string.format("%s -q %s -s top=%d,left=%d,width=%d,height=%d", FBINK, flash and "-f" or "", y, x, w, h))
end
local function image(file, x, y, full)
    sh(string.format("eips %s -g %s -x %d -y %d >/dev/null 2>&1", full and "-f" or "", q(file), round(x), round(y)))
end
local function mtime(f) return lfs.attributes(f, "modification") end

-- ---------- weather (Open-Meteo, CSV so it's easy to read here) ----------
local WX_FILE = DIR .. "/weather.csv"
local function WMO(c)
    if c == 0 then return "sun", "Clear" end
    if c <= 2 then return "partly", c == 1 and "Mostly Clear" or "Partly Cloudy" end
    if c == 3 then return "cloud", "Cloudy" end
    if c <= 48 then return "fog", "Fog" end
    if c <= 57 then return "rain", "Drizzle" end
    if c <= 67 then return "rain", "Rain" end
    if c <= 77 then return "snow", "Snow" end
    if c <= 82 then return "rain", "Showers" end
    if c <= 86 then return "snow", "Snow Showers" end
    return "storm", "Thunderstorms"
end

local function fetchWeather()
    local url = string.format("https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
        .. "&current=temperature_2m,weather_code"
        .. "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        .. "&timezone=%s&forecast_days=5&format=csv", L.lat, L.lon, (L.tz:gsub("/", "%%2F")))
    local ok = sh("curl -s -f -m 15 -o " .. q(WX_FILE .. ".new") .. " " .. q(url))
    if ok then os.rename(WX_FILE .. ".new", WX_FILE) end
    return ok
end

local function readWeather()
    local f = io.open(WX_FILE)
    if not f then return end
    local w, section = { days = {} }, 0
    for line in f:lines() do
        if line:match("^time,") then
            section = section + 1
        elseif section > 0 and line:match("^%d%d%d%d%-") then
            local c = {}
            for v in line:gmatch("[^,]+") do c[#c + 1] = v end
            if section == 1 then
                w.now = { temp = tonumber(c[2]), code = tonumber(c[3]) }
            else
                w.days[#w.days + 1] = { date = c[1], code = tonumber(c[2]), max = tonumber(c[3]),
                    min = tonumber(c[4]), rain = tonumber(c[5]) or 0 }
            end
        end
    end
    f:close()
    if w.now and w.now.temp and w.now.code then return w end
end

local function dayName(date)
    local y, m, d = date:match("(%d+)-(%d+)-(%d+)")
    return os.date("%a", os.time { year = tonumber(y), month = tonumber(m), day = tonumber(d), hour = 12 })
end

-- ---------- the Kindle's own parts ----------
local function drawClock(flash)
    local y, h = L.topY, L.topH
    clear(0, y, L.sep1, h, "WHITE")                          -- time column
    clear(L.sep1 + 3, y, L.sep2 - L.sep1 - 3, h, "WHITE")    -- date / rain / battery column
    text(os.date("%H:%M"), 210, "semi", L.M - 8, y + h - 10)
    text(os.date("%A ") .. tonumber(os.date("%d")) .. os.date(" %b"), 54, "bold", L.ix, y + 62)
    local w = readWeather()
    local today = w and w.days[1]
    if today and today.rain >= 30 then
        text(string.format("Rain %d%% today", today.rain), 46, "semi", L.ix, y + 126)
    end
    local powerd = Device:getPowerDevice()
    local level = powerd:getCapacity()
    text(string.format("Battery %d%%%s", level, powerd:isCharging() and " · charging" or ""), 38, "semi", L.ix, y + h - 14)
    refresh(0, y, L.sep2, h, flash)
end

local function drawBannerTime()
    local t = mtime(PC_IMG)
    if not t then return end
    text("Last data " .. os.date("%H:%M", t), 34, "semi", L.mx, L.boxY + L.boxH / 2 + 52, { w = L.mw, white = true })
    refresh(L.mx, L.boxY, L.mw, L.boxH)
end

local function drawWeather()
    local c, P = L.wx, L.P
    local x, y, w, h = c.x, c.y, c.w, c.h
    clear(x + 24, y + 24, w - 48, h - 48, "GRAYE") -- inside the rounded card
    local wx = readWeather()
    if not wx then
        text("Weather unavailable", 40, "semi", x, y + h / 2 + 14, { w = w })
        return refresh(x, y, w, h)
    end
    local n, today = wx.now, wx.days[1] or {}
    local kind, label = WMO(n.code)
    local t = mtime(WX_FILE)
    text(L.city .. (t and os.date(" · %H:%M", t) or ""), 36, "semi", x + P, y + P + 32)
    text(round(n.temp) .. "°", 200, "light", x + P - 10, y + P + 236)
    image(string.format("%s/wx-%s.png", DIR, kind), x + P + c.nowW - 70 - L.icon / 2, y + P + 130 - L.icon / 2)
    text(label, 46, "semi", x + P, y + h - P - 56)
    text(string.format("H %d°   L %d°", round(today.max or n.temp), round(today.min or n.temp)), 38, "semi", x + P, y + h - P)

    local dx = x + P + c.nowW
    local days = math.min(5, #wx.days)
    local colW = (x + w - P - dx) / math.max(days, 1)
    for i = 1, days do
        local d, cx = wx.days[i], dx + colW * (i - 1)
        clear(round(cx), y + P, 2, h - 2 * P, "GRAYC")
        text(i == 1 and "Today" or dayName(d.date), 40, i == 1 and "bold" or "semi", cx, y + P + 40, { w = colW })
        image(string.format("%s/wx-%s.png", DIR, (WMO(d.code))), cx + colW / 2 - L.icon / 2, y + P + 150 - L.icon / 2)
        text(round(d.max) .. "°", 72, "semi", cx, y + h - P - 70, { w = colW })
        text(string.format("%d° · %d%%", round(d.min), d.rain), 36, "semi", cx, y + h - P, { w = colW })
    end
    refresh(x, y, w, h)
end

-- ---------- full-screen widget ----------
local PanelScreen = InputContainer:extend {
    covers_fullscreen = true,
    plugin = nil,
}

function PanelScreen:init()
    self.dimen = Geom:new { x = 0, y = 0, w = Device.screen:getWidth(), h = Device.screen:getHeight() }
    self.ges_events = {
        Tap = { GestureRange:new { ges = "tap", range = self.dimen } },
        Hold = { GestureRange:new { ges = "hold", range = self.dimen } },
    }
end

function PanelScreen:paintTo(bb, x, y)
    bb:paintRect(x, y, self.dimen.w, self.dimen.h, Blitbuffer.COLOR_WHITE)
end

function PanelScreen:onTap() self.plugin:redraw() return true end
function PanelScreen:onHold() self.plugin:close() return true end
function PanelScreen:onClose() self.plugin:close() return true end

-- ---------- plugin ----------
local KindlePanel = WidgetContainer:extend {
    name = "kindlepanel",
    is_doc_only = false,
}

function KindlePanel:init()
    -- Tapping a .kpanel file opens the panel: a document type so the file browser lists it, mapped to this
    -- plugin as its (auxiliary) handler so FileManager:openFile() calls openFile() below instead of a reader.
    if not DocumentRegistry.filetype_provider.kpanel then
        DocumentRegistry:addProvider("kpanel", "application/x-kindlepanel", { provider = "kindlepanel_file" }, 1)
    end
    DocumentRegistry:addAuxProvider { provider_name = _("Kindle Panel"), provider = self.name, order = 90,
        disable_file = true, disable_type = false }
    local map = G_reader_settings:readSetting("provider", {})
    if map.kpanel ~= self.name then
        map.kpanel = self.name
        G_reader_settings:saveSetting("provider", map)
    end
    self.ui.menu:registerToMainMenu(self)
    self.tick = function() self:onTick() end
end

function KindlePanel:isFileTypeSupported(file) return file:lower():match("%.kpanel$") ~= nil end
function KindlePanel:openFile() self:open() end

function KindlePanel:addToMainMenu(menu_items)
    menu_items.kindle_panel = { text = _("Kindle Panel"), sorting_hint = "tools", callback = function() self:open() end }
end

function KindlePanel:open()
    if self.screen then return end
    self.screen = PanelScreen:new { plugin = self }
    UIManager:show(self.screen, "full")
    sh("lipc-set-prop com.lab126.powerd preventScreenSaver 1")
    PluginShare.keepalive = true -- tells AutoSuspend to leave powerd's timer alone
    self:redraw(1) -- after KOReader has painted the blank screen
end

function KindlePanel:close()
    if not self.screen then return end
    UIManager:unschedule(self.tick)
    sh("lipc-set-prop com.lab126.powerd preventScreenSaver 0")
    PluginShare.keepalive = false
    UIManager:close(self.screen, "full")
    self.screen = nil
end

function KindlePanel:redraw(delay)
    self.mode = nil -- next tick draws everything
    UIManager:unschedule(self.tick)
    UIManager:scheduleIn(delay or 0.2, self.tick)
end

function KindlePanel:onResume() if self.screen then self:redraw(1) end end

function KindlePanel:onTick()
    if not self.screen then return end
    local now = os.time()
    local pc = mtime(PC_IMG)
    if pc and now - pc <= STALE then
        -- PC is sending and draws its own pushes; just show the latest once when switching to it
        if self.mode ~= "pc" then image(PC_IMG, 0, 0, true) end
        self.mode = "pc"
    else
        local entering = self.mode ~= "kindle"
        self.mode = "kindle"
        local wx_new = false
        if not self.wx_next or now >= self.wx_next then
            wx_new = fetchWeather()
            self.wx_next = now + (wx_new and WEATHER_EVERY or WEATHER_RETRY)
        end
        if entering then
            if mtime(BASE_IMG) then
                image(BASE_IMG, 0, 0, true)
                drawBannerTime()
            else -- PC hasn't sent anything since the Kindle booted
                sh(FBINK .. " -q -c -f")
                clear(L.wx.x, L.wx.y, L.wx.w, L.wx.h, "GRAYE")
                text("Waiting for the PC", 66, "bold", 0, L.H / 2, { w = L.W })
            end
            self.minutes = 0
        end
        if entering or wx_new then drawWeather() end
        self.minutes = (self.minutes or 0) + 1
        drawClock(self.minutes % FLASH_EVERY == 0)
    end
    -- wake just after the next minute starts
    UIManager:scheduleIn(61 - tonumber(os.date("%S")), self.tick)
end

return KindlePanel
