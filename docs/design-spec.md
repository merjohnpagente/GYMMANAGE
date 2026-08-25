# Design Spec — Graceselle Portfolio (M1/M2 + M3 mockups, design-only)

> Owner: ux-ui-designer. Input: `docs/build-spec.md` (Pass 2 finalized), current `index.html`. Output: exact design decisions for frontend-web to implement 1:1 in the single `index.html`. No code edits by this role.
> Constraint context: dark premium aesthetic (`--bg #0a0a0d`, `--violet #9d4edd`, Anton/JetBrains Mono/Inter), single file, `file://`-compatible, all new motion gated by `prefers-reduced-motion`.

---

## 1. Design tokens — extend `:root`

Keep every existing token unchanged. Append:

```css
:root{
  /* violet family steps (consistent with #9d4edd / #c77dff) */
  --violet-3:#e0aaff;          /* lightest tint — accent on light mockups, rim light */
  --violet-4:#7b2cbf;          /* darker step — CTA gradient end, deco layer */

  /* glow intensities */
  --glow:rgba(157,78,221,.35);       /* ambient glow, standard */
  --glow-strong:rgba(199,125,255,.45); /* hero photo halo */
  --glow-weak:rgba(157,78,221,.16);  /* hover fills, subtle tint */

  /* photo card */
  --frame:#1d1a24;                   /* photo card base bg (between photo and border) */
  --grad-border:linear-gradient(160deg, rgba(199,125,255,.9), rgba(157,78,221,.35) 45%, rgba(255,255,255,.08) 75%, transparent); /* 2px gradient frame border */
  --shadow-frame:0 1px 1px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35), 0 30px 80px rgba(0,0,0,.55), 0 0 60px var(--glow); /* layered depth */
  --shadow-inner:inset 0 1px 0 rgba(255,255,255,.08), inset 0 -60px 120px rgba(0,0,0,.45); /* inner soft shadow on photo */
  --overlay-photo:linear-gradient(180deg, rgba(10,10,13,0) 55%, rgba(10,10,13,.45) 82%, rgba(10,10,13,.82)); /* bottom legibility overlay */

  /* floating badges */
  --badge-bg:rgba(16,15,20,.55);
  --badge-border:rgba(199,125,255,.28);

  /* CTA */
  --cta-grad:linear-gradient(135deg, #c77dff, #9d4edd 55%, #7b2cbf);
  --cta-shadow:0 10px 30px rgba(157,78,221,.35), inset 0 0 0 1px rgba(255,255,255,.08);
  --cta-shadow-hover:0 16px 44px rgba(157,78,221,.50), 0 0 24px rgba(199,125,255,.35);

  /* status */
  --ok:#4ade80;              /* online dot, mockup status */
  --warn:#fbbf24;            /* mockup status only */

  /* radii — consistent system */
  --r-card:18px;             /* project cards (existing) */
  --r-frame:22px;            /* hero photo frame */
  --r-thumb:14px;            /* mockup inner panels */
  --r-pill:100px;            /* CTAs, badges, tags */

  /* hero typography */
  --fs-name:clamp(44px, 9vw, 128px);
}
```

**Type scale (hero + badges):**

| Element | Font | Size | Weight | Letter-spacing |
|---|---|---|---|---|
| hero eyebrow | JetBrains Mono | 12px | 400 | .14em, lowercase |
| name | Anton | `var(--fs-name)` | 400 | -.01em, uppercase, gradient clip (keep existing) |
| role | JetBrains Mono | `clamp(14px, 2.4vw, 20px)` | 400 | .02em |
| description | Inter | 14px | 400 | normal, `line-height 1.6`, `color:var(--muted)` |
| CTA labels | JetBrains Mono | 13px | 500 | .08em, uppercase |
| floating badges | JetBrains Mono | 11px | 400 | .06em |
| photo caption | JetBrains Mono | 11px | 400 | .08em |
| mock chrome / labels | JetBrains Mono | 8–9px | 400–500 | .05em |

**Contrast (spot-checked):** `--muted #8c8794` on `--bg #0a0a0d` ≈ 5.4:1 ✓ AA; `--violet-2 #c77dff` on dark ≈ 7.0:1 ✓ AA; badge white on `--badge-bg` + blur ✓.

---

## 2. Hero layout spec

### Structure (new DOM order)

