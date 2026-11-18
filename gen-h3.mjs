// Build an API-format H3 text-to-video graph, queue it, and poll until done.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "http://127.0.0.1:8188";
const UNET = "minimax_h3_fl2va_pruned_w6a8.safetensors";
const CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
const VAE_VIDEO = "minimax_h3_sol_vae_fp16.safetensors";
const VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors";
const LORA = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";

const WIDTH = Number(process.argv[2] ?? 768);
const HEIGHT = Number(process.argv[3] ?? 432);
const LENGTH = Number(process.argv[4] ?? 73);
const STEPS = Number(process.argv[5] ?? 8);
const PROMPT_TEXT = process.argv[6] ?? "A cute chibi whale-girl maid standing in a cozy seaside diner at sunset, warm light, gentle camera push-in, soft anime film look, subtle hair movement, no text.";

const graph = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: UNET, weight_dtype: "default" } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: LORA, strength_model: 1 } },
  "3": { class_type: "ComfySwitchNode", inputs: { switch: true, on_false: ["1", 0], on_true: ["2", 0] } },
  "4": { class_type: "PrimitiveInt", inputs: { value: 20 } },
  "5": { class_type: "PrimitiveInt", inputs: { value: STEPS } },
  "6": { class_type: "ComfySwitchNode", inputs: { switch: true, on_false: ["4", 0], on_true: ["5", 0] } },
  "7": { class_type: "BasicScheduler", inputs: { model: ["3", 0], scheduler: "simple", steps: ["6", 0], denoise: 1 } },
  "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
  "9": { class_type: "RandomNoise", inputs: { noise_seed: 757358688076805, control_after_generate: "fixed" } },
  "10": { class_type: "CLIPLoader", inputs: { clip_name: CLIP, type: "minimax", device: "default" } },
  "11": { class_type: "VAELoader", inputs: { vae_name: VAE_VIDEO } },
  "12": { class_type: "VAELoader", inputs: { vae_name: VAE_AUDIO } },
  "13": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["10", 0], vae: ["11", 0], prompt: PROMPT_TEXT, width: WIDTH, height: HEIGHT, length: LENGTH } },
  "14": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["13", 0] } },
  "15": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["14", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["13", 1] } },
  "16": { class_type: "VAEDecode", inputs: { samples: ["15", 0], vae: ["11", 0] } },
  "17": { class_type: "VAEDecodeAudio", inputs: { samples: ["15", 0], vae: ["12", 0] } },
  "18": { class_type: "CreateVideo", inputs: { images: ["16", 0], audio: ["17", 0], fps: 24 } },
  "19": { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: "video/h3_test", format: "auto", codec: "auto" } },
};

writeFileSync(join(process.env.OUT_DIR ?? ".", "h3-prompt.json"), JSON.stringify({ prompt: graph, client_id: "h3-test" }, null, 2));
console.log(`graph nodes=${Object.keys(graph).length} size=${WIDTH}x${HEIGHT} length=${LENGTH} steps=${STEPS}`);

const queued = await fetch(`${HOST}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: graph, client_id: "h3-test" }),
});
const queuedJson = await queued.json();
if (!queued.ok) {
  console.log("QUEUE FAILED:", JSON.stringify(queuedJson).slice(0, 2000));
  process.exit(1);
}
console.log("prompt_id", queuedJson.prompt_id);

const started = Date.now();
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const history = await (await fetch(`${HOST}/history/${queuedJson.prompt_id}`)).json();
  const entry = history[queuedJson.prompt_id];
  if (entry) {
    const status = entry.status?.status_str ?? "?";
    console.log("status:", status, "| elapsed", ((Date.now() - started) / 1000).toFixed(0) + "s");
    if (status === "error") {
      console.log(JSON.stringify(entry.status).slice(0, 1500));
      process.exit(1);
    }
    const outputs = entry.outputs ?? {};
    for (const [node, value] of Object.entries(outputs)) {
      console.log("  output", node, JSON.stringify(value).slice(0, 400));
    }
    process.exit(0);
  }
  const queue = await (await fetch(`${HOST}/queue`)).json();
  const running = queue.queue_running?.length ?? 0;
  const pending = queue.queue_pending?.length ?? 0;
  if (i % 6 === 0) console.log(`  waiting… running=${running} pending=${pending} ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
console.log("TIMEOUT");
process.exit(1);
