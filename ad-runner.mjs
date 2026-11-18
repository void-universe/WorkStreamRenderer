// Ad runner: watch a WorkStream group for 广告分镜.json, render it with local MiniMax H3,
// then upload 渲染回执.md and post a message back into the group.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = readFileSync(process.env.WORKSTREAM_TOKEN_FILE ?? "ws.token", "utf8").trim();
const API = process.env.WORKSTREAM_API ?? "http://127.0.0.1:8000/functions/v1/app";
const COMFY = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
const STATE = process.env.STATE_FILE ?? "state.json";
const OUT_ROOT = process.env.OUT_DIR ?? "out";
const SHOT_FILE = "广告分镜.json";
const ONCE = process.argv.includes("--once");
const STREAM_ID = process.argv.find((a) => a.startsWith("--stream="))?.split("=")[1] ?? null;

const UNET = "minimax_h3_fl2va_pruned_w6a8.safetensors";
const CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
const VAE_VIDEO = "minimax_h3_sol_vae_fp16.safetensors";
const VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors";
const LORA = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";

async function call(action, body = {}) {
  const response = await fetch(`${API}?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workstream-token": TOKEN },
    body: JSON.stringify(body),
  });
  return response.json();
}

function graph(job) {
  const width = job.width ?? 768;
  const height = job.height ?? 432;
  const length = job.length ?? 73;
  const steps = job.steps ?? 8;
  const seed = job.seed ?? 123456;
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: UNET, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: LORA, strength_model: 1 } },
    "3": { class_type: "ComfySwitchNode", inputs: { switch: true, on_false: ["1", 0], on_true: ["2", 0] } },
    "4": { class_type: "PrimitiveInt", inputs: { value: 20 } },
    "5": { class_type: "PrimitiveInt", inputs: { value: steps } },
    "6": { class_type: "ComfySwitchNode", inputs: { switch: true, on_false: ["4", 0], on_true: ["5", 0] } },
    "7": { class_type: "BasicScheduler", inputs: { model: ["3", 0], scheduler: "simple", steps: ["6", 0], denoise: 1 } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: seed, control_after_generate: "fixed" } },
    "10": { class_type: "CLIPLoader", inputs: { clip_name: CLIP, type: "minimax", device: "default" } },
    "11": { class_type: "VAELoader", inputs: { vae_name: VAE_VIDEO } },
    "12": { class_type: "VAELoader", inputs: { vae_name: VAE_AUDIO } },
    "13": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["10", 0], vae: ["11", 0], prompt: job.prompt, width, height, length } },
    "14": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["13", 0] } },
    "15": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["14", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["13", 1] } },
    "16": { class_type: "VAEDecode", inputs: { samples: ["15", 0], vae: ["11", 0] } },
    "17": { class_type: "VAEDecodeAudio", inputs: { samples: ["15", 0], vae: ["12", 0] } },
    "18": { class_type: "CreateVideo", inputs: { images: ["16", 0], audio: ["17", 0], fps: 24 } },
    "19": { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: `video/ad_${job.name}`, format: "auto", codec: "auto" } },
  };
}

async function renderShot(job) {
  const queued = await fetch(`${COMFY}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph(job), client_id: `ad-${job.name}` }),
  });
  const queuedJson = await queued.json();
  if (!queued.ok) return { ok: false, error: JSON.stringify(queuedJson).slice(0, 300) };

  const started = Date.now();
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const history = await (await fetch(`${COMFY}/history/${queuedJson.prompt_id}`)).json();
    const entry = history[queuedJson.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str !== "success") return { ok: false, error: entry.status?.status_str ?? "failed" };
    const media = entry.outputs?.["19"]?.images?.[0];
    if (!media) return { ok: false, error: "no output" };
    return {
      ok: true,
      seconds: Math.round((Date.now() - started) / 1000),
      source: join(process.env.COMFY_OUTPUT ?? "output", media.subfolder ?? "", media.filename),
      meta: media.metadata ?? {},
    };
  }
  return { ok: false, error: "timeout" };
}

