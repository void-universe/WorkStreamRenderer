# WorkStreamRenderer

The local renderer behind the [WorkStreamSkills](https://github.com/void-universe/WorkStreamSkills) pack: it turns a storyboard JSON into clips, builds title
cards from HTML, adds voice-over, and cuts the whole thing with subtitles.

Nothing here is machine-bound. Every path, endpoint and model filename comes from an environment variable, and no
credentials are stored in the repository.

## What each script does

| Script | Purpose |
| --- | --- |
| `gen-h3.mjs` | Render one shot through ComfyUI (`/prompt` + `/history`), print the output path. |
| `batch-h3.mjs` | Render a list of shots from a JSON array, skip nothing, report per-shot time. |
| `ad-runner.mjs` | The WorkStream bridge: watch a group for `广告分镜.json`, render every shot, upload a receipt back. |
| `render-title.mjs` | Render an HTML/CSS title card to video frame by frame (24fps, deterministic). |
| `assemble.mjs` | Concatenate clips, burn subtitles, synthesize voice-over with edge-tts, mix with ducking. |
| `cdp.mjs` | Small Chrome DevTools Protocol client used by `render-title.mjs`. |
| `scripts/privacy-check.mjs` | Scan the repository for paths, credentials and personal data before publishing. |

## Requirements

- Node 22+
- ComfyUI with the MiniMax H3 weights (text encoder, video VAE, audio VAE, an 8-step turbo LoRA)
- `ffmpeg` on `PATH` (or set `FFMPEG`)
- Edge or Chromium for the title cards (set `BROWSER_PATH`)
- Python with `edge-tts` for voice-over: `pip install edge-tts`
- For `ad-runner.mjs`: a running WorkStream function endpoint and a session token

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI endpoint |
| `COMFY_OUTPUT` | `output` | ComfyUI's own output directory |
| `OUT_DIR` | `./out` | Where rendered clips and receipts land |
| `FFMPEG` | `ffmpeg` | ffmpeg binary |
| `BROWSER_PATH` | Edge on Windows | Browser used for title cards |
| `MODEL_UNET` / `MODEL_CLIP` / `MODEL_VAE_VIDEO` / `MODEL_VAE_AUDIO` / `MODEL_LORA` | Comfy-Org quantised names | Weight filenames |
| `WORKSTREAM_API` | `http://127.0.0.1:8000/functions/v1/app` | Function endpoint |
| `WORKSTREAM_TOKEN_FILE` | `./ws.token` | File holding the session token |
| `STATE_FILE` | `./state.json` | What `ad-runner` already processed |

The token is read from a file you create yourself; it never lives in this repository.

## Usage

```bash
# one shot
node gen-h3.mjs 768 432 73 8 "Cinematic live-action, a person at a desk…"

# a batch from a JSON array of { name, prompt, width, height, length, steps, seed }
node batch-h3.mjs prompts.json ./out/batch

# bridge a WorkStream group
node ad-runner.mjs --once --stream=<stream-id>

# a title card from HTML
node render-title.mjs card.html out/card.mp4 3.5 24

# the final cut
node assemble.mjs plan.json
```

### plan.json

`assemble.mjs` reads one file that describes the cut. Paths are relative to the plan file.

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

`at` is the absolute time in seconds. Each spoken line becomes a subtitle and a voice-over; `span` caps how long it may
run before the tempo is nudged up, `subtitle: false` mutes the subtitle, `voice: false` skips the audio.

## Licence

The scripts are published so a self-hosted WorkStream deployment can render. MiniMax H3 weights are **not** included
and carry their own community licence with regional restrictions — check it before commercial use.