```
section.hero#top
  .hero-eyebrow            ← keep existing (left col)
  .hero-grid               ← NEW wrapper
    .hero-text             ← left column
      h1.name
      .hero-role (role + .cursor)
      p.hero-desc          ← moved from old .hero-foot
      .cta-row
        a.btn-primary  "View my work" → #work
        a.btn-secondary "Say hi" → mailto:hello@graceselle.dev
    .hero-photo            ← right column (entrance-animated)
      .photo-deco          ← decorative blurred duplicate (aria-hidden)
      figure.photo-frame
        img (1000×1333)
        .photo-overlay     ← aria-hidden
        figcaption.photo-caption
      .badge.badge-status  ← top-left pill
      .badge.badge-code    ← bottom-right chip
  .scroll-cue              ← absolute, bottom-center of .hero
```

### Grid

```css
.hero-grid{
  display:grid;
  grid-template-columns:minmax(0, 55fr) minmax(0, 45fr);
  align-items:center;
  gap:clamp(24px, 4vw, 64px);
  width:100%; max-width:1280px; margin:0 auto;
}
```

**≥1024px (desktop):** 2 columns as above. Name `clamp(44px, 9vw, 128px)`. `.hero-photo` `justify-self:end`, `align-self:center`. Left column text stack order fixed: eyebrow → name → role → desc → CTAs. Desc keeps `max-width:360px`. `.cta-row` `margin-top:36px`.

**768–1023px (tablet, 2 columns kept):** shrink name to `clamp(34px, 7.5vw, 88px)`; gap to `clamp(20px, 3vw, 40px)`; photo column narrows naturally via `minmax(0,45fr)`; card never exceeds `min(100%, 400px)` wide here. Rationale: the photo consumes more relative width at these sizes, so the display type must give it room.

**<768px (mobile, single column):** `.hero-grid{grid-template-columns:1fr}`; DOM order already text-first, photo second (no reordering needed); photo centered below text with `margin-top:56px` on `.hero-photo`. Name `clamp(36px, 10.5vw, 56px)`. Hero `min-height` becomes content-driven (`min-height:auto`), padding `96px 20px 64px`. `.hero-desc` full width. `.scroll-cue` hidden (`display:none`). CTAs stack full-width (see §4). Photo size: `width:min(76vw, 340px); margin-inline:auto` → height ≈ 453px at max (3:4). "Reduced height" = both hero min-height relaxes AND photo shrinks; nothing on mobile forces 100svh.

---

## 3. Photo card treatment (realistic portrait — priority)

Source: `assets/hero-graceselle.jpg` (1000×1333, q75–80, <500KB). Card proportions `aspect-ratio:3/4`.

### 3.1 Frame
- `border-radius:var(--r-frame)` (22px).
- 2px gradient border via double-background technique (no extra element):
  `background:linear-gradient(var(--frame),var(--frame)) padding-box, var(--grad-border) border-box; border:2px solid transparent;`
- Inner soft shadow: `box-shadow:var(--shadow-inner)` — a top hairline highlight + deep bottom fade, so the photo reads as sitting *inside* a frame, not floating flat.
- `img` gets `border-radius:calc(var(--r-frame) - 2px)`; `object-fit:cover`; `width:100%; height:auto; display:block;`
- Hover (desktop only, `@media(hover:hover)`): `img{transform:scale(1.03)}`, `transition:transform .6s cubic-bezier(.22,1,.36,1)`. Frame itself stays static (zoom reads as "photo breathing", not tilting).

### 3.2 Lighting
- Ambient halo: `.hero-photo::before` — `content:''; position:absolute; inset:-44px; z-index:-1; background:radial-gradient(52% 60% at 50% 34%, var(--glow-strong), transparent 70%); filter:blur(26px);` (glow sits behind card; blur keeps it soft, never a hard ring).
- Top rim light: `.photo-frame::after` — `content:''; position:absolute; top:0; left:7%; right:7%; height:2px; border-radius:2px; background:linear-gradient(90deg, transparent, rgba(231,213,255,.85), transparent); filter:blur(.4px); pointer-events:none;` Simulates a cool violet key-light catching the top edge.

