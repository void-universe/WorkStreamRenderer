// 全部与机器相关的默认值集中在这里：换一台机器只改环境变量，不改脚本。
import { join } from "node:path";

export const COMFY_URL = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
/** ComfyUI 的输出目录（它自己的 output/），脚本从这里取生成好的文件。 */
export const COMFY_OUTPUT = process.env.COMFY_OUTPUT ?? "output";
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), "out");
export const WS_API = process.env.WORKSTREAM_API ?? "http://127.0.0.1:8000/functions/v1/app";
export const WS_TOKEN_FILE = process.env.WORKSTREAM_TOKEN_FILE ?? join(process.cwd(), "ws.token");
export const STATE_FILE = process.env.STATE_FILE ?? join(process.cwd(), "state.json");
export const BROWSER = process.env.BROWSER ?? "msedge";

/** 权重文件名：Comfy-Org 官方量化版的名字，换模型只改环境变量。 */
export const MODELS = {
  unet: process.env.MODEL_UNET ?? "minimax_h3_fl2va_pruned_w6a8.safetensors",
  clip: process.env.MODEL_CLIP ?? "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vaeVideo: process.env.MODEL_VAE_VIDEO ?? "minimax_h3_sol_vae_fp16.safetensors",
  vaeAudio: process.env.MODEL_VAE_AUDIO ?? "minimax_h3_audio_vae_fp32.safetensors",
  lora: process.env.MODEL_LORA ?? "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
};
