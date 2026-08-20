![imagegen-service — type a description, get a picture](docs/images/banner.png)

<h1 align="center">imagegen-service</h1>

<p align="center">
  <b>Type a description, get a picture.</b><br>
  A free, private image maker that runs on <i>your own computer</i> — no cloud, no subscription, no per-picture fee.
</p>

<p align="center">
  <a href="docs/README.md">📖 Start here (plain-English guide)</a> ·
  <a href="docs/install-ubuntu.md">🐧 Install on Linux</a> ·
  <a href="docs/install-windows.md">🪟 Install on Windows</a> ·
  <a href="docs/gallery.md">🖼️ Gallery</a> ·
  <a href="docs/developer-reference.md">🛠️ For developers</a>
</p>

---

## What is this?

You type words like *"a stone bridge over a misty gorge"* and it makes you an image. The whole
job happens **on your own machine, using your computer's graphics card** — nothing is sent to a
company's servers, and there's no account or fee. Once it's set up, it's yours.

One thing to know up front, because it's the part people find surprising:

> **imagegen-service isn't an app you open every day. It's a building block.**
> Think of it as the *engine* of a car, not the car. Its job is to quietly sit there and hand
> pictures to your **other** apps whenever they ask — a game that needs to illustrate a scene, a
> storytelling app that wants matching artwork, or your own little projects.

It **does** come with a simple built-in web page for trying it yourself — type a prompt, watch the
picture appear — which is perfect for a first play and for testing. See
**[Using it](docs/using-it.md)**.

## A taste of what it makes

*Every image below was made by the service itself — the same words, in different styles. See
[the full gallery](docs/gallery.md).*

| | | |
|:---:|:---:|:---:|
| ![oil painting example](docs/images/example-oil-painting.png) | ![watercolour example](docs/images/example-watercolour.png) | ![comic book example](docs/images/example-comic-book.png) |
| **oil painting** | **watercolour** | **comic book** |
| ![anime example](docs/images/example-anime.png) | ![cyberpunk example](docs/images/example-cyberpunk.png) | ![storybook example](docs/images/example-storybook.png) |
| **anime** | **cyberpunk** | **storybook** |

## What you need (the honest version)

- **A Windows or Linux computer.**
- **A supported NVIDIA graphics card.** This is the important one. Drawing an image is heavy work,
  and it's the graphics card (the "GPU") that does it. No NVIDIA card means it can't run on that
  machine. *(Not sure if you have one? Each install page shows you how to check in a click or two.)*

> **What about a Mac?** Sorry — **Macs aren't supported.** The part that actually draws the image
> needs an NVIDIA graphics card, and Macs don't have one. If your main computer is a Mac, you can
> still set this up on **another** computer that has an NVIDIA card (an old gaming PC is perfect)
> and reach it from anywhere on your home network.

## Get started in three steps

1. **Check your graphics card** — the install page for your platform starts by showing you how.
2. **Run one installer command** — it sets up everything (the drawing engine, the art models, and
   this service) and keeps it all running, even after a reboot.
3. **Open the page and make a picture.**

Pick your platform and follow that one page — each is written for someone who has never done
anything like this before:

- 🐧 **[Install on Ubuntu Linux](docs/install-ubuntu.md)** — *the well-tested path*
- 🪟 **[Install on Windows](docs/install-windows.md)** — *works, but newer (see the note on that page)*

Then head to **[Using it](docs/using-it.md)**.

## The art styles

Generate a plain, realistic picture, or pick one of **12 art styles** to give it a distinct look:

| Style | The feel | | Style | The feel |
|---|---|---|---|---|
| *(no style)* | Realistic | | storybook | Whimsical |
| pixel art | Retro | | 3d | Pixar-ish |
| oil painting | Classic | | cyberpunk | Neon |
| comic book | Bold | | ukiyo-e | Japanese |
| lego-style | Blocky | | claymation | Clay |
| pencil sketch | Hand-drawn | | anime | Animated |
| watercolour | Soft | | | |