### 3.3 Depth layers
- `.photo-frame` layered shadow, in order: contact shadow → mid → deep drop → violet glow: `box-shadow:var(--shadow-frame)` (token defined above). The glow layer is the last one so it reads as ambient, not outline.
- `.photo-deco` (behind, `z-index:0`; frame `z-index:1`): same `aspect-ratio:3/4` and 22px radius; `position:absolute; top:22px; left:-20px; transform:rotate(3.5deg); background:linear-gradient(160deg, rgba(157,78,221,.38), rgba(76,29,120,.14)); border:1px solid rgba(199,125,255,.30); filter:blur(7px);` — a rotated, blurred "ghost frame" offset top-left, adding hand-placed depth. Hidden `@media(max-width:767px)` (saves vertical space, no visual gain at small size).

### 3.4 Bottom overlay + caption
- `.photo-overlay`: `position:absolute; inset:0; border-radius:inherit; background:var(--overlay-photo);` (transparent to 55% → .82 black at bottom; aria-hidden).
- `.photo-caption` (figcaption, bottom-left inside frame): `position:absolute; left:16px; bottom:14px; font-family:var(--mono); font-size:11px; letter-spacing:.08em; color:rgba(244,242,248,.92);` text: `$ graceselle --status: open-to-work` — terminal-prompt voice matching the "code" chip.

### 3.5 Floating badges (absolute, gently animating)

Base `.badge`: `position:absolute; z-index:3; display:inline-flex; align-items:center; gap:8px; padding:9px 14px; border-radius:var(--r-pill); background:var(--badge-bg); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid var(--badge-border); font-family:var(--mono); font-size:11px; letter-spacing:.06em; color:var(--ink); box-shadow:0 8px 24px rgba(0,0,0,.35);`

1. **Status pill — top-left** of frame: `top:16px; left:16px;` text `online — available for work`. Status dot: `.badge-status::before{content:''; width:7px; height:7px; border-radius:50%; background:var(--ok); box-shadow:0 0 10px rgba(74,222,128,.85);}`.
2. **Code chip — bottom-right**, overlapping the frame edge for realism: `right:-10px; bottom:64px;` text `&lt;/&gt; code`. On mobile (`<768px`) pull inside: `right:10px`.

Animation (idle float, staggered):
```css
.badge-status{animation:badgeFloat 5s ease-in-out infinite;}
.badge-code{animation:badgeFloat 6.5s ease-in-out 1.1s infinite;}
@keyframes badgeFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
```
Amplitudes differ (5s/6.5s + delay) so badges never move in lockstep. Reduced motion: existing global `*{animation:none!important}` kills this; entrance opacity must not depend on animation (see 3.6).

### 3.6 Entrance animation
- `.hero-photo` initial: `opacity:0; transform:translateY(26px) scale(.965);`
- `.hero-photo.in`: `opacity:1; transform:none; transition:opacity .9s ease .12s, transform .9s cubic-bezier(.22,1,.36,1) .12s;`
- JS: on `DOMContentLoaded`, if `matchMedia('(prefers-reduced-motion: reduce)').matches` → add `.in` immediately (no transition); else add `.in` after `requestAnimationFrame` + ~100ms. **Critical:** without this guard, the global reduced-motion rule sets `transition:none` while `opacity:0` persists → invisible photo. 
- Hover lift on wrapper (desktop): `.hero-photo:hover{transform:translateY(-4px)}` — merged with entrance via the same transition; skip on touch (`@media(hover:hover)`).

---

## 4. CTA spec

`.cta-row{display:flex; gap:14px; flex-wrap:wrap; margin-top:36px;}` both buttons `min-height:48px` (hit target ≥ 44px), `display:inline-flex; align-items:center; justify-content:center;`

**Primary `.btn-primary`** ("View my work"):
- `padding:15px 32px; border-radius:var(--r-pill); font-family:var(--mono); font-size:13px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; color:#fff; background:var(--cta-grad); box-shadow:var(--cta-shadow); transition:transform .25s ease, box-shadow .25s ease;`
- hover: `transform:translateY(-3px); box-shadow:var(--cta-shadow-hover);`
- active: `transform:translateY(-1px);`
- focus-visible: existing global `outline:2px solid var(--violet-2); outline-offset:3px` applies.

**Secondary `.btn-secondary`** ("Say hi"):
- `padding:15px 32px; border-radius:var(--r-pill); font-family:var(--mono); font-size:13px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; color:var(--ink); border:1px solid rgba(199,125,255,.45); background:var(--glow-weak); transition:transform .25s ease, border-color .25s ease, background .25s ease, box-shadow .25s ease;`
- hover: `transform:translateY(-2px); border-color:var(--violet-2); background:rgba(157,78,221,.14); box-shadow:0 0 20px var(--glow-weak);`

