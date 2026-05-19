# GhostHub Design Language

Design system and brand guidance for future GhostHub work.

This document is meant to keep GhostHub visually and behaviorally coherent as the product evolves. It is intentionally tied to the current implementation: shared shell, theme tokens, layout personalities, glass surfaces, accent-driven interactions, and Pi-aware performance constraints.

Related docs:
- [Architecture](./ARCHITECTURE.md)
- token source of truth: `static/css/base.css`
- shell structure: `templates/index.html`
- runtime theme behavior: `static/js/utils/themeManager.js`
- custom theme editing: `static/js/modules/config/themeBuilder.js`

---

## 1. Brand Core

### 1.1 Product feeling

GhostHub should feel like:

- cinematic, not clinical
- tactile, not flat
- confident, not loud
- fast on limited hardware, not over-designed

Short version:

> Dark immersive surfaces, sharp hierarchy, and clear control over a personal library.

### 1.2 Brand traits

When making design decisions, favor:

- immersion
- clarity
- control
- atmosphere
- restraint

Avoid:

- generic dashboard blandness
- playful consumer-app whimsy
- sterile enterprise UI
- random one-off stylistic experiments
- bright flat backgrounds that break the product mood

---

## 2. Visual North Star

### 2.1 Base look

The default GhostHub look is:

- dark-first
- layered
- accent-lit
- glass-tinted
- gradient-backed

The app should read as a stack of surfaces, not a flat page.

Primary visual ingredients already established in code:

- deep background fields
- translucent glass surfaces
- subtle blur and saturation
- soft borders
- rounded corners
- vivid accent highlights
- cinematic gradients in headers, hero blocks, and important CTAs

### 2.2 Color behavior

GhostHub is token-based, not color-literal.

The core visual roles are:

- `primary`
- `accent`
- `background`
- `surface`
- `text`

Derived component tokens, such as secondary buttons, cards, modal glass, borders, and muted text, should come from those five roles. Do not add another user-facing color field for a component role unless it carries enough distinct meaning to justify the extra theme burden.

Rules:

1. Use tokens, not hardcoded hex values, for product UI.
2. Accent color is for action, focus, and state emphasis, not for painting the whole screen.
3. Backgrounds should stay deep and immersive even when theme hues change.
4. Surfaces should remain distinct from the page background.
5. Borders should be soft and supporting, not heavy separators.

### 2.3 Theming philosophy

Themes may change hue, but they should not change the product's character.

Across built-in and custom themes, preserve:

- dark immersive background weight
- readable contrast
- layered surface depth
- accent-led interaction hierarchy
- consistent spacing and shape language

Custom themes are allowed to personalize the product. They are not allowed to collapse the design system.

---

## 3. Layout Personalities

GhostHub has two first-class layout personalities. They should feel related, not duplicated.

### 3.1 Streaming layout

Use when the experience should feel:

- cinematic
- content-forward
- browse-heavy
- lean-back

Visual cues:

- hero moment
- horizontal rows
- bold artwork
- strong gradient framing
- more dramatic depth

Streaming should feel like entering a viewing environment.

### 3.2 Gallery layout

Use when the experience should feel:

- archival
- navigable
- time-oriented
- exploratory

Visual cues:

- date-grouped structure
- timeline/sidebar navigation
- denser media grids
- clearer utility controls
- calmer rhythm than streaming

Gallery should feel like a curated memory browser, not a spreadsheet.

### 3.3 Shared identity

No matter the layout, users should still recognize:

- the same header shell
- the same viewer language
- the same buttons, pills, modals, and overlays
- the same motion character
- the same brand intensity

---

## 4. Shell Rules

### 4.1 Header

The header is the product anchor. Treat it as a stable command bar.

It should always feel:

- compact
- premium
- centered around the brand mark
- balanced between identity and control

Rules:

- keep the logo/title grouping clean and compact
- avoid stuffing the header with long labels
- action buttons should remain icon-first or short-label
- the sync button is the only deliberately labeled control in the current shell and should stay special

### 4.2 Search, chat, and viewer overlays

Overlay surfaces should feel like a deeper layer of the same product, not like separate apps.

Rules:

- use glass surfaces for overlays
- preserve strong contrast with the background
- use blur sparingly but consistently
- keep overlay depth stronger than base cards
- preserve one clear focal action at a time

### 4.3 Modals and admin surfaces

Admin/config surfaces should still feel like GhostHub, even when they are utility-heavy.

Rules:

- utility does not mean flat or default-styled
- cards and sections should use the shared surface language
- large utility panels should still respect spacing, hierarchy, and accent rules
- destructive actions should stand out clearly but not dominate the screen

---

## 5. Component Language

### 5.1 Buttons

Button hierarchy:

- primary: gradient/accent-led, high intent
- secondary: glass/surface-backed, standard action
- ghost/icon: low emphasis, shell support action
- danger/warning: tinted by semantic state, never confused with primary

Rules:

- reserve primary buttons for the main action in a given scope
- avoid multiple competing primary buttons in the same visual block
- icon buttons should remain compact and readable
- button radius should match the rest of the surface system

### 5.2 Pills and filters

Pills are part of GhostHub's identity. They should feel fast, light, and crisp.

Rules:

- keep them compact
- use them for filtering, breadcrumbs, and state chips
- active pills should feel unmistakably selected
- do not turn pills into oversized buttons unless the screen specifically needs that emphasis

