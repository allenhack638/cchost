---
name: cchost ui
description: A calm local control panel for Claude Code profiles; every change previewed, then reported.
colors:
  primary: "#2563eb"
  primary-hover: "#1d4ed8"
  primary-fg: "#ffffff"
  focus: "#2563eb"
  bg: "#fafafa"
  surface: "#ffffff"
  surface-2: "#f4f4f5"
  surface-3: "#ececee"
  border: "#e4e4e7"
  border-strong: "#d4d4d8"
  text: "#18181b"
  text-2: "#52525b"
  text-3: "#6b6b73"
  shared-bg: "#eff6ff"
  shared-fg: "#1d4ed8"
  shared-bd: "#bfdbfe"
  private-bg: "#fef3c7"
  private-fg: "#92400e"
  private-bd: "#fde68a"
  missing-fg: "#6b6b73"
  missing-bd: "#d4d4d8"
  foreign-bg: "#fef2f2"
  foreign-fg: "#b91c1c"
  foreign-bd: "#fecaca"
  ok: "#15803d"
  ok-bg: "#dcfce7"
  warn: "#b45309"
  warn-bg: "#fef3c7"
  err: "#dc2626"
  err-fg: "#b91c1c"
  err-bg: "#fef2f2"
  danger-solid: "#dc2626"
  overlay: "rgba(9, 9, 11, 0.32)"
  dark-bg: "#09090b"
  dark-surface: "#111113"
  dark-surface-2: "#18181b"
  dark-surface-3: "#212125"
  dark-border: "#27272a"
  dark-border-strong: "#3f3f46"
  dark-text: "#fafafa"
  dark-text-2: "#a1a1aa"
  dark-text-3: "#8f8f98"
  dark-primary: "#2563eb"
  dark-primary-hover: "#1d4ed8"
  dark-focus: "#60a5fa"
  dark-shared-bg: "#172554"
  dark-shared-fg: "#bfdbfe"
  dark-shared-bd: "#1e3a8a"
  dark-private-bg: "#3a2a0a"
  dark-private-fg: "#fcd34d"
  dark-private-bd: "#713f12"
  dark-foreign-bg: "#3b0d0d"
  dark-foreign-fg: "#fca5a5"
  dark-foreign-bd: "#7f1d1d"
  dark-ok: "#4ade80"
  dark-ok-bg: "#052e16"
  dark-warn: "#fbbf24"
  dark-err: "#f87171"
  dark-overlay: "rgba(0, 0, 0, 0.55)"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  panel-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "3px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-fg}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    height: "32px"
  button-quiet-hover:
    backgroundColor: "{colors.err-bg}"
    textColor: "{colors.err-fg}"
  button-danger-solid:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.primary-fg}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "16px"
  badge-shared:
    backgroundColor: "{colors.shared-bg}"
    textColor: "{colors.shared-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  badge-private:
    backgroundColor: "{colors.private-bg}"
    textColor: "{colors.private-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  badge-missing:
    backgroundColor: "transparent"
    textColor: "{colors.missing-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  badge-foreign-link:
    backgroundColor: "{colors.foreign-bg}"
    textColor: "{colors.foreign-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  pill-logged-in:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  nav-item-current:
    backgroundColor: "{colors.shared-bg}"
    textColor: "{colors.shared-fg}"
    rounded: "{rounded.md}"
    padding: "7px 8px"
  segmented-pressed:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-fg}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
---

# Design System: cchost ui

## Overview

**Creative North Star: "The Clear Window"**

The page is a window onto what is on disk, not an app with opinions of its own. It follows the admin-dashboard category standard deliberately, built to Vercel and Linear's level of craft: neutral zinc surfaces, 1px hairlines, one blue for action and selection, and state colour only where a state needs naming. Density is set by the work. Seven resource badges per profile, a 13 to 14px base and tabular figures let a user take in five profiles at once.

Every change is shown before it happens and reported after it happens. The panel lists each resource that would change, Apply runs it, and the same list comes back as results with green checks. That reveal is the only authored motion in the system. Everything else is plain state transitions.

It is a local, offline tool, so it uses the system sans and system monospace and loads no web fonts. Light and dark are both first-class. Dark is near-black zinc, not an inverted afterthought.

