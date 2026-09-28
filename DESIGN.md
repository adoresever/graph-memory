---
name: Graph Memory
description: A verifiable research brief for bounded model context and durable recall.
colors:
  paper: "#f7f8fa"
  sheet: "#ffffff"
  ink: "#111827"
  muted: "#586174"
  line: "#cfd5df"
  ink-glass: "rgba(17,24,39,0.96)"
  dsh-blue: "#1748d1"
  dsh-blue-deep: "#0e399d"
  recall-cyan: "#16a6b6"
  evidence-coral: "#e16645"
  pass-green: "#167a58"
  caveat-amber: "#996318"
  trace-gray: "#a9b1bf"
  memory-surface: "#dff4f5"
  memory-ink: "#073c48"
  memory-border: "#8acbd1"
  table-header: "#edf0f5"
  blue-wash: "#edf3ff"
  code-surface: "#0d1421"
  code-border: "#273247"
  dark-text: "#f4f7ff"
  dark-muted: "#b8c2d4"
  dark-label: "#8f9bb0"
  footer-surface: "#eef1f5"
  chart-grid: "#e3e7ee"
  chart-axis: "#8993a4"
  chart-label: "#667085"
  query-sky: "#92bbff"
typography:
  display:
    fontFamily: "GitHub UI sans-serif"
    fontSize: "clamp(46px, 6.7vw, 92px)"
    fontWeight: 700
    lineHeight: 0.99
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "GitHub UI sans-serif"
    fontSize: "clamp(34px, 4.8vw, 64px)"
    fontWeight: 700
    lineHeight: 1.06
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Source Han Sans SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "Source Han Sans SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  body-large:
    fontFamily: "Source Han Sans SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(17px, 1.55vw, 22px)"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Source Han Sans SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1
  mono-label:
    fontFamily: "IBM Plex Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.03em"
  mono-data:
    fontFamily: "IBM Plex Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  none: "0px"
spacing:
  micro: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "22px"
  xl: "28px"
  section: "clamp(74px, 9vw, 124px)"
  page-gutter: "max(24px, calc((100vw - 1240px) / 2))"
components:
  button-primary:
    backgroundColor: "{colors.dsh-blue}"
    textColor: "{colors.sheet}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 17px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 17px"
    height: "44px"
  topbar:
    backgroundColor: "{colors.ink-glass}"
    textColor: "{colors.sheet}"
    typography: "{typography.mono-label}"
    rounded: "{rounded.none}"
    height: "54px"
    padding: "0 max(24px, calc((100vw - 1240px) / 2))"
  evidence-figure:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0"
  memory-callout:
    backgroundColor: "{colors.memory-surface}"
    textColor: "{colors.memory-ink}"
    rounded: "{rounded.none}"
    padding: "13px"
  metric-result:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.none}"
    padding: "17px 18px"
    width: "190px"
  data-table-header:
    backgroundColor: "{colors.table-header}"
    textColor: "{colors.muted}"
    typography: "{typography.mono-label}"
    rounded: "{rounded.none}"
    padding: "15px 16px"
  code-block:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.none}"
    padding: "21px 23px"
---

# Design System: Graph Memory

## Overview

**Creative North Star: "可验证的研究简报 / The Verifiable Research Brief"**

Graph Memory presents itself like a research-paper white brief prepared for a newsroom and checked like a conference figure. The page is calm, exact, and evidence-led: a light paper field carries dark ink rules, a restrained blue identity, tabular numbers, annotated curves, and operational copy. The visual system makes the proof legible before it makes the product feel polished.

The composition is intentionally editorial rather than dashboard-like. DeepSeek Harness is the primary host and receives the strongest logo and color presence; OpenClaw appears as the compatible secondary path using the existing wordmark. Depth comes from tonal fields, rules, and one purposeful result lift. Square geometry, generous section breathing room, and instrument-like monospace labels keep every claim addressable on desktop and mobile.

**Key Characteristics:**

