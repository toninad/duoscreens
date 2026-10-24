# Duo Screenshot Studio

Turn your existing App Store screenshots into **App Store-ready iPhone Duo screenshots**, one for the
**inner (unfolded) display** and one for the **outer (cover) display**, with marketing headlines, in a few minutes.

Everything runs in the browser. Screenshots are never uploaded: they're read with `URL.createObjectURL`,
drawn on a canvas and zipped locally. The only network call is the optional headline translation, which sends **text only**.

![Editor](docs/editor.png)

| Sample export: inner display, 2007 × 2853 (licensed) | Outer display, 1398 × 2034 (free, watermark) |
|---|---|
| <img src="docs/sample-export.png" width="320"> | <img src="docs/sample-export-outer-free.png" width="240"> |

## Features (MVP)

- Drag-and-drop or pick multiple screenshots; reorder and remove them. There's also a built-in sample screenshot.
- 5 templates: **Midnight**, **Sunrise**, **Paper**, **Cobalt** and **Mint**. They mix gradient backgrounds, headline on top or at the bottom, a device frame or a rounded screen, and a fit or bleed layout.
- A headline and subheadline per screenshot, background, gradient and text colors, 4 font choices (vendored Inter, Space Grotesk, DM Serif Display, plus System UI) and a text size slider.
- An optional separate image for the outer display, for example a real cover-screen capture.
- **Export ZIP** with every screenshot × both displays × every language, at Apple's exact pixel sizes.
  The PNGs are **8-bit RGB with no alpha channel**, because App Store Connect rejects transparency. A tiny PNG encoder in `src/png.js` handles this, since `canvas.toBlob` always writes RGBA.
- **Translate headlines:** calls a configurable endpoint and adds each language as its own folder in the ZIP. A Supabase edge function stub using Claude is included.
- **Free mode** adds a small "Made with Duo Screenshot Studio" watermark. A license key field removes it. Lemon Squeezy validation is stubbed; see below.

## iPhone Duo screenshot sizes ✅ verified

| Display | Portrait | Landscape |
|---|---|---|
| Outer (cover) | **1398 × 2034** | 2034 × 1398 |
| Inner (unfolded) | **2007 × 2853** | 2853 × 2007 |

The rules are PNG or JPEG, 1–10 screenshots per size, and no alpha channel or transparency. Duo screenshots are optional today and **required from April 2027** for apps built with the iOS 27.1 SDK or later. Submitting them adds an "optimized for iPhone Duo" badge to the product page.

Sources, checked 2026-10-24:
- Apple, App Store Connect Help, *Screenshot specifications* (iPhone › iPhone Duo):
  https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- Apple Developer News, *Prepare and submit your apps for iPhone Duo*: https://developer.apple.com/news/?id=kkphp5qo
- App Store Connect release notes, Sep 9 and Oct 15, 2026: https://developer.apple.com/help/app-store-connect/release-notes/
- Secondary: https://appstorescreenshotstudio.com/posts/iphone-duo-app-store-screenshot-sizes/ notes that the inner
  *screenshot* size (2007 × 2853) is larger than the inner *panel* resolution (1878 × 2670). Use the spec size.

All sizes live in one constant: `DUO_SIZES` in `src/config.js`. Each display can be posed **portrait or landscape**
(Device › Inner display / Outer display), and the export uses the matching Apple size.

### Device frames and samples

- Frame templates draw the real iPhone Duo frames from `vendor/frames/<finish>/{inner,outer}-{portrait,landscape}.webp`.
  The screen opening and corner radii of each frame are in `FRAME_GEOMETRY` (`src/frames.js`); the screenshot is
  cover-fitted into that opening and the frame (with the camera) is drawn on top. Finishes are listed in `DEVICE_COLORS`.
- "Try a sample" loads real captures listed in `SAMPLE_SHOTS` (`src/sample.js`) from `samples/`, one per pose.
  If they're missing it falls back to a generated screen at the current inner size.

## Run locally

No build step. Any static server works; ES modules just need http:// rather than file://.

```bash
cd duo-screenshot-studio
python3 -m http.server 8000
# open http://localhost:8000
```