async function processOne(stream, file) {
  console.log(`[run] ${stream.name} / ${file.name}`);
  const content = await fetch(`${API}?action=files.get&id=${encodeURIComponent(file.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workstream-token": TOKEN },
    body: "{}",
  }).then((r) => r.json());
  if (!content.ok) { console.log("  read failed", JSON.stringify(content).slice(0, 200)); return; }
  let plan;
  try {
    plan = JSON.parse(content.content ?? "");
  } catch (error) {
    console.log("  bad json:", error.message);
    return;
  }

  const shots = (plan.shots ?? []).slice(0, 12);
  // 输出目录按片名固定：重跑时复用同一目录，已渲完的镜头直接跳过，不重复烧 GPU 时间。
  const slug = String(plan.title ?? "ad").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").slice(0, 40) || "ad";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outDir = join(OUT_ROOT, slug);
  mkdirSync(outDir, { recursive: true });
  console.log(`  ${shots.length} shots -> ${outDir}`);

  const rows = [];
  for (const [index, shot] of shots.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}_${shot.name ?? "shot"}`;
    const target = join(outDir, `${name}.mp4`);
    if (existsSync(target)) {
      console.log(`  [${index + 1}/${shots.length}] ${name} 已存在，跳过`);
      rows.push(`| ${name} | ${shot.width ?? 768}×${shot.height ?? 432} | - | (复用) | ✅ |`);
      continue;
    }
    console.log(`  [${index + 1}/${shots.length}] ${name} ${shot.width ?? 768}x${shot.height ?? 432} ${shot.length ?? 73}f`);
    const result = await renderShot({ ...shot, name });
    if (result.ok) {
      copyFileSync(result.source, target);
      rows.push(`| ${name} | ${shot.width ?? 768}×${shot.height ?? 432} | ${result.meta.duration?.toFixed(1) ?? "?"}s | ${result.seconds}s | ✅ |`);
      console.log(`    ok ${result.seconds}s`);
    } else {
      rows.push(`| ${name} | - | - | - | ❌ ${result.error} |`);
      console.log(`    FAILED ${result.error}`);
    }
  }

  const total = rows.length;
  const okCount = rows.filter((r) => r.includes("✅")).length;
  const receipt = [
    `# 渲染回执 · ${plan.title ?? "未命名"}`,
    "",
    `- 提交：${file.name}（群文件 ${file.id}）`,
    `- 完成：${okCount}/${total} 条`,
    `- 输出目录（本机）：\`${outDir}\``,
    "",
    "| 文件 | 分辨率 | 时长 | 渲染耗时 | 状态 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    okCount < total ? "有失败条目：按 skill 的说明只重跑失败那几条，不要整片重渲。" : "全部成功。按序号拼接即可得到粗剪。",
  ].join("\n");

  const uploaded = await call("files.upload", {
    stream_id: stream.id,
    name: `渲染回执-${stamp}.md`,
    content: receipt,
    content_type: "text/markdown",
  });
  console.log("  receipt uploaded:", uploaded.ok);

  await call("messages.send", {
    stream_id: stream.id,
    content: `《${plan.title ?? "未命名"}》渲染完成：${okCount}/${total} 条成功，回执已发群文件。输出在本机 \`${outDir}\`。`,
  });

  writeFileSync(STATE, JSON.stringify({ streamId: stream.id, fileId: file.id, at: new Date().toISOString() }), "utf8");
}

async function tick() {
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const streams = STREAM_ID
    ? [{ id: STREAM_ID, name: STREAM_ID }]
    : ((await call("streams.mine")).items ?? []);
  for (const stream of streams) {
    const files = await fetch(`${API}?action=files.list&stream_id=${encodeURIComponent(stream.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workstream-token": TOKEN },
      body: "{}",
    }).then((r) => r.json());
    const target = (files.items ?? []).find((f) => f.name === SHOT_FILE);
    if (!target) continue;
    if (state.fileId === target.id) continue;
    await processOne(stream, target);
    if (ONCE) return true;
  }
  return false;
}

if (ONCE) {
  const ran = await tick();
  console.log(ran ? "processed one" : "nothing new");
} else {
  console.log(`watching for ${SHOT_FILE} every 30s`);
  for (;;) {
    try { await tick(); } catch (error) { console.log("tick error", error.message); }
    await new Promise((r) => setTimeout(r, 30000));
  }
}