**Key Characteristics:**
- Neutral surfaces in three tonal steps, hairline borders, near-flat elevation.
- One blue for primary actions and every kind of selection.
- Semantic state colour: blue shared, amber private, dashed grey missing, red foreign or destructive, green only for "Logged in" and success.
- System sans for UI, ui-monospace only for paths and resource names in change lines.
- Preview, then apply, then a per-resource result, with one staggered reveal on the result.

## Colors

The palette is a cool zinc neutral range with a single saturated blue. Amber, red and green are kept for state.

### Primary
- **Action Blue** (`primary`; dark `dark-primary`): primary buttons (Add profile, Apply, Fix), the pressed segment of a target segmented control, checked choice cards, change arrows in previews, focus rings, links and text selection (28% mix). Hover deepens to `primary-hover` in both modes. Dark mode keeps the same #2563eb so white button text stays at 5.2:1; only the focus ring lightens (`dark-focus`).
- **Selection Tint** (`shared-bg` / `shared-fg`): the soft blue used for the current nav item, the pressed theme switch, the pressed state of a non-target segment and the Endpoint pill. Selection and "shared" use the same blue, so both read as "connected".

### Secondary (state)
- **Shared Blue** (`shared-bg`, `shared-fg`, `shared-bd`): a resource linked into the pool at `~/.claude`. Badge with a link icon.
- **Private Amber** (`private-bg`, `private-fg`, `private-bd`): a resource that is private or empty in this profile. Badge with a lock icon.
- **Missing Grey** (`missing-fg`, `missing-bd`): an absent resource. Transparent fill, dashed border, minus icon.
- **Foreign Red** (`foreign-bg`, `foreign-fg`, `foreign-bd`): a link that points outside the pool. Badge with an alert icon. The same border tone frames the danger box and the hover state of destructive buttons.
- **Success Green** (`ok`, `ok-bg`): the "Logged in" pill, result checks, a finished plan header and OK doctor status. Nothing else.
- **Warning Amber** (`warn`, `warn-bg`): doctor warnings, warn lines and the warn count in nav.
- **Error Red** (`err`, `err-fg`, `err-bg`): errors, failed plans, invalid inputs, the error banner and the solid confirm-remove button.

### Neutral
- **Canvas** (`bg`): the page behind the content and the translucent sticky header.
- **Surface** (`surface`): sidebar, cards, tables, panel and buttons.
- **Recess** (`surface-2`): hover fills, table headers, plan bodies, the segmented-control track, chips and neutral pills.
- **Deep Recess** (`surface-3`): the third tonal step, held in reserve.
- **Hairline** (`border`) and **Firm Hairline** (`border-strong`): structure borders, and the edges of controls (buttons, inputs, segmented controls, dashed empty states).
- **Ink** (`text`), **Secondary Ink** (`text-2`), **Tertiary Ink** (`text-3`): primary text, metadata and descriptions, then labels, counts, hints and unchanged lines.

### Named Rules
**The One Blue Rule.** Blue means action or selection. Nav current, pressed segments, the theme switch, checked choices and focus are all blue. No other hue marks selection.

**The Meaning-Only Colour Rule.** Green appears only for "Logged in" and successful results. Red appears only for destructive confirmations, foreign links and errors. A resting control is never tinted to decorate it.

## Typography

**Body Font:** system sans (`-apple-system`, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Helvetica Neue, Arial)
**Mono Font:** ui-monospace (SF Mono, Menlo, Consolas)

**Character:** The native UI face of each platform, set slightly heavy (550 and 650 on variable system fonts) and tightened by -0.01em on headings. The result is crisp and familiar with no added personality. Tabular figures are on everywhere.

### Hierarchy
- **Headline** (650, 20px): the view title in the sticky header. The panel title uses 17px and empty-state headings use 16px.
- **Title** (650, 15px): profile card names and the wordmark.
- **Section** (600, 13 to 13.5px): panel section headings, plan headers and doctor group headings.
- **Body** (400, 14px/1.5): the base. Metadata and descriptions use 13px. Prose stays within 60ch.
- **Control** (550, 13px): buttons, field labels and segmented controls (12.5px).
- **Label** (500, 12px): badges, pills, table headers, group labels, counts and hints (12 to 12.5px).
- **Mono** (12.5px): resource names in preview and result lines, paths such as the pool path, and inline `code`.