- Research-paper white canvas with sheet-white evidence surfaces.
- DSH blue as the scarce action and primary-series accent; coral marks the baseline.
- Ink rules, compact metadata, and tabular figures create a newsroom data-graphic cadence.
- Serif thesis headlines, sans-serif explanation, and monospace measurements divide evidence from interpretation.
- Flat-by-default surfaces with one restrained metric-result shadow; no card dashboard.

## Colors

The palette is a cool paper-and-ink neutral system with one authoritative DSH blue, a coral comparison series, cyan recall proof, and restrained status colors. Color is semantic: it identifies a host, a measured series, a memory hit, or a caveat.

### Primary

- **DSH Blue** (`#1748d1`): Primary action, selected state, Graph Memory series, key annotations, and the visual authority of DeepSeek Harness.
- **DSH Deep Blue** (`#0e399d`): Darker text treatment for the highlighted DeepSeek Harness column when blue must remain legible on a pale wash.

### Secondary

- **Evidence Coral** (`#e16645`): Baseline series, warning boundary, and the visual counterpoint that makes the measured delta readable.
- **Recall Cyan** (`#16a6b6`): Focus ring and recall affordance; use as a precise signal rather than a decorative accent.

### Tertiary

- **Pass Green** (`#167a58`): Passing benchmark outcomes and positive deltas.
- **Caveat Amber** (`#996318`): Known limits, warnings, and non-universal claims.
- **Query Sky** (`#92bbff`): The small query badge inside the dark architecture field.

### Neutral

- **Research Paper** (`#f7f8fa`): Page-level canvas.
- **Evidence Sheet** (`#ffffff`): Figures, tables, and high-contrast reading surfaces.
- **Ink** (`#111827`): Primary text, rules, dark sections, and metric-result fields.
- **Muted Ink** (`#586174`): Supporting copy, metadata, captions, and secondary navigation.
- **Hairline** (`#cfd5df`): Dividers and structural borders.
- **Trace Gray** (`#a9b1bf`): Low-priority context trace bars.
- **Recall Wash** (`#dff4f5`): Recalled-memory callout background.
- **Recall Ink** (`#073c48`): Text inside the recall callout.
- **Table Header** (`#edf0f5`): Neutral table-heading wash.
- **Blue Wash** (`#edf3ff`): Selected host column and mobile chart-scroll notice.
- **Code Surface** (`#0d1421`): Installation and reproduction command blocks.
- **Code Border** (`#273247`): Code-block boundary.
- **Dark Text** (`#f4f7ff`): High-contrast text on ink sections.
- **Dark Muted** (`#b8c2d4`): Supporting copy on ink sections.
- **Dark Label** (`#8f9bb0`): Field names and low-emphasis labels on ink sections.
- **Footer Surface** (`#eef1f5`): Closing provenance band.
- **Chart Grid** (`#e3e7ee`), **Chart Axis** (`#8993a4`), and **Chart Label** (`#667085`): Quiet chart scaffolding that never competes with the two data series.

### Named Rules

**The Measured Accent Rule.** DSH blue carries action, selection, and Graph Memory evidence; coral, cyan, green, and amber each have a named proof role. Do not spend the primary accent as a general decoration.

## Typography

**Display Font:** GitHub's native UI sans-serif
**Body Font:** Source Han Sans SC (with Noto Sans CJK SC, Microsoft YaHei, sans-serif fallbacks)
**Label/Mono Font:** IBM Plex Mono (with SFMono-Regular, Consolas, monospace fallbacks)

**Character:** The locally bundled Chinese serif gives thesis statements and section headlines the authority of a printed brief. Sans-serif carries explanatory reading, while IBM Plex Mono turns measurements, commands, labels, and provenance into instrument readouts.

### Hierarchy

