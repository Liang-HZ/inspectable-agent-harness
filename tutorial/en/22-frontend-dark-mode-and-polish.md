# 22. Frontend Dark Mode And Polish

This chapter is different in kind from the previous ones — it doesn't
introduce a new runtime capability. Instead it goes back and polishes the
frontend pages that already existed (the Agent workbench, the Debug/Audit/
Session panels, Chat mode) into a consistent, usable state, and adds a
baseline capability that was entirely missing until now: dark mode.

After reading this chapter, you should understand:

- why a CSS file that "works" doesn't mean it's safe to add dark mode to
- the tradeoff between semantic CSS variables and deciding which colors are
  worth converting
- three categories of color declarations an automated script will miss, and
  why they're the most dangerous kind
- why this project follows the system color-scheme preference instead of
  building a manual toggle
- why polishing a frontend is better verified page-by-page in a real
  browser than by reading the diff

## Background

By chapter 21, the four deep backend gaps (shell, approval resume, session
resume, compaction) were all filled, each with its own tutorial chapter and
tests. On the frontend side, `app/globals.css` had accumulated since the
project's earliest days into a 2500+ line file containing the same
component styles redefined three times across different breakpoints, and
more than 150 distinct hex color values — many appearing only once, subtle
drift left over from different iterations rather than a clean design-token
system.

This project never had dark mode. Opening the page with the browser set to
`prefers-color-scheme: dark` showed the exact same light interface. For a
developer tool positioned against Codex and Claude Code, that's a visible
completeness gap.

## Design Choice

### Semantic variables, not a component-by-component rewrite

Rather than rewriting every component's styles, a set of semantic CSS
custom properties gets defined on `:root`:

```text
--page-bg / --surface / --surface-tint      background layers
--border / --border-strong                  borders
--text-strong / --text-primary /
--text-secondary / --text-muted             text layers
--accent / --accent-hover / --accent-text /
--accent-tint-bg / --accent-tint-border /
--accent-contrast                           the accent color and its variants
--danger / --warning / --success groups     status colors (each with text/border/bg)
```

`:root` holds the light-mode defaults; `@media (prefers-color-scheme: dark)
{ :root { ... } }` holds the matching dark values. That structure itself is
straightforward — the hard part isn't designing the variables, it's **safely
replacing the existing hardcoded color values with them without breaking
light mode**.

### Scripting the mechanical conversion of high-frequency colors

2500 lines and 150+ colors can't be manually cross-checked one by one. A
frequency count first revealed a very uneven distribution: `#ffffff` alone
appeared 45 times, the `#d8e1e4` family of border colors appeared 30+ times,
and a handful of core text colors each appeared 5-13 times — these
high-frequency colors form the page's skeleton. A Python script did an
exact string replacement of these colors (not fuzzy matching — a precise
one-to-one mapping from each specific hex value to its corresponding
variable), converting 165 occurrences in one pass.

This step was safe because:

- it only replaces values, never the declaration structure
- every replacement has an explicit semantic mapping (not a guess about
  whether a color should get lighter or darker)
- `npm run build` ran immediately afterward, letting Turbopack's CSS parser
  confirm the syntax survived intact

### Three categories of color declarations a script will miss

After the first conversion pass, rendering the page in a real browser under
`prefers-color-scheme: dark` revealed several headings had gone completely
invisible — white text sitting on a card background that never got dark.
Tracing each one down surfaced three patterns the script's logic missed.

**Multi-line `background` declarations.** For example:

```css
.conversationScroll {
  background:
    linear-gradient(
      180deg,
      rgba(255, 254, 250, 1),
      rgba(255, 254, 250, 0) 180px
    ),
    #fffefa;
  padding: 34px 44px;
}
```

The script scanned line by line, only looking for colors on lines
containing the literal word `background` — but this declaration spans six
lines, and the color values sit on lines without that word, so all of them
got skipped. The fix was to simplify this class of decorative gradient down
to a flat `var(--surface)` rather than trying to preserve the original
gradient structure.

**`rgba(...)` literals instead of hex.** Many of the "glossy" card headers
(`.conversationHeader`, `.inspectorHeader`) used a translucent white overlay
like `rgba(255, 254, 250, 0.96)` for their background, not `#fffefa`. The
script's regex only matched `#RRGGBB`, so it never touched these by
construction.

**A gradient layered on top of an already-converted flat color.**
`.focusReadyPanel` (the "AGENT READY" card) has a background of:

