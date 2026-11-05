// One-off: turn TokeX's provider SVG logos into solid-black PNG silhouettes for e-ink (assets/*.png).
// Run again if you want to swap a logo: node make-logos.js
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const fs = require("node:fs");
const path = require("node:path");

const SRC = process.env.TOKEX_ICONS || "D:/TokeX/assets/icons";
const LOGOS = { claude: "claude.svg", codex: "tray-codex.svg", antigravity: "antigravity.svg" };

(async () => {
  for (const [name, file] of Object.entries(LOGOS)) {
    const svg = fs.readFileSync(path.join(SRC, file), "utf8")
      .replace(/currentColor/g, "#000")
      .replace(/width="1em"/, 'width="256"').replace(/height="1em"/, 'height="256"');
    const img = await loadImage(Buffer.from(svg));
    const c = createCanvas(256, 256), ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 256, 256);
    ctx.globalCompositeOperation = "source-in"; // keep the shape, paint it black
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 256, 256);
    fs.writeFileSync(path.join(__dirname, "assets", `${name}.png`), c.toBuffer("image/png"));
    console.log("wrote", `assets/${name}.png`);
  }

  // Now Playing app logos from simple-icons (single-path brand marks), rendered black.
  const si = require("simple-icons");
  const MEDIA = { spotify: si.siSpotify, youtube: si.siYoutube, youtubemusic: si.siYoutubemusic, chrome: si.siGooglechrome,
    firefox: si.siFirefoxbrowser, applemusic: si.siApplemusic, vlc: si.siVlcmediaplayer, soundcloud: si.siSoundcloud,
    netflix: si.siNetflix, tidal: si.siTidal, bilibili: si.siBilibili, neteasemusic: si.siNeteasecloudmusic };
  for (const [name, icon] of Object.entries(MEDIA)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24"><path fill="#000" d="${icon.path}"/></svg>`;
    const img = await loadImage(Buffer.from(svg));
    const c = createCanvas(256, 256);
    c.getContext("2d").drawImage(img, 0, 0, 256, 256);
    fs.writeFileSync(path.join(__dirname, "assets", `media-${name}.png`), c.toBuffer("image/png"));
    console.log("wrote", `assets/media-${name}.png`);
  }
})();