### Named Rules
**The Mono-Means-Disk Rule.** Monospace marks literal filesystem names: paths, `code`, and resource names in change lines. UI copy never uses it.

**The No Web Fonts Rule.** The tool runs locally and offline, so it uses only system faces. No font files and no font network requests.

## Layout

The shell is a two-column grid: a 240px sticky sidebar (wordmark, Profiles, Shared pool, Doctor and Activity with right-aligned counts, then the pool path and theme switch pinned to the bottom) and a flexible main column. The main column starts with a 60px sticky header containing the title, the "Read from disk" sync note, a reload icon button and the view's primary action. The header is translucent (88% canvas with an 8px backdrop blur) and has a hairline bottom border. Content is padded 24px 32px 64px and capped at 1280px.

Profile cards fill an auto-fill grid with a 320px minimum and a 16px gap. Inside a card, rows are 14px apart, resource groups sit in a 64px label column next to wrapping badges with a 6px gap, and the actions sit under a hairline. Change lines use an 18px icon, 110px name, 1fr text grid. The right-hand panel is `min(480px, 100vw)` with 24px side padding and sections separated by hairlines.

Spacing follows a 4px rhythm (4, 8, 12, 16, 24, 32), with 6, 10 and 14px used for gaps inside components. At 860px and below the sidebar becomes a wrapping top bar: the nav scrolls horizontally, the pool path is hidden, the theme switch moves right and page padding drops to 16px.

## Elevation & Depth

