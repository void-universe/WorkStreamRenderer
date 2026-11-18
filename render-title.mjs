// Render a CSS-animated title card to video, frame by frame, deterministically.
// Usage: node render-title.mjs <html> <out.mp4> <seconds> [fps]
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { launch, sleep } from "./cdp.mjs";

const [htmlPath, outPath, secondsArg, fpsArg] = process.argv.slice(2);
if (!htmlPath || !outPath) { console.log("usage: node render-title.mjs <html> <out.mp4> <seconds> [fps]"); process.exit(1); }
const seconds = Number(secondsArg ?? 3);
const fps = Number(fpsArg ?? 24);
const frames = Math.round(seconds * fps);
const frameDir = outPath.replace(/\.mp4$/, "-frames");
mkdirSync(frameDir, { recursive: true });

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const { viewport, send, evaluate, close } = await launch(9409);
await viewport(768, 432, 1);
await send("Page.navigate", { url: `file:///${htmlPath.replace(/\\/g, "/")}` });
await sleep(1200);

for (let i = 0; i < frames; i += 1) {
  const ms = (i * 1000) / fps;
  await evaluate(`window.__seek(${ms})`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(frameDir, `f${String(i).padStart(4, "0")}.png`), Buffer.from(shot.result.data, "base64"));
  if (i % 12 === 0) console.log(`  frame ${i + 1}/${frames}`);
}
await close();

const run = spawnSync(FFMPEG, [
  "-y", "-loglevel", "error",
  "-framerate", String(fps), "-i", join(frameDir, "f%04d.png"),
  "-vf", "format=yuv420p", "-r", String(fps),
  "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", outPath,
], { encoding: "utf8" });
if (run.status !== 0) { console.log("encode failed:", run.stderr?.slice(0, 400)); process.exit(1); }
console.log("wrote", outPath, `${seconds}s @${fps}fps`);