```css
background:
  linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(247, 249, 241, 0.9)),
  var(--surface);
```

The `var(--surface)` part correctly went dark, but a white gradient sits on
top of it, so visually the panel still read as light — which explains why
the browser showed "the background got slightly darker, but is still mostly
bright" instead of "nothing changed at all."

What all three have in common: none of them are a color that got converted
*wrong* — they're colors that never got converted *at all*, and every one
of them only became visible by **actually rendering the page in a
browser**. Reading the CSS source alone makes it easy to miss the combined
effect of a multi-line declaration or a layered gradient.

### The fix: one consolidated dark-mode override block

Rather than chasing every scattered `rgba` value and multi-line declaration
throughout the source file, one consolidated
`@media (prefers-color-scheme: dark)` block was appended at the end of the
file, listing every known problem selector and forcing it to a flat
variable-based background with `background-image: none`:

```css
@media (prefers-color-scheme: dark) {
  .conversationHeader,
  .inspectorHeader,
  .composerDock,
  .sidebarNotice,
  .conversationScroll {
    background: var(--surface);
    background-image: none;
  }

  .focusReadyPanel,
  .sidebarRunCard {
    background: var(--surface);
    background-image: none;
  }
  /* ... */
}
```

This block is deliberately placed **last** in the file — CSS rules of equal
specificity apply in source order, and this project's classes are
frequently redefined multiple times across different responsive breakpoint
blocks. Placing it last means there's no need to trace which definition
wins at a given viewport width; the new rule always wins.

This is a pragmatic choice: rather than precisely designing a dark version
of every gradient, dark mode simply drops the decorative glossy gradients
in favor of a flat background. Visually simpler, in exchange for
maintainability and determinism.

### Why there's no manual toggle

This project only responds to `prefers-color-scheme` — there's no
light/dark button. The reason is direct: adding a toggle means stuffing a
"read localStorage before paint to avoid a flash" script into
`layout.tsx`, wiring state and persistence into the component, and adding
UI for it — all new feature surface — while "follow the system setting"
already covers the core scenario users actually care about (the OS is set
to dark mode, so this tool should be dark too), at an order of magnitude
less implementation and maintenance cost. This matches the "not the
priority" framing: fill the missing capability (respecting the system
preference) first, and skip the nice-to-have (a manual switch) that isn't
required.

## Two Other Fixes

**Chat mode shouldn't show the "Sessions" sidebar.** The `SessionRail`
component displays the agent session list and a "continue this session"
entry point — concepts that only make sense in Agent mode. Chat mode (a
direct model call with no session store involved) showing it was purely
misleading. The fix is one line of conditional rendering:
`{state.mode === 'agent' ? <SessionRail ... /> : null}`.

**`color: var(--surface)` was misused as a high-contrast text color.** Five
places (`.primaryButton`, `.approveButton`, `.activeModeButton`, and others)
pair white text with a dark/accent-colored background, written as
`color: #ffffff`. Since the script converts by value, these `#ffffff`
occurrences shared the exact same value as "panel background" and got
converted to `var(--surface)` along with everything else. This is a
semantic collision, not a conversion mistake — `#ffffff` in these spots
actually means "this text needs to contrast against the button's
background," not "this is a panel." Once `--surface` goes dark, these
buttons' text would go dark right along with it, making the button text
disappear. The fix introduces a dedicated `--accent-contrast` variable
(white in light mode, near-black in dark mode) and changes those five
`color: var(--surface)` declarations to `color: var(--accent-contrast)`.

## Transcript Tool Display And Shimmer Indicators

A follow-up polish pass reworked how tool executions render in the
transcript, matching the collapsed format Codex and Claude Code use.

**Tool names went from raw identifiers to action phrases.** Each tool card
previously showed the raw tool name (`read`, `grep`, `shell`), which carries
no information for a reader. Now `toolActionLabel(toolName, argumentsJson)`
pulls the key argument into a human-readable action phrase:
`read {path:"lib/agent.ts"}` → "Read lib/agent.ts",
`shell {command:"git status"}` → "Ran git status",
`grep {pattern:"..."}` → "Searched for ...", falling back to a generic
phrase ("Ran a command") when there's no clean argument to extract. Labels
stay English, consistent with the reference screenshot and the whole app.

