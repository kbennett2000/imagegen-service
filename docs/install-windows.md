# Install on Windows

You'll run **one** command in PowerShell and wait; the installer sets up everything else.

> **⚠️ Please read this first — an honest heads-up.**
> The Windows installer is **newer and less battle-tested than the Ubuntu one.** The Ubuntu install
> has been run start-to-finish on a real machine; the Windows version follows the exact same steps
> but hasn't been through as much real-world use yet. It should work — but if a step trips up,
> there's a **"If a step fails"** section at the bottom of this page. Don't be alarmed if you need
> it. If you have the choice of either computer, Ubuntu is the smoother path today.

*New here? Start with the [overview](README.md) to understand what this is and what it needs.*

---

## Step 0 — Do you have an NVIDIA graphics card?

This only works on a computer with an **NVIDIA graphics card** (the part that draws the image).
Check first:

1. Right-click the taskbar and choose **Task Manager** (or press **Ctrl + Shift + Esc**).
2. Click the **Performance** tab.
3. Look down the left side for **GPU**.
   - If it says **NVIDIA** (e.g. "NVIDIA GeForce RTX…"), you're good. 👍
   - If it only shows Intel or AMD, this computer can't run it — but another computer with an
     NVIDIA card could.

*(Another way: right-click the Start button → **Device Manager** → expand **Display adapters** →
look for an NVIDIA entry.)*

---

## Step 1 — Get the project onto your computer

The simplest way, no extra tools needed:

1. Go to **https://github.com/kbennett2000/imagegen-service** in your browser.
2. Click the green **Code** button → **Download ZIP**.
3. **Right-click the downloaded ZIP → Extract All…** Pick a simple location you'll remember, like
   your **Documents** folder.

*(If you already use `git`, you can instead run `git clone
https://github.com/kbennett2000/imagegen-service.git` — either way is fine.)*

---

## Step 2 — Open PowerShell in that folder

1. Open the extracted **imagegen-service** folder in File Explorer.
2. Click the **address bar** at the top (the part showing the folder path), type `powershell`, and
   press **Enter**. A blue PowerShell window opens, already pointed at the right folder.

---

## Step 3 (optional but nice) — Check your computer first, change nothing

Before installing anything, you can ask the installer to just **look** and report what it finds:

```powershell
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Check
```

It reports whether your NVIDIA card and driver are ready and which pieces are already present —
**without installing or changing anything.** If it flags a problem here, sort that out first.

*(The `-ExecutionPolicy Bypass` part just lets this one script run; it doesn't change any lasting
setting on your computer.)*

---

## Step 4 — Run the installer

When you're ready:

```powershell
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1
```

Then wait. **This takes a while — often 20–40 minutes**, mostly downloading several large files
(the AI models are big). You'll see progress messages the whole way.

You can safely **re-run this same command** any time — it skips whatever's already done, so
re-running never breaks anything (helpful if a download gets interrupted).

> **Setting up auto-start needs Administrator.** Near the end, the installer makes the service
> start automatically every time you turn on the PC. That step needs an **Administrator** PowerShell
> window. If you didn't start one, the installer will tell you — just close PowerShell, reopen it as
> Administrator (see below), and run the command again.
>
> **To open PowerShell as Administrator:** click Start, type **PowerShell**, right-click **Windows
> PowerShell**, choose **Run as administrator**. Then `cd` into the folder, e.g.
> `cd $HOME\Documents\imagegen-service`, and re-run the command from Step 4.

### If it stops and mentions the NVIDIA driver

The installer will **not** touch your graphics driver — changing it carelessly can break your
display. If your driver is missing or too old, it **stops and tells you plainly**, with the one
official link to get the right driver:
[https://www.nvidia.com/Download/index.aspx](https://www.nvidia.com/Download/index.aspx)

If that happens:

1. Install/update the driver from that link.
2. **Reboot** your computer.
3. Run the installer command again.

This is the one thing you do by hand. Everything else is automatic.

---

## What success looks like

When it finishes, you'll see a green **SUCCESS** message telling you it's running, with the address
to open (**http://localhost:8189**), an address other computers on your network can use, and how
many art styles loaded. It's now set to start automatically each time you boot the PC.

If it mentions a model or two being **skipped**, that's fine — those particular art styles still
work, they just look a little plainer.

---

## Step 5 — Try it

Open a web browser and go to:

**http://localhost:8189**

You'll see a simple page where you type a description and get a picture. See
**[Using it](using-it.md)** for a walkthrough.

---

## If a step fails

Because this installer is newer on Windows, here's what to do if something doesn't go smoothly:

- **Just run it again.** `powershell -ExecutionPolicy Bypass -File install\install-windows.ps1`
  skips everything already done and retries the rest. Most hiccups (a dropped download, a missed
  Administrator prompt) clear on a second run.
- **The auto-start step complained about permissions.** Reopen PowerShell **as Administrator** (see
  the box in Step 4), `cd` back into the folder, and run the installer again.
- **You want to see what state things are in.** Run the `-Check` command from Step 3 — it reports
  what's present and what's missing without changing anything.
- **The page at http://localhost:8189 won't load.** Wait a minute after install (the service needs
  a moment to warm up), then refresh. If it still won't load, re-run the installer.
- **Still stuck?** The Ubuntu path is the more proven one — if you have a computer running Ubuntu
  Linux with an NVIDIA card, [that install](install-ubuntu.md) is the smoother route today.