**Mobile (`<640px`):** `.cta-row{flex-direction:column}`; both buttons `width:100%`.

Nav `.cta` (header) unchanged.

---

## 5. Scroll cue + hero background polish

### Scroll cue (desktop only)
- Move to `position:absolute; left:50%; bottom:26px; transform:translateX(-50%);` row: `scroll` + `↓`, existing float animation retained.
- Add vertical hairline: `.scroll-cue::after{content:''; width:1px; height:36px; background:linear-gradient(180deg, var(--violet-2), transparent); animation:cueDrop 1.8s ease-in-out infinite;}`
- `@keyframes cueDrop{0%{transform:scaleY(0); transform-origin:top; opacity:0} 45%{opacity:1} 100%{transform:scaleY(1); transform-origin:top; opacity:0}}` — an animated "drip" that hands off to the page below.
- `pointer-events:none`; hidden `<768px` (photo now occupies the hero bottom — a cue there would collide).

### Hero background
Keep structure (`::before` grid + two radial gradients on `.hero`), rebalance for the photo column:
- Grid lines unchanged (64px cell, `rgba(255,255,255,.035)`), but mask biased toward the text side so the photo reads as depth foreground: `mask-image:radial-gradient(72% 70% at 52% 36%, black 22%, transparent 76%);`
- Radials: strengthen the one behind the photo (top-right), soften bottom-left: `radial-gradient(52% 46% at 76% 20%, rgba(157,78,221,.28), transparent 60%), radial-gradient(30% 34% at 14% 88%, rgba(157,78,221,.12), transparent 60%), var(--bg);`

---

## 6. Mockup thumbnails spec (M3, design-only)

Each `.card .thumb` (keep `height:230px`, keep per-card `--grad-a/--grad-b`) becomes a mini browser window. Delete the `PROJECT_0X.PNG` span. Add per-card accent: `--accent`.

### Shared browser chrome (every mock)
Structure inside `.thumb`:
```
.mock                        ← fills thumb: flex column, height 100%
  .mock-bar                  ← chrome bar
    .mock-dots  (3 × 8px circles: #ff5f57, #febc2e, #28c840)
    .mock-url                ← pill: "northline.app/dashboard" etc.
  .mock-body                 ← the per-project UI, flex:1
```
- `.mock`: `background:linear-gradient(160deg, var(--grad-a), var(--grad-b));` (reuses existing card overrides).
- `.mock-bar`: `display:flex; align-items:center; gap:10px; padding:9px 12px; background:rgba(10,10,13,.55); border-bottom:1px solid rgba(199,125,255,.15);`
- `.mock-url`: `margin-inline:auto; font-family:var(--mono); font-size:9px; letter-spacing:.05em; color:rgba(244,242,248,.65); background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08); border-radius:100px; padding:3px 12px; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`
- Body heights: chrome ≈ 32px → body ≈ 198px. All inner text mono 8–9px, `color:rgba(244,242,248,.6)`; inner panels `border:1px solid rgba(255,255,255,.08); border-radius:8px; background:rgba(10,10,13,.35);`

### Mock 1 — Northline · analytics dashboard (bars) — `--accent:#c77dff`
URL: `northline.app/dashboard`. Body: `flex row`, left mini sidebar (`width:34px`, 3 stacked rounded blocks `rgba(255,255,255,.08)`, first tinted with accent) + main column: two stat tiles (9px label + 13px Anton-ish bold numeral — use mono 700), then a bar chart: flex row `align-items:flex-end; gap:6px; height:64px;` with 5 bars `width:16px; border-radius:3px 3px 0 0; background:linear-gradient(0deg, var(--violet-4), var(--accent));` heights `36/58/44/74/100%`, middle bar widest + `box-shadow:0 0 8px var(--accent)` (active state), baseline `border-top:1px solid rgba(255,255,255,.1)`.

### Mock 2 — Pulsegrid · terminal — `--accent:#9d4edd`
URL: `pulsegrid.dev/console`. Body: dark terminal `background:rgba(0,0,0,.35); border-radius:8px; padding:10px 12px;` lines as rows: `$ ./pulsegrid --watch` in accent (`$` prefix), muted output lines, one line in `--accent` bold, trailing block cursor (8×12px accent rect, `animation:blink` — reuses existing blink keyframes; dies under reduced motion). Bottom status row: 3 pills with 5px status dots (2× `--ok`, 1× `--warn`), labels `api / ws / db` 8px.