**A single tool shows directly; multiple tools collapse into a group.** If a
model output called just one tool, the summary shows that tool's action
phrase directly ("Ran git status ›") and expands straight to its
Input/Result. If it called several, the summary shows "Used N tools" and
expands to a nested `<details>` per tool (each an abbreviated action phrase),
which in turn expands to that tool's detail. This is exactly the three-level
"tools between two text outputs collapse into a group, expand to
abbreviations, expand each to detail" structure from the reference
screenshot.

**The "running" state uses gradient shimmer text.** A new `.shimmerText`
class applies a multi-color gradient (teal → cyan → a bright highlight)
clipped to the text (`background-clip: text` + `color: transparent`) and
animates only `background-position`, producing a colored band that
continuously sweeps across the glyphs in a loop. It's applied in three
places: the "Running" badges in the header and sidebar, and the "Thinking…"
indicator shown while waiting for model output in the transcript. The
shimmer colors are CSS variables too, using brighter cyans in dark mode. A
`prefers-reduced-motion: reduce` guard disables the animation for users who
ask the system to minimize motion.

## Page-By-Page Verification

Rather than trusting a code review to conclude "this should be fine now,"
every page was checked in a real browser (simulating the OS dark-mode
preference via `resize_window`'s `colorScheme` parameter):

```text
Agent workbench (composer + transcript + all three inspector tabs: Debug/Audit/Session)
Chat mode (message + result + inspector)
The approval card (rendered by temporarily injecting fake state, reverted afterward)
The compaction card (same technique)
The mobile narrow layout (390px width)
```

Every one was screenshotted to confirm text stayed legible, background
layering was correct, and status colors (danger red, warning amber, success
green) stayed clear against the dark background. This process directly
disproved the assumption that "once the script finishes, it should be
fine" — the very first browser screenshot after the mechanical conversion
immediately exposed the invisible-heading bug. Judging correctness from the
CSS source alone, on the theory that "the variables are all replaced so it
should be fine," would have let the multi-line-declaration and
layered-gradient bugs through completely unnoticed.

## What Is Still Missing

- **Roughly 145 low-frequency decorative colors remain hardcoded.** Mostly
  shadows (very-low-opacity drop shadows like `rgba(31, 48, 42, 0.08)`) and
  small decorative elements (status dots, secondary icons), which keep
  their original values in dark mode. These don't hurt legibility — dark
  mode's shadows and glows are just slightly less refined than light
  mode's.
- **No manual theme toggle**, for the reasons explained above.
- **The `.jsonBlock`/`.debugTextBlock` "terminal-style" dark code panels
  aren't adapted for dark mode.** They're designed as a dark
  background with pale-green text on purpose — a deliberately
  distinct "dark terminal" look inside a light page. On a dark page they
  blend in naturally and need no extra handling.
- **No automated contrast-ratio auditing tool integrated.** Every color
  pairing was confirmed by manual screenshot review, not an automated WCAG
  contrast check.

## Chapter Summary

This frontend-polish chapter introduced no new architectural decisions —
its core is a discipline problem. A large-scale color replacement looks
like fully automatable mechanical work, but the real risk lives outside the
automated script's assumed boundaries: multi-line declarations, rgba
literals, and the same color value reused for two different semantic
purposes. Tooling can finish 90% of the conversion, but the last 10% — also
the part most likely to produce a bug a user directly runs into, like
invisible text — has to be verified by looking at real, rendered pages, not
by trusting that the diff looks correct.

## Chapter Checkpoint

This chapter's capability is pure frontend, so verification is UI steps and
needs no key (opening pages needs no model; only running tasks does):

1. Start the dev server (`npx next dev -p 3102`) and open
   `http://localhost:3102` in a browser.
2. Toggle the system appearance: on macOS, System Settings → Appearance; or
   emulate it in browser DevTools — Chrome's Rendering panel can force
   `prefers-color-scheme` to `dark`. The page should switch wholesale
   without a reload.
3. In dark mode, focus on the spots this chapter fixed: page titles and card
   headers must stay readable (no "white text on a light background");
   primary buttons (Send, Approve) must keep text/background contrast; Chat
   mode must not show the Sessions rail.
4. Enable "reduce motion" in system settings (macOS: Accessibility →
   Display) and confirm the Running badge's shimmer stops — that is the
   `prefers-reduced-motion` guard working.

Expected outcome: in both appearances all text is readable, background
layers are distinct, and the danger/warning/success color trios stay
distinguishable. If some corner is still light — it is probably one of the
~145 low-frequency decorative colors declared in "What Is Not Done", a
stated boundary rather than a regression.