Konva 9.3.22, JSZip 3.10.2 and the fonts are vendored in `vendor/`, so the app works offline.

## Test

There's a headless end-to-end test. It serves the app, uploads two screenshots through the real file input, edits text,
switches through all templates, translates against a mocked endpoint, and exports free and unlocked. It then checks every PNG in
the ZIP for exact dimensions and an RGB/no-alpha color type, and confirms the watermark goes away after unlocking.

```bash
cd tests
npm install
npx playwright install chromium   # add --with-deps on a fresh Linux box
node e2e.mjs
```

The test regenerates `docs/editor.png`, `docs/sample-export.png` and `docs/sample-export-outer-free.png`.

## Translation endpoint (Supabase + Claude)

`supabase/functions/translate/index.ts` is a Deno edge function that calls the Anthropic Messages API
(`POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`) with `ANTHROPIC_API_KEY` from the environment.
**It is not deployed.** To deploy it:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # never commit this
supabase secrets set ANTHROPIC_MODEL=<current model id> # optional, defaults to claude-sonnet-4-5
supabase functions deploy translate
```

Then set `TRANSLATE_ENDPOINT` (and the **anon** key in `TRANSLATE_HEADERS`) in `src/config.js`.
The contract is `POST { texts: string[], targetLanguage, sourceLanguage }` → `{ translations: string[] }`.

## Licensing (Lemon Squeezy) — stub

`src/license.js` → `checkLicense(key)`:
- For now, only the dev key `DUO-DEV-UNLOCK` (set in `LICENSE.devKey` in `src/config.js`) unlocks. **Change or remove it before launch.**
- Real validation is already written behind `LICENSE.lemonSqueezyEnabled`. It uses Lemon Squeezy's public License API, which needs no secret key:

```bash
curl -X POST https://api.lemonsqueezy.com/v1/licenses/validate \
  -H "Accept: application/json" \
  -d "license_key=<key>"          # optional: -d "instance_id=<id>"
```

  The response is `{ valid, error, license_key: { status, activation_limit, ... }, instance, meta: { store_id, product_id, product_name, ... } }`.
  Check `valid` and that `meta.store_id` and `meta.product_id` match your products. Docs: https://docs.lemonsqueezy.com/api/license-api/validate-license-key
  Related endpoints: `POST /v1/licenses/activate` (`license_key`, `instance_name`) and `POST /v1/licenses/deactivate`.

## TODO

- [ ] Lemon Squeezy: create products (€19 per app, €49 lifetime), fill in `storeId`, `productIds` and `buyUrl`, flip `lemonSqueezyEnabled`, and remove the dev key.
      Verify that the License API allows browser CORS; if it doesn't, proxy it through a Supabase function. Optionally activate per device.
- [ ] Deploy the translate function, lock `ALLOWED_ORIGIN`, and add rate limiting or license gating so it can't be abused.
- [ ] Landscape layouts. The sizes are already in `DUO_SIZES`.
- [ ] Persist projects with IndexedDB; for now, reloading the page loses work.
- [ ] Per-screenshot template overrides, drag-to-reorder, and moving or scaling the device by hand.
- [ ] Fonts for CJK. Vendored fonts cover Latin and Latin Extended; Japanese, Korean and Chinese fall back to system fonts.
- [ ] A JPEG export option for smaller files. PNGs use an Up filter and are around 1–3 MB each.
- [ ] Landing page and SEO page ("iPhone Duo screenshot sizes") that links to the Duo-ready sprint service.
- [ ] Test in Safari and Firefox. The automated test only covers Chromium.

## Project layout

```
index.html               app shell
src/config.js            DUO_SIZES, endpoints, license config
src/templates.js         5 templates + fonts
src/render.js            Konva layout for one screenshot on one display
src/png.js               RGB (no-alpha) PNG encoder
src/app.js               state, UI, export
src/license.js           license check (Lemon Squeezy stub)
src/translate.js         translate client
src/sample.js            generates the sample screenshot
supabase/functions/translate/index.ts   Claude translation edge function (not deployed)
tests/e2e.mjs            Playwright end-to-end test
vendor/                  Konva, JSZip, fonts (+ licenses)
```