You can also just **describe a style in your own words** (like "noir" or "ghibli") and it'll do its
best. There's even a way to feed it a **reference photo** so a character keeps the same face across
different scenes — see [Using it](docs/using-it.md#make-a-character-look-consistent).

## Part of a small family of projects

imagegen-service is one piece of a set of local-first hobby projects — small building blocks that
each do one job well, on your own hardware:

| Project | What it is | How it relates |
|---|---|---|
| **[Chronicle](https://github.com/kbennett2000/chronicle)** | A mobile-first solo Dungeons & Dragons app with an AI dungeon master. | The ancestor — imagegen-service is a clean-room extraction of Chronicle's image backend. |
| **[Scriptorium](https://github.com/kbennett2000/scriptorium)** | Turns books into illustrated, offline-readable bundles. | A live user — it calls this service to draw its illustration plates. |
| **[text-transform-service](https://github.com/kbennett2000/text-transform-service)** | Turns messy text into clean, structured results using a local AI model. | A sibling building block — it writes the image *prompts* other apps then send here. |
| **[Brickfeed](https://github.com/kbennett2000/brickfeed-news)** | A toy-brick-styled news site that rewrites and illustrates each story. | An ecosystem sibling that builds on the same local-first toolkit. |

## For developers

The API, configuration, authentication, and always-on deployment details live in the
**[Developer reference](docs/developer-reference.md)** — the HTTP contract (`POST /generate`,
`GET /styles`, `GET /health`), the JSON config file, the optional token gate, and the systemd unit.

Quick facts: TypeScript on Node, run directly with `tsx` (no build step); Node's built-in HTTP
server and `fetch` (no web framework, no runtime npm dependencies — it shells out to the `ffmpeg`
and `flock` system tools, like a script would); file-based config only (no environment variables).
It fronts a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and returns raw PNG bytes.

**GPU tenancy.** This service and text-transform-service share one GPU. They take turns via a shared
advisory `flock` (`/run/gpu-tenant.lock`): whoever holds it drains its queued work, frees its VRAM
(this service POSTs ComfyUI `/free`), then hands off. It's invisible to callers — `/generate` and
`/animate` just block briefly if the peer is mid-batch. Configurable under `gpuLock` (kill-switch
`gpuLock.enabled`); fails open if the lockfile is unavailable. See
[ADR-0012](docs/adr/0012-gpu-tenancy-flock-lease.md).

```bash
npm install
npm start          # listens on 0.0.0.0:8189, talks to ComfyUI on :8188
npm run test:unit  # CI-safe; mocks ComfyUI, no GPU needed
```

## Experimental: animate an image (Wan 2.2)

Turn a still into a short video with
[Wan 2.2 TI2V 5B](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) running through the
same ComfyUI instance (ADR-[0008](docs/adr/0008-image-to-video-wan22.md)/[0009](docs/adr/0009-animate-endpoint.md)).
Served by **`POST /animate`** (still image + prompt in → mp4 out); see the
[developer reference](docs/developer-reference.md#post-animate--videomp4).

The 5B model fits the 12 GB card with no quantization tricks, but note SDXL and Wan **swap in and out
of the GPU**, so the first video job after an image job (or vice-versa) pauses to load the model, and
a render takes minutes.

**One-time setup** on the ComfyUI box:

```bash
# 1. Update ComfyUI first — the Wan 2.2 nodes require a current build.
cd ~/comfyui && git pull                     # (however you normally update ComfyUI)

# 2. Fetch the three model files (~18 GB total). Idempotent — re-runs skip completed files.
#    Default models root is ~/comfyui/models; override with --models-root <dir>.
cd ~/Desktop/projects/imagegen-service
npx tsx scripts/fetch-wan22-models.ts
#    ...then restart ComfyUI so it re-scans its models directory.
```

Then animate through the service (check `GET /health`'s `wan.ready` first):

```bash
curl -X POST http://localhost:8189/animate \
  -H 'content-type: application/json' \
  -d '{"image":"'"$(base64 -w0 still.png)"'","prompt":"the scene comes to life, gentle camera push-in"}' \
  --output animated.mp4
```

There is also a standalone **`scripts/smoke-wan22.ts`** that submits to ComfyUI directly (bypassing the
service) for pipeline debugging — it fails loudly if ComfyUI is unreachable or a model is missing.

**Chain clips into a longer video.** In the test UI, use **Continue from last frame** to start a new
clip where the last one ended, **Add to sequence** to queue clips, then **Stitch & download** to join
them into one mp4 (`POST /stitch`, a lossless `ffmpeg` concat — needs `ffmpeg` on the host).

## License

[MIT](LICENSE) © 2026 Kris Bennett.
