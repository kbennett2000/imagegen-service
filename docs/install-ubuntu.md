# Install on Ubuntu Linux

This is the well-tested install path — it has been run start-to-finish on a real machine. Follow
the steps in order. You'll run **one** command and wait; the installer does the rest.

*New here? Start with the [overview](README.md) to understand what this is and what it needs.*

---

## Step 0 — Do you have an NVIDIA graphics card?

This only works on a computer with an **NVIDIA graphics card** (the part that draws the image).
Let's check first, so you don't get halfway in and hit a wall.

**The easy way:**

1. Open **Settings** → **About** (or search "About" in your apps).
2. Look at the **Graphics** line.
   - If it mentions **NVIDIA** (e.g. "NVIDIA GeForce RTX…"), you're good. 👍
   - If it says something else (Intel, AMD, "llvmpipe", "Mesa"), this computer can't run it — but
     another computer with an NVIDIA card could.

**Or, if you're comfortable opening a terminal**, type this and press Enter:

```bash
nvidia-smi
```

If you see a table with your graphics card's name, you have an NVIDIA card and a driver installed.
If you get "command not found", the driver isn't set up yet — the installer will detect that and
tell you exactly what to do (see the driver note below).

---

## Step 1 — Get the project onto your computer

You need the project files. Open a **terminal** (press the Super/Windows key, type "Terminal",
press Enter) and paste this:

```bash
git clone https://github.com/kbennett2000/imagegen-service.git
cd imagegen-service
```

> If `git` isn't installed, Ubuntu will suggest the command to install it (`sudo apt install git`).
> Run that, then try again.

---

## Step 2 (optional but nice) — Check your computer first, change nothing

Before the real install, you can ask the installer to just **look** at your computer and report
what it finds — without installing or changing anything:

```bash
bash install/install-linux.sh --check
```

It'll tell you whether your NVIDIA card and driver are good to go, how much graphics memory you
have, and which pieces are already present. Nothing is installed in this mode. If it reports a
problem here, fix that first.

---

## Step 3 — Run the installer

When you're ready, run the real thing:

```bash
bash install/install-linux.sh
```

Now you wait. **This takes a while — often 20–40 minutes**, mostly downloading several large files
(the AI models are big). That's normal. You'll see a stream of progress messages: checking your
system, setting up the drawing engine, downloading the models, and starting everything up.

You can safely **re-run this same command** any time. It skips whatever is already done, so
re-running never breaks anything — handy if your internet drops mid-download.

> **Optional — a Civitai key for a few extra art styles.** Most models download without any account.
> A few art styles come from [Civitai](https://civitai.com), which sometimes requires a (free) key to
> download. If the installer says it skipped a style, you can add your key and re-run:
> `bash install/install-linux.sh --civitai-token YOUR_KEY` (get a key at your Civitai account →
> API Keys). Everything works without it — those few styles just fall back to a plain look.

> **You may be asked for your password.** Near the end, the installer sets things up to start
> automatically every time you turn the computer on. That step needs your permission, so Ubuntu may
> ask for your login password. That's expected.

### If it stops and mentions the NVIDIA driver

The installer will **not** touch your graphics driver — changing it carelessly can break your
screen. Instead, if your driver is missing or too old, it **stops and tells you plainly**, and
gives you the one official link to get the right driver:
[https://www.nvidia.com/Download/index.aspx](https://www.nvidia.com/Download/index.aspx)

If that happens:

1. Install/update the driver from that link (or via Ubuntu's **"Additional Drivers"** tool:
   search "Additional Drivers" in your apps and pick the recommended NVIDIA driver).
2. **Reboot** your computer.
3. Run `bash install/install-linux.sh` again.

This is the one thing you do by hand. Everything else is automatic.

---

## What success looks like

When it finishes, you'll see a green **SUCCESS** banner like this:

```
========================================================
  SUCCESS — imagegen-service is running.
========================================================

  Test it now:      open  http://localhost:8189  in a browser
  From other PCs:   http://192.168.1.50:8189
  Health check:     http://localhost:8189/health
  ComfyUI backend:  http://localhost:8188

  LoRA styles loaded: 12
```

That means it's running **and** set to start again automatically every time you boot the computer.

If you see a line about a model or two being **skipped**, that's fine — those particular art styles
will still work, they'll just look a little plainer. Everything else is unaffected. (More on that
in [Using it](using-it.md).)

---

## Step 4 — Try it

Open a web browser and go to:

**http://localhost:8189**

You'll see a simple page where you can type a description and get a picture. Head to
**[Using it](using-it.md)** for a walkthrough.

---

## If something goes wrong

- **It stopped partway with an error.** Read the last message — the installer tries to say exactly
  which step failed and how to re-run. Then just run `bash install/install-linux.sh` again; it
  picks up where it left off.
- **You're not sure what state things are in.** Run `bash install/install-linux.sh --check` — it
  reports what's present without changing anything.
- **The page at http://localhost:8189 won't load.** Give it a minute after install (the service
  needs a moment to warm up), then refresh. If it still won't load, re-run the installer.
