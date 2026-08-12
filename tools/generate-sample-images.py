#!/usr/bin/env python3
"""Regenerate the sample images used in the docs (README, gallery, using-it).

Run it against a live imagegen-service (see the developer reference for how to start one):

    python3 tools/generate-sample-images.py            # uses http://localhost:8189
    python3 tools/generate-sample-images.py http://192.168.1.50:8189

It writes PNGs into docs/images/. Seeds are fixed so re-runs are reproducible. Requires only
Pillow (`pip install Pillow`) plus the Python standard library — no GPU on this machine; the
service does the drawing. The eight style tiles, the character-consistency montage (IP-Adapter),
and the composed banner are all produced here.
"""
import base64, io, json, os, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8189"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "images")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def generate(prompt, style=None, quality="standard", seed=None, width=None, height=None,
             references=None, reference_strength=None):
    body = {"prompt": prompt, "quality": quality}
    if style: body["style"] = style
    if seed is not None: body["seed"] = seed
    if width: body["width"] = width
    if height: body["height"] = height
    if references: body["references"] = references
    if reference_strength: body["referenceStrength"] = reference_strength
    req = urllib.request.Request(BASE + "/generate", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=360) as r:
        if "image/png" not in r.headers.get("content-type", ""):
            raise RuntimeError(f"non-image response: {r.read()[:200]!r}")
        return Image.open(io.BytesIO(r.read())).convert("RGB")


def save_gallery(img, name, size=768):
    img = img.copy()
    img.thumbnail((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, f"{name}.png"), "PNG", optimize=True)
    print(f"  saved {name}.png")


# ---- 1. Eight style tiles (same prompt, different styles) --------------------------------
EXAMPLES = [
    ("example-oil-painting", "a stone bridge over a misty gorge", "oil painting", 101),
    ("example-watercolour",  "a stone bridge over a misty gorge", "watercolour",  102),
    ("example-comic-book",   "a stone bridge over a misty gorge", "comic book",   103),
    ("example-pixel-art",    "a stone bridge over a misty gorge", "pixel art",    104),
    ("example-anime",        "a fox spirit in a bamboo forest",   "anime",        105),
    ("example-cyberpunk",    "a rainy neon alley at night",       "cyberpunk",    106),
    ("example-3d",           "a friendly robot barista",          "3d",           107),
    ("example-storybook",    "a sleepy dragon curled around a lighthouse", "storybook", 108),
]
for name, prompt, style, seed in EXAMPLES:
    print(f"[style] {style}: {prompt!r}")
    save_gallery(generate(prompt, style=style, seed=seed), name)

# ---- 2. Character-consistency montage (IP-Adapter reference images) ----------------------
print("[reference] portrait + three scenes from one reference photo")
CHAR = ("a portrait of a young woman explorer with wavy red hair, freckles, "
        "and a teal scarf, warm friendly expression")
portrait = generate(CHAR, seed=201)
_pb = io.BytesIO(); portrait.save(_pb, "PNG")
ref_b64 = base64.b64encode(_pb.getvalue()).decode()
SCENES = [
    ("exploring an ancient jungle temple", 202),
    ("standing on a snowy mountain peak at sunrise", 203),
    ("reading in a cozy candlelit library", 204),
]
tiles = [("reference photo", portrait)]
for scene, seed in SCENES:
    tiles.append((scene, generate(f"{CHAR}, {scene}", seed=seed,
                                   references=[ref_b64], reference_strength=0.6)))
TW, TH, PAD, BAR = 512, 512, 8, 40
montage = Image.new("RGB", (TW * 4 + PAD * 3, TH + BAR), "#14161c")
draw = ImageDraw.Draw(montage)
small = ImageFont.truetype(FONT_REG, 20)
for i, (label, im) in enumerate(tiles):
    im = im.copy(); im.thumbnail((TW, TH), Image.LANCZOS)
    x = i * (TW + PAD)
    montage.paste(im, (x, 0))
    txt = label if len(label) <= 34 else label[:33] + "…"
    draw.text((x + TW / 2, TH + BAR / 2), txt, font=small, fill="#c9cede", anchor="mm")
montage.thumbnail((1600, 1600), Image.LANCZOS)
montage.save(os.path.join(OUT, "example-reference.png"), "PNG", optimize=True)
print("  saved example-reference.png")

# ---- 3. Banner (hero image + title overlay) ---------------------------------------------
print("[banner] hero image + title")
hero = generate("a vast fantastical landscape of floating islands, painterly clouds, "
                "waterfalls, golden hour light, epic and colorful, highly detailed",
                style="oil painting", seed=301, width=1344, height=768)
BW, BH = 1280, 360
hero = hero.resize((int(BW * 1.05), int(BW * 1.05 * 768 / 1344)), Image.LANCZOS)
left, top = (hero.size[0] - BW) // 2, (hero.size[1] - BH) // 2
hero = hero.crop((left, top, left + BW, top + BH))
grad = Image.new("L", (BW, 1))
for x in range(BW):
    grad.putpixel((x, 0), int(210 * max(0, 1 - x / (BW * 0.62))))
banner = Image.composite(Image.new("RGB", (BW, BH), "#0d0f16"), hero, grad.resize((BW, BH)))
d = ImageDraw.Draw(banner)
d.text((80, 92), "imagegen-service", font=ImageFont.truetype(FONT_BOLD, 72), fill="#ffffff")
d.rectangle((84, 178, 444, 184), fill="#c15cff")
d.text((80, 206), "Type a description, get a picture.",
       font=ImageFont.truetype(FONT_REG, 27), fill="#eef0f8")
d.text((80, 250), "Free and private image generation, on your own computer.",
       font=ImageFont.truetype(FONT_REG, 20), fill="#aab0c6")
banner.save(os.path.join(OUT, "banner.png"), "PNG", optimize=True)
print("  saved banner.png")
print("DONE")