- **Display** (700, `clamp(46px, 6.7vw, 92px)`, `0.99` line-height, `-0.035em` tracking): Hero thesis; use for the first-view claim and never for utility text.
- **Headline** (700, `clamp(34px, 4.8vw, 64px)`, `1.06` line-height, `-0.025em` tracking): Section theses and decisive editorial statements.
- **Title** (700, `19px`, `1.35` line-height): Figure titles and compact evidence headings.
- **Body** (400, `16px`, `1.7` line-height): Explanatory copy, tables, and narrative detail; keep reading measure bounded by the established content columns.
- **Body large** (400, `clamp(17px, 1.55vw, 22px)`, `1.65` line-height): Hero lede and high-level section introductions.
- **Label** (700, `13px`, `1` line-height): Rectangular actions and compact interaction labels.
- **Mono label / data** (700 at `11px` with `0.03em` tracking / 400 at `12px`): Host metadata, chart axes, status values, commands, and numeric evidence.

### Named Rules

**The Instrumented Type Rule.** Serif states the thesis, sans explains it, and mono proves or operates it. Keep the three voices distinct; do not use display serif for metrics or monospace for long-form reading.

## Layout

The page is a centered editorial field: the primary wrapper is `min(1180px, calc(100% - 48px))`, with a `max(24px, calc((100vw - 1240px) / 2))` topbar gutter. Sections breathe with `clamp(74px, 9vw, 124px)` block padding and are separated by one-pixel rules. The sticky topbar is `54px` tall and keeps a compact mono wordmark plus sparse anchor navigation in view.

The hero is a two-column balance of thesis and model-facing surface (`1.05fr / .95fr`) with a fluid gap of `clamp(42px, 7vw, 108px)` and a minimum first-view height of `calc(100vh - 54px)`. Section heads pair a short serif thesis with a wider explanatory column (`.72fr / 1.28fr`, `50px` gap). Evidence uses three-column architecture and ledger grids, while the host comparison and 20-turn data table keep their ruled, horizontal reading structure.

At `930px`, the hero and multi-column evidence grids collapse to a single reading column. At `620px`, the page gutter becomes `14px` per side, hero type steps down to `40px`, the DSH lockup becomes `170px`, and the 20-turn chart preserves a `690px` internal width inside an explicitly scrollable shell. Mobile navigation retains the last anchor and hides earlier anchors; table overflow is horizontal rather than compressed into unreadable cells.

## Elevation & Depth

This is a flat-by-default system. Depth is communicated by paper versus sheet versus ink fields, 1px and 2px rules, and deliberate tonal shifts rather than a stack of floating cards. The single raised element is the hero metric result, which uses an ambient shadow to make the measured `171 → 24` reduction feel like a physical annotation. The sticky topbar uses a dark translucent surface and `14px` backdrop blur to stay legible over the paper field.

### Shadow Vocabulary

- **Metric annotation lift** (`10px 14px 28px rgba(17,24,39,0.18)`): Only for the hero result badge; it is a proof callout, not a generic card treatment.
- **Translucent reading rail** (`rgba(17,24,39,0.96)` with `14px` backdrop blur): Sticky navigation remains structurally attached to the page while separating itself from scrolling content.

### Named Rules

**The Flat Figure Rule.** Surfaces stay flat at rest. Use rules and tonal fields for hierarchy; reserve the one soft shadow for an explicit measured-result annotation.

## Shapes

The silhouette is deliberately square: the only radius token is `0px`. Buttons, figures, tables, code blocks, callouts, and the metric result all use rectangular edges, with hierarchy carried by borders and color fields instead of pills or rounded cards. Structural anchors are typically a `2px` dark top rule plus a `1px` lower or internal divider; pale surfaces may use a `1px` border when a callout needs containment.

Clipping is functional. Charts hide overflow on desktop and become a keyboard-focusable horizontal scroll shell on small screens; data tables preserve their minimum measure and scroll rather than collapsing columns. Avoid decorative clipping, rounded masks, or ornamental geometry that would weaken the field-manual character.

## Components

Components are editorial instruments: each one exposes a claim, comparison, or operational state with a stable rectangular silhouette.

### Buttons

- **Shape:** Square, one-pixel border, no pill (`0px` radius).
- **Primary:** DSH Blue field with white label, `44px` minimum height, `0 17px` horizontal padding; use for the principal installation or reproduction action.
- **Hover / Focus:** Keep the blue role stable on hover; every link/button receives the Recall Cyan `3px` focus outline with `3px` offset. The mobile minimum height is `40px`.
- **Secondary:** Transparent paper field with Ink text and Ink border; use for a peer action such as opening evidence.

