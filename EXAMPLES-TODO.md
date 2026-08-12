# Example images — to fill in on the next pass

Every image referenced in the docs is currently a **placeholder SVG** in `docs/images/`. On the next
pass, generate the real picture for each row below (via the service — the prompt/style/quality/size
is given), then drop the PNG in and swap the reference (`example-oil-painting.svg` →
`example-oil-painting.png`) in the markdown files that use it.

All example prompts use the default size (1024×1024) and `standard` quality unless noted.

| Placeholder file | Prompt | Style | Notes |
|---|---|---|---|
| `docs/images/banner.svg` | *(hero artwork — designer's choice; wide 1280×360-ish crop)* | any striking style | Used at the top of `README.md`. Wants a single bold, attractive image with room for the title, or a strip of tiles. |
| `docs/images/example-oil-painting.svg` | a stone bridge over a misty gorge | oil painting | Same prompt across the first style row. |
| `docs/images/example-watercolour.svg` | a stone bridge over a misty gorge | watercolour | |
| `docs/images/example-comic-book.svg` | a stone bridge over a misty gorge | comic book | |
| `docs/images/example-pixel-art.svg` | a stone bridge over a misty gorge | pixel art | |
| `docs/images/example-anime.svg` | a fox spirit in a bamboo forest | anime | |
| `docs/images/example-cyberpunk.svg` | a rainy neon alley at night | cyberpunk | |
| `docs/images/example-3d.svg` | a friendly robot barista | 3d | |
| `docs/images/example-storybook.svg` | a sleepy dragon curled around a lighthouse | storybook | |
| `docs/images/example-reference.svg` | the same character rendered in several scenes | *(any)* + reference image | Demonstrates character consistency — generate 2–3 scenes from one reference photo, ideally as a small montage. |

## Where each image is used

- **`README.md`** — `banner.svg` (top); the 6-tile "A taste of what it makes" grid
  (oil-painting, watercolour, comic-book, anime, cyberpunk, storybook).
- **`docs/README.md`** — `test-ui-result.png` (real screenshot, keep).
- **`docs/gallery.md`** — all `example-*.svg`.
- **`docs/using-it.md`** — `example-reference.svg`, plus the three real test-UI screenshots (keep).

## Real screenshots already in the repo (keep — not placeholders)

- `docs/images/test-ui-empty.png`
- `docs/images/test-ui-styles.png`
- `docs/images/test-ui-result.png`