The system is nearly flat. Depth comes from the three tonal neutrals and hairline borders. Shadows are used in three places: a 1px lift on resting controls and cards, a soft edge shadow on the slide-over panel, and a floating toast.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px rgba(9,9,11,0.05)`; dark `rgba(0,0,0,0.4)`): buttons, cards, the pressed segment.
- **Panel** (`box-shadow: -12px 0 32px rgba(9,9,11,0.12), -1px 0 0 var(--border)`; dark 0.5 alpha): the right-hand dialog only, over a 32% (dark 55%) zinc scrim.
- **Toast** (`--shadow-toast`: `0 8px 24px rgba(9, 9, 11, 0.2)`): the inverted toast at the bottom centre.

### Named Rules
**The Hairline-First Rule.** Separate things with a 1px border or a tonal step before reaching for a shadow. Only the panel and the toast float.

## Shapes

Corners are softly rounded and get larger as the container gets larger: 5px on inner segments and theme buttons, 6px on buttons, inputs, badges and nav items, 8px on segmented tracks, the theme switch, plans, choice cards, the danger box, banners and toasts,, 10px on cards, tables, activity entries and empty states, and 3px on the 10px legend swatches. Pills and chips are fully round (999px). Borders are 1px throughout. Dashed borders always mean absence or "nothing here yet": missing badges, empty states, the plan hint and dividers between sharing rows. Icons are 16px stroked line glyphs (1.75 stroke, round caps), shrunk to 12px at stroke 2 inside badges.

## Components

### Buttons
Restrained and solid. Every button is 32px tall.
- **Shape:** gently rounded (6px), 1px firm hairline border, rest shadow.
- **Default:** surface fill, ink text, 0 12px padding, 13px/550, optional 16px leading icon with a 6px gap. Hover fills to Recess. Transitions are 120ms on background, border and colour.
- **Primary:** Action Blue fill and border, white text. Used for one primary action per context (Add profile in the header, Apply, Fix).
- **Ghost / Icon:** transparent with no border or shadow, secondary ink. Icon buttons are 32px square (reload, close panel).
- **Quiet destructive (card Remove):** looks like a default button at rest and tints to `err-bg` with `err-fg` text and a `foreign-bd` border on hover.
- **Danger:** red text, and a red tint on hover, inside the panel's danger box. **Danger solid** (red fill, white text) is used only for the final confirm after the profile name has been typed.
- **Disabled:** 50% opacity, not-allowed cursor. Busy buttons show a spinning loader icon.

### Badges (resource state)
The core signature. A 24px rounded rectangle (6px radius) with a 1px border, a 12px state icon and the resource label at 12px/500. The variants are shared (blue, link icon), private and empty (amber, lock icon), missing (transparent, dashed grey, minus icon) and foreign-link (red, alert icon). State is also written into screen-reader text and the title attribute. After a change, the affected badges pulse once with a 4px Action Blue ring that fades out over 1.6s.

### Pills and Chips
- **Login pill:** fully round, 2px 8px, 12px/550, with a 6px current-colour dot. Neutral for "Not logged in", Success Green for "Logged in", Selection Tint for "Endpoint".
- **Chip:** fully round, Recess fill, hairline border, 12px. Used in the pool and doctor tables.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** Surface on Canvas.
- **Shadow Strategy:** Rest shadow only.
- **Border:** 1px hairline. The actions row is set apart by a hairline top border.
- **Internal Padding:** 16px. Tables use 10px 16px headers on Recess and 12px 16px cells.

### Inputs / Fields
- **Style:** 34px tall, 0 10px padding, 6px radius, firm hairline border, Surface fill. Labels are 13px/550 and help text is 12.5px tertiary ink.
- **Focus:** 2px focus outline with no offset, and the border turns to focus blue.
- **Error:** `err` border plus a 12.5px `err-fg` message.
- **Choice cards:** two-column radio cards (8px radius) whose checked state is a blue border plus a 1px blue ring. Checkboxes use the primary accent colour.

### Navigation
Sidebar links are 7px 8px with a 6px radius, a 16px icon, 500 weight and secondary ink. Hover fills to Recess. The current page uses the Selection Tint. Counts sit right-aligned at 12px and switch to `warn` or `err` when doctor reports issues. The theme switch is a bordered three-option segmented control (System / Light / Dark) whose pressed option uses the Selection Tint.

### Segmented control
A Recess track with a firm border, 7px radius and 2px padding. Segments are 4px 10px, 12.5px/550. A pressed segment is lifted onto Surface with blue text and the rest shadow. When it is the pending target of a change, it is filled Action Blue. "Now: shared" is shown below in tertiary ink.

### Plan (preview and result)
A signature component. An 8px bordered block on Recess with a section-weight header (an info icon and the action name, plus a right-aligned tag such as "nothing changed yet"), then a list of change lines, then a sticky footer on Surface with a change count, Cancel, and Apply. Preview lines show a blue arrow, the mono resource name and a plain description. Unchanged lines are tertiary with a minus icon, and warn and error lines take their state colour. After Apply, the same block becomes the result. The header turns green, change lines get green checks, and the lines rise into place (4px, 420ms, `cubic-bezier(0.16, 1, 0.3, 1)`, 70ms stagger). A failed plan turns the header red.

### Panel, Toast, Banner
- **Panel:** a right-hand dialog that slides in over 320ms on the same ease. The header is 20px 24px 16px with a 17px title and a close icon button.
- **Toast:** inverted (ink fill, canvas text), 8px radius, bottom centre. It rises 16px as it fades in.
- **Banner:** an inline `err-bg` strip with an 8px radius for connection and server errors.

## Do's and Don'ts

### Do:
- **Do** use Action Blue for every primary action and every selected or pressed state, and for nothing decorative.
- **Do** colour a resource by state: blue shared, amber private or empty, dashed grey missing, red foreign-link. Always pair the colour with its icon and text.
- **Do** keep green for "Logged in" and successful results only.
- **Do** preview every change as per-resource lines before Apply, and then show the same lines as results.
- **Do** keep the staggered result rise as the only authored motion. Everything else is 120 to 320ms state transitions, and `prefers-reduced-motion` removes movement (panel slide, toast rise, result stagger, chevron turn) while keeping every state change visible: changed badges get a static blue ring instead of the pulse.
- **Do** set paths and resource names in change lines in ui-monospace at 12.5px.
- **Do** define every colour as a custom property on `:root` with a matching dark value, and use them in light, dark and system themes.

### Don't:
- **Don't** load web fonts or any network asset. The tool is local and offline.
- **Don't** tint resting destructive controls red. Card Remove stays neutral until hover, and the solid red button exists only behind the typed-name confirmation.
- **Don't** use green for "shared" or red for anything that isn't destructive, foreign or an error.
- **Don't** add stat cards, charts or a hero to the dashboard.
- **Don't** float surfaces other than the panel and the toast. Separate with hairlines and tonal steps.
