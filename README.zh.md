# WorkStreamRenderer（中文）

[WorkStreamSkills](../..) 技能包背后的本机渲染器：把分镜 JSON 变成镜头、把 HTML 变成片头卡、配旁白、烧字幕、拼成片。

这个仓库里没有任何与机器绑定的东西：路径、端点、权重文件名全部来自环境变量，仓库里不存任何凭据。

## 每个脚本做什么

| 脚本 | 用途 |
| --- | --- |
| `gen-h3.mjs` | 走 ComfyUI（`/prompt` + `/history`）渲一条镜头，打印产物路径。 |
| `batch-h3.mjs` | 按 JSON 数组批量渲，逐条报耗时。 |
| `ad-runner.mjs` | WorkStream 桥：盯群里的 `广告分镜.json`，逐条渲染，回传 `渲染回执.md`。 |
| `render-title.mjs` | 把 HTML/CSS 标题卡逐帧渲成视频（24fps，可复现）。 |
| `assemble.mjs` | 拼片、烧字幕、用 edge-tts 合成旁白、做闪避混音。 |
| `cdp.mjs` | `render-title.mjs` 用的小型 CDP 客户端。 |
| `scripts/privacy-check.mjs` | 发布前扫描路径、凭据与个人信息。 |

## 依赖

- Node 22+
- 带 MiniMax H3 权重的 ComfyUI（文本编码器、视频 VAE、音频 VAE、8 步加速 LoRA）
- `ffmpeg` 在 `PATH` 里（或设 `FFMPEG`）
- Edge 或 Chromium 用于标题卡（设 `BROWSER_PATH`）
- Python + `edge-tts`：`pip install edge-tts`
- `ad-runner.mjs` 还需要一个在跑的 WorkStream Function 端点和会话令牌

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 端点 |
| `COMFY_OUTPUT` | `output` | ComfyUI 自己的输出目录 |
| `OUT_DIR` | `./out` | 渲好的镜头与回执落点 |
| `FFMPEG` | `ffmpeg` | ffmpeg 可执行文件 |
| `BROWSER_PATH` | Windows 上的 Edge | 渲标题卡用的浏览器 |
| `MODEL_UNET` / `MODEL_CLIP` / `MODEL_VAE_VIDEO` / `MODEL_VAE_AUDIO` / `MODEL_LORA` | Comfy-Org 量化版文件名 | 权重文件名 |
| `WORKSTREAM_API` | `http://127.0.0.1:8000/functions/v1/app` | Function 端点 |
| `WORKSTREAM_TOKEN_FILE` | `./ws.token` | 存会话令牌的文件 |
| `STATE_FILE` | `./state.json` | `ad-runner` 的处理记录 |

令牌由你自己写进文件，永远不会进这个仓库。

## 用法

```bash
# 单条
node gen-h3.mjs 768 432 73 8 "Cinematic live-action, a person at a desk…"

# 批量：prompts.json 是 { name, prompt, width, height, length, steps, seed } 的数组
node batch-h3.mjs prompts.json ./out/batch

# 桥接一个 WorkStream 群
node ad-runner.mjs --once --stream=<stream-id>

# HTML 标题卡
node render-title.mjs card.html out/card.mp4 3.5 24

# 总装
node assemble.mjs plan.json
```

### plan.json

`assemble.mjs` 只读这一份文件描述整条片子，路径相对 plan 文件所在目录。

```json
{
  "out": "final.mp4",
  "width": 768,
  "height": 432,
  "fps": 24,
  "clips": ["01_hook.mp4", "02_problem.mp4", "03_card.mp4"],
  "voices": { "A": "zh-CN-YunxiNeural", "B": "zh-CN-YunjianNeural", "N": "zh-CN-YunjianNeural" },
  "lines": [
    { "at": 0.25, "who": "N", "text": "第三十七天，还是包子。" },
    { "at": 3.10, "who": "A", "text": "这个镜头，先给脸。" }
  ]
}
```

`at` 是绝对时间（秒）。每句同时生成字幕和配音；`span` 限制它最长占多久（超了会轻微加速），`subtitle: false` 只留声音，
`voice: false` 只留字幕。

## 许可

脚本公开，供自托管 WorkStream 渲染使用。MiniMax H3 权重**不在**这里，适用其社区许可（按地域限制商用），商用前请自行确认。