### Cards / Containers

- **Corner Style:** Square throughout.
- **Background:** Evidence figures and tables sit on Evidence Sheet; dark architecture and fact proof sit on Ink; installation uses DSH Blue with a Code Surface block.
- **Shadow Strategy:** Follow the Flat Figure Rule; only the hero metric result is lifted.
- **Border:** 2px dark top rules establish figures and ledgers; 1px Hairline dividers structure rows and metadata.
- **Internal Padding:** Figure headers use `23px 28px 18px`, chart shells `22px 22px 4px`, callouts `13px`, and ledger/table rows use the `16px` rhythm.

### Inputs / Fields

- **Style:** The turn scrubber is a native range input, `160px` wide on desktop and full-width on mobile, with DSH Blue as its accent.
- **Focus:** Recall Cyan `3px` outline with `3px` offset; the surrounding chart shell is keyboard focusable and explicitly announces horizontal scrolling on mobile.
- **Error / Disabled:** No bespoke disabled skin is present. Preserve the evidence-first hierarchy and label states in text when a control cannot be used.

### Navigation

- **Style:** A sticky `54px` ink rail with a mono Graph Memory runtime label, sparse `22px` nav gaps, and pale links.
- **Default / Hover / Active:** Links are muted light blue at rest and white on hover; anchor destinations are evidence, memory, and reproduction rather than generic product sections.
- **Mobile:** Keep the final navigation anchor visible and hide earlier anchors to protect the single-column reading width.

### Evidence Figure

The signature component is a ruled, annotated data figure rather than a dashboard card: a figure header names the measurement, a two-series SVG chart carries the comparison, a legend names the colors, a scrubber reveals a turn, and a caption states the metric boundary. The baseline is Coral, Graph Memory is DSH Blue, and annotations explain the first archive and T20 endpoint. Pair the chart with a result strip and an honesty note so measured context savings are not confused with all-request cost.

### Model Surface / Memory Proof

The hero model surface uses a three-part plate: a low-priority trace of the old context, a vertical DSH Blue compression axis, and a white recent-Q/A plus recalled-memory surface. The dark architecture field then expands the same grammar into three planes—model surface, recall bridge, durable memory—while the fact sheet uses ruled rows and mono values to make cross-session provenance inspectable.

## Do's and Don'ts

Concrete guardrails keep the page inside the verifiable-brief world.

### Do:

- **Do** make DeepSeek Harness the primary host in logo scale, copy order, and blue emphasis; show OpenClaw as the compatible secondary path with its existing wordmark.
- **Do** lead with a claim, then expose the measurement, method boundary, caveat, and reproduction path in that order.
- **Do** use DSH Blue for primary action and Graph Memory evidence, Coral for the baseline, Cyan for recall/focus, Green for passes, and Amber for caveats.
- **Do** preserve tabular numerals, ruled figures, square geometry, and the serif/sans/mono role split.
- **Do** pair color with labels, annotations, rules, or text so chart meaning and status never depend on color alone.
- **Do** honor `prefers-reduced-motion`; the chart draw animation must resolve to a static line when reduced motion is requested.

### Don't:

- **Don't** turn the report into a rounded-card dashboard, decorative graph gallery, or generic SaaS landing page.
- **Don't** introduce substitute host logos, a competing secondary brand, or a second visual identity beside DeepSeek Harness.
- **Don't** use blue as an ambient wash everywhere; its scarcity is what makes the evidence and action hierarchy trustworthy.
- **Don't** hide uncertainty: distinguish measured results from extrapolation, tool-path variance, maintenance cost, and known retrieval limits.
- **Don't** compress mobile evidence into unreadable tables or charts; preserve scrollable measure and explicit interaction guidance.
- **Don't** use display serif for numeric readouts or monospace for paragraphs; each typographic voice has one job.