### 5.3 Cards

Cards are structural surfaces, not decorative boxes.

Rules:

- use cards to group meaningful content or controls
- keep borders subtle
- rely on surface contrast and spacing more than thick outlines
- hover/focus states should reinforce elevation, not just color change

### 5.4 Media tiles

Media should remain the hero wherever media is the point.

Rules:

- protect artwork and thumbnail prominence
- overlays should not drown the asset
- metadata should be concise and layered below the main visual
- progress indicators should be clean and obvious

---

## 6. Typography and Copy Tone

### 6.1 Typography

Current implementation uses `Inter` with system sans fallbacks. Keep that unless there is a deliberate system-wide typography redesign.

Use mono only for:

- diagnostics
- code-like values
- technical logs or identifiers

Typography goals:

- clear hierarchy
- strong readability on dark surfaces
- compact but not cramped metadata
- enough weight contrast to feel premium

### 6.2 Copy tone

GhostHub copy should feel:

- direct
- calm
- capable
- human

Avoid:

- overly cute microcopy
- vague system messaging
- aggressive warning language when a calm warning is enough

Good copy traits:

- says what happened
- says what the user can do next
- uses short labels for frequent controls

---

## 7. Motion and Interaction

### 7.1 Motion character

GhostHub motion should feel:

- smooth
- slightly weighted
- deliberate

Not:

- springy toy-like motion
- long ornamental animation
- twitchy micro-interactions everywhere

Current motion direction already established:

- shared easing token `--gh-motion-emphasis`
- fade-up and scale-in transitions
- view transitions between layouts
- low-memory and reduced-motion fallbacks

### 7.2 Motion rules

1. Motion should clarify state change, not distract from it.
2. Use stagger and reveal for content entry, not for every interaction.
3. Critical actions should feel immediate.
4. Reduced motion must remain fully usable and visually coherent.
5. On low-memory hardware, simplify rather than degrade awkwardly.

### 7.3 Interaction principles

Controls should feel:

- responsive
- obvious
- thumb-friendly on mobile
- keyboard-respectful on desktop

Patterns to preserve:

- visible focus treatment
- compact but safe touch targets
- immediate hover/press feedback
- overlay layers that clearly separate browsing from immersion

---

## 8. Accessibility and Hardware Discipline

### 8.1 Accessibility baseline

Always preserve:

- readable contrast
- visible focus states
- keyboard access for controls and dialogs
- motion reduction support
- touch targets that hold up on mobile

### 8.2 Pi-aware design rules

GhostHub's design system must respect Raspberry Pi constraints.

That means:

- do not stack blur, shadow, gradient, and animation effects everywhere
- use expensive effects on high-value surfaces only
- favor lazy rendering and progressive enhancement
- treat responsiveness as part of the design language, not a separate engineering concern

If a visual decision makes the app feel slower on LITE tier hardware, it is off-brand.

---

## 9. Implementation Rules

### 9.1 Styling rules

When adding or updating UI:

1. Start with existing tokens in `static/css/base.css`.
2. Reuse established component classes before inventing new styling primitives.
3. Extend the current shell instead of introducing a parallel aesthetic.
4. Keep new colors theme-aware.
5. Prefer gradients, glass, and layered depth over flat slabs, but only where they add value.

### 9.2 Theme-safe rules

Any new component must work across:

- `dark`
- `midnight`
- `nord`
- `monokai`
- `dracula`
- custom themes from the theme builder

Do not hardcode assumptions that only work in the default theme.

### 9.3 Layout-safe rules

Any new major feature should be checked in:

- streaming layout
- gallery layout
- mobile viewport
- reduced-motion mode

If a feature only works beautifully in one layout, it is incomplete.

### 9.4 State and UX rules

UI should reflect the architecture:

- use app events/constants for shared UI state changes
- keep layout-specific behavior inside layout owners
- keep shell-wide behavior in shared modules
- do not duplicate the same UX behavior through multiple competing systems

---

## 10. Do and Do Not

### Do

- use dark layered surfaces with clear hierarchy
- let media content breathe
- keep primary actions obvious
- make utility surfaces feel intentional and premium
- preserve the distinction between shell, layout, and viewer
- keep the app feeling cohesive across themes

### Do not

- add flat white or light-gray panels that break immersion
- create one-off accent colors outside the token system
- overload screens with competing bright highlights
- make every element glossy or animated
- introduce generic admin-dashboard visuals into the main product shell
- sacrifice Pi responsiveness for decorative polish

---

## 11. Design Review Checklist

Use this before releasing UI changes.

1. Does this still look unmistakably like GhostHub?
2. Does it use existing tokens and surface language?
3. Is the hierarchy clear in both streaming and gallery contexts?
4. Does the primary action stand out without everything competing for attention?
5. Does it still work across built-in themes and custom themes?
6. Is the motion helpful and optional rather than mandatory?
7. Is it readable and operable on mobile?
8. Would this still feel performant on a 2 GB Pi and a low-memory phone?

---

## 12. Final Rule

GhostHub is not just "dark mode media software."

It is a unified, self-hosted media experience with:

- cinematic depth
- clean control surfaces
- strong but restrained accents
- layout-specific personality
- consistent shell behavior
- Pi-conscious execution

Any new UI work should strengthen that identity, not dilute it.
