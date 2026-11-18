// Batch H3 generation: read prompts.json, render each clip, log timings, collect outputs.
// Usage: node batch-h3.mjs [prompts.json] [outDir]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const HOST = "http://127.0.0.1:8188";
const promptsFile = process.argv[2] ?? "prompts.json";
const outDir = process.argv[3] ?? process.env.OUT_DIR ?? "out/batch";
mkdirSync(outDir, { recursive: true });

const UNET = "minimax_h3_fl2va_pruned_w6a8.safetensors";
const CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
const VAE_VIDEO = "minimax_h3_sol_vae_fp16.safetensors";
const VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors";
const LORA = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";

const jobs = JSON.parse(readFileSync(promptsFile, "utf8"));
const results = [];

function buildGraph(job) {
  const width = job.width ?? 768;
  const height = job.height ?? 432;
  const length = job.length ?? 73;
  const steps = job.steps ?? 8;
  const seed = job.seed ?? Math.floor(Math.random() * 1e15);
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
    "19": { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: `video/batch_${job.name}`, format: "auto", codec: "auto" } },
  };
}

async function waitFor(promptId, timeoutMs = 60 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const history = await (await fetch(`${HOST}/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry) return { entry, seconds: (Date.now() - started) / 1000 };
  }
  return { entry: null, seconds: (Date.now() - started) / 1000 };
}

for (const [index, job] of jobs.entries()) {
  const label = `${index + 1}/${jobs.length} ${job.name}`;
  console.log(`\n=== ${label} (${job.width ?? 768}x${job.height ?? 432}, ${job.length ?? 73}f, ${job.steps ?? 8} steps) ===`);
  const queued = await fetch(`${HOST}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: buildGraph(job), client_id: `batch-${job.name}` }),
  });
  const queuedJson = await queued.json();
  if (!queued.ok) {
    console.log("  queue failed:", JSON.stringify(queuedJson).slice(0, 600));
    results.push({ name: job.name, ok: false, error: "queue_failed" });
    continue;
  }
  const { entry, seconds } = await waitFor(queuedJson.prompt_id);
  if (!entry || entry.status?.status_str !== "success") {
    console.log("  failed:", entry?.status?.status_str ?? "timeout");
    results.push({ name: job.name, ok: false, error: entry?.status?.status_str ?? "timeout" });
    continue;
  }
  const images = entry.outputs?.["19"]?.images ?? [];
  const produced = [];
  for (const media of images) {
    const source = join(process.env.COMFY_OUTPUT ?? "output", media.subfolder ?? "", media.filename);
    const target = join(outDir, `${job.name}.mp4`);
    if (existsSync(source)) { copyFileSync(source, target); produced.push(target); }
  }
  console.log(`  ok in ${seconds.toFixed(0)}s -> ${produced.map((p) => basename(p)).join(", ")}`);
  results.push({ name: job.name, ok: true, seconds: Math.round(seconds), files: produced });
}

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
console.log("\n=== summary ===");
for (const r of results) console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.name} ${r.seconds ? r.seconds + "s" : r.error ?? ""}`);