### Mock 3 — Ledgerly · kanban board — `--accent:#7b2cbf`
URL: `ledgerly.app/board`. Body: `display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:10px;` three columns: header pill (8px uppercase, `background:rgba(199,125,255,.14); color:var(--violet-2); border-radius:100px; padding:2px 8px; align-self:start`) then 2 stacked cards (`height:38px; border-radius:6px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.08);`) one card per column containing a mini progress bar (`width:70%` inner div `height:3px; background:var(--accent); border-radius:2px`). Columns: `todo / doing / done`.

### Mock 4 — Fieldkit · analytics (line + donut) — `--accent:#e0aaff`
URL: `fieldkit.app/analytics`. Body: top row: big stat (mono 700 16px in `--accent`) + right-aligned 44px donut ring: `border-radius:50%; background:conic-gradient(var(--accent) 0 62%, rgba(255,255,255,.08) 62% 100%);` with 10px inner hole (`::after` centered circle `background:var(--grad-b)`). Below: area line chart drawn with `clip-path:polygon(0 78%, 12% 62%, 25% 68%, 38% 44%, 52% 55%, 66% 30%, 80% 40%, 100% 12%, 100% 100%, 0 100%)` on a `height:70px; background:rgba(255,255,255,.05);` panel, filled `background:linear-gradient(180deg, rgba(224,170,255,.5), rgba(224,170,255,.02));` plus a 1px accent "stroke" illusion via an inset top border on a same-width, 12px-tall clipped overlay (or accept flat area fill + baseline).

All mock animations (blink, bar pulse) default off / killed by reduced-motion global rule. Mockups are `aria-hidden="true"` (pure decoration; card body text carries meaning).

---

## 7. Handoff notes (frontend-web must not miss)

1. **Mobile order:** <768px single column, photo **below** text — DOM already text-first; don't add reordering, just collapse the grid.
2. **Image:** only `assets/hero-graceselle.jpg` referenced. Attributes on `<img>`: `src="assets/hero-graceselle.jpg"`, `alt="Portrait of Graceselle, full-stack developer"`, `width="1000" height="1333"`, `fetchpriority="high"`, `decoding="async"`. Never reference `image.png`. Do not delete `image.png`.
3. **CLS:** aspect-ratio on `.photo-frame` AND explicit width/height attrs; `height:auto` on the img.
4. **Entrance trap:** without the reduced-motion JS guard (§3.6) the photo stays `opacity:0`. Guard must be in JS, not just CSS.
5. **backdrop-filter:** include `-webkit-backdrop-filter` for Safari; badges degrade gracefully (bg is semi-opaque anyway).
6. **Header `mix-blend-mode:difference`:** keep on desktop; the fixed header scrolling over the photo is acceptable (photo sits below hero in z-order at scroll). Do not add blend to the photo itself.
7. **Existing global reduced-motion rule** (`*{animation:none!important; transition:none!important}`) already covers badges, cue, blink; don't duplicate it, don't remove it.
8. **Keep existing reveal system** (`.reveal`/`.in`) for sections untouched; hero entrance is a separate class (`.hero-photo`/`.in`) so the two don't collide.
9. **Mockups:** keep `height:230px`, scroll-snap, and per-card `--grad-a/--grad-b` inline overrides; add `--accent` inline per card. Old `PROJECT_0X.PNG` spans must be removed.
10. **Nav typo + casing:** "HOme" → "Home" (M3, but do it in the same pass); keep mono-uppercase for other links.
11. **file:// sanity:** no external assets beyond Google Fonts (already preconnected); gradient-border and clip-path techniques are pure CSS, safe.
12. **Verify at:** 1440, 1280, 1024, 900, 768, 640, 375 widths; keyboard-only (focus-visible on both CTAs + badges are not focusable, they're decorative); reduced-motion emulation in DevTools.
13. **a11y:** `aria-hidden="true"` on `.photo-deco`, `.photo-overlay`, `.mock*`; badges/caption are content (keep readable, don't hide). All new CTAs are real `<a>` elements (no divs).
14. **Scope guard:** single `index.html` + `assets/hero-graceselle.jpg` only; no new files beyond the optimized image; no npm/build step.

---

Design spec at docs/design-spec.md — over to frontend-web to implement.
