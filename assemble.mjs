// 总装：把一组镜头拼成成片，烧字幕，配旁白并做闪避混音。
// 用法：node assemble.mjs <plan.json>
// plan.json 见 README；片名、台词、声线都在里面，脚本不含任何具体片子。
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const planPath = process.argv[2];
if (!planPath || !existsSync(planPath)) { console.log("usage: node assemble.mjs <plan.json>"); process.exit(1); }
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const base = dirname(resolve(planPath));
const out = resolve(base, plan.out ?? "final.mp4");
const work = join(base, "build");
mkdirSync(work, { recursive: true });

const run = (args, label = "") => {
  const result = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (result.status !== 0) { console.log("ffmpeg failed", label, result.stderr?.slice(0, 400)); process.exit(1); }
};
const duration = (file) => {
  const probe = spawnSync(FFMPEG, ["-i", file, "-hide_banner"], { encoding: "utf8" });
  const match = (probe.stderr ?? "").match(/Duration: (\d+):(\d+):([\d.]+)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
};

const clips = (plan.clips ?? []).map((name) => resolve(base, name));
if (!clips.length) { console.log("plan.clips 是空的"); process.exit(1); }
const width = plan.width ?? 768;
const height = plan.height ?? 432;
const fps = plan.fps ?? 24;

// 1) 统一规格：尺寸、帧率、音频轨都要一致，拼起来才不会错位
const normalized = clips.map((file, index) => {
  const target = join(work, `n${String(index).padStart(2, "0")}.mp4`);
  const hasAudio = (spawnSync(FFMPEG, ["-i", file, "-af", "volumedetect", "-f", "null", "NUL"], { encoding: "utf8" }).stderr ?? "").includes("Audio:");
  const inputs = hasAudio ? ["-i", file] : ["-f", "lavfi", "-t", "10", "-i", "anullsrc=r=48000:cl=stereo", "-i", file];
  const map = hasAudio ? ["-map", "0:v", "-map", "0:a"] : ["-map", "1:v", "-map", "0:a"];
  run([
    ...inputs, ...map,
    "-vf", `scale=${width}:${height}:flags=lanczos,fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", target,
  ], `normalize ${index}`);
  return { file: target, dur: duration(target) };
});

const total = normalized.reduce((sum, clip) => sum + clip.dur, 0);
console.log("total", total.toFixed(2) + "s");

// 2) 字幕：plan.lines 里每句写绝对时间（秒），没有就按整片平均分
const assTime = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};
const lines = plan.lines ?? [];
const subs = [];
for (const line of lines) {
  if (line.subtitle === false) continue;
  const start = Number(line.at ?? 0) + 0.25;
  const end = Math.min(start + (Number(line.span) || 2.6), total - 0.1);
  subs.push({ start, end, text: line.text });
}
const ass = [
  "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 2", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  `Style: Sub,${plan.font ?? "Microsoft YaHei"},${plan.fontSize ?? 26},&H00EAF2F1,&H00EAF2F1,&H00140A06,&H64000000,0,0,0,0,100,100,0.6,0,1,2.2,0.8,2,40,40,30,1`,
  "", "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ...subs.map((s) => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Sub,,0,0,0,,${s.text}`),
].join("\n") + "\n";
writeFileSync(join(work, "subs.ass"), ass, "utf8");

// 3) 拼片
const listFile = join(work, "concat.txt");
writeFileSync(listFile, normalized.map((c) => `file '${c.file.replace(/\\/g, "/")}'`).join("\n"), "utf8");
const videoOnly = join(work, "video.mp4");
run(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoOnly], "concat");

// 4) 旁白：edge-tts 合成，去首尾静音，超长的按 span 限速
const voices = plan.voices ?? { A: "zh-CN-YunxiNeural", B: "zh-CN-YunjianNeural" };
const spoken = lines.filter((line) => line.text && line.voice !== false && line.who !== "none");
const wavs = [];
for (const [index, line] of spoken.entries()) {
  const mp3 = join(work, `vo-${index}.mp3`);
  const raw = join(work, `vo-${index}-raw.wav`);
  const trimmed = join(work, `vo-${index}.wav`);
  const fitted = join(work, `vo-${index}-fit.wav`);
  const voice = voices[line.who] ?? voices.A;
  const rate = line.rate ?? (line.who === "N" ? "-10%" : "-2%");
  spawnSync("python", ["-m", "edge_tts", "--voice", voice, `--rate=${rate}`, "--text", line.text, "--write-media", mp3], { encoding: "utf8" });
  spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", mp3, "-ar", "48000", "-ac", "1", raw], { encoding: "utf8" });
  spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", raw,
    "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse",
    trimmed], { encoding: "utf8" });
  const span = Number(line.span) || 2.6;
  const rawDur = duration(trimmed);
  const tempo = rawDur > span ? Math.min(rawDur / span, 1.35) : 1;
  let finalWav = trimmed;
  if (tempo > 1) {
    spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", trimmed, "-af", `atempo=${tempo.toFixed(3)}`, fitted], { encoding: "utf8" });
    finalWav = fitted;
  }
  console.log(`  ${line.who ?? "A"} @${Number(line.at ?? 0).toFixed(2)}s  ${line.text}  (${duration(finalWav).toFixed(2)}s)`);
  wavs.push({ at: Number(line.at ?? 0), wav: finalWav });
}

// 5) 混音：现场声低切 + 旁白触发闪避
const inputs = ["-i", videoOnly];
wavs.forEach((w) => inputs.push("-i", w.wav));
const voIn = wavs.map((w, i) => `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(w.at * 1000)}[v${i + 1}]`).join(";");
const voLabels = wavs.map((_, i) => `[v${i + 1}]`).join("");
const filters = wavs.length
  ? [
    voIn,
    `${voLabels}amix=inputs=${wavs.length}:duration=longest,volume=${wavs.length},acompressor=threshold=-16dB:ratio=3:attack=5:release=80,volume=1.35,pan=stereo|c0=c0|c1=c0[vobus]`,
    "[vobus]asplit=2[vo_mix][vo_sc]",
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=100,volume=${plan.bedVolume ?? 0.9}[main]`,
    `[main][vo_sc]sidechaincompress=threshold=0.02:ratio=${plan.duckRatio ?? 10}:attack=12:release=380[ducked]`,
    "[ducked][vo_mix]amix=inputs=2:duration=first,volume=2,loudnorm=I=-15:TP=-1.5:LRA=11[aout]",
  ]
  : ["[0:a]loudnorm=I=-15:TP=-1.5:LRA=11[aout]"];

run([
  ...inputs,
  "-filter_complex", `[0:v]ass=${join(work, "subs.ass").replace(/\\/g, "/").replace(/:/g, "\\:")}[vout];${filters.join(";")}`,
  "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  "-t", total.toFixed(2), out,
], "final");
console.log("wrote", out, duration(out).toFixed(2) + "s");
