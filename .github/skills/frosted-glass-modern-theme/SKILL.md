---
name: frosted-glass-modern-theme
description: Frosted glass (glassmorphism) and modern web theme guidance. Use when building translucent UI surfaces, glass cards/buttons/navbars/modals/sheets, modern aesthetic tokens (color, radius, shadow, motion), or when the user mentions "frosted glass", "glassmorphism", "modern theme", "soft UI", or "neumorphism-adjacent" design. Framework-agnostic; biased toward Tailwind CSS v4.
---

# Frosted Glass & Modern Theme

Apply a frosted glass (glassmorphism) aesthetic and modern theme system to web projects. Framework-agnostic; examples use Tailwind CSS v4.

## When to Use

Use this skill when:
- Building UI components that follow a frosted glass / glassmorphism aesthetic
- Creating glass cards, buttons, navbars, modals, sheets, or inputs
- Establishing a modern theme token system (color, elevation, radius, motion)
- The user mentions "frosted glass", "glassmorphism", "modern theme", "soft UI", or "translucent surfaces"

## Core Design Principles

### 1. Contextual Transparency
Elements are semi-transparent, revealing blurred content beneath. The material adapts to its background — never fully opaque, never fully transparent.

### 2. Floating Controls
UI elements appear to levitate above the content layer with subtle shadows and elevation. Hierarchy comes from depth, not heavy borders.

### 3. Harmonized Radii
All corners use consistent, generous border-radius. Prefer squircle-like curves (superellipse) over standard circles where the platform allows.

### 4. Edge-to-Edge Content
Content fills the viewport. Chrome (navbars, toolbars) is minimal and translucent, letting content breathe.

### 5. Subtle Specular Highlight
A soft rim light along the top edge suggests a light source without simulating physical refraction. This is the key differentiator from basic glassmorphism.

## Modern Theme Tokens (Tailwind v4 `@theme`)

```css
@theme {
  /* Glass backgrounds */
  --color-glass-light: rgba(255, 255, 255, 0.15);
  --color-glass-medium: rgba(255, 255, 255, 0.10);
  --color-glass-subtle: rgba(255, 255, 255, 0.08);
  --color-glass-strong: rgba(255, 255, 255, 0.25);
  --color-glass-dark: rgba(0, 0, 0, 0.15);

  /* Glass borders */
  --color-glass-border: rgba(255, 255, 255, 0.20);
  --color-glass-border-subtle: rgba(255, 255, 255, 0.10);
  --color-glass-border-strong: rgba(255, 255, 255, 0.30);

  /* Shadows */
  --shadow-glass: 0 8px 32px rgba(31, 38, 135, 0.15);
  --shadow-glass-lg: 0 8px 32px rgba(31, 38, 135, 0.20), inset 0 4px 20px rgba(255, 255, 255, 0.15);
  --shadow-glass-inset: inset 0 1px 0 rgba(255, 255, 255, 0.20);

  /* Radii — generous, harmonized values */
  --radius-glass-sm: 12px;
  --radius-glass: 16px;
  --radius-glass-lg: 24px;
  --radius-glass-xl: 32px;
  --radius-glass-pill: 9999px;

  /* Motion */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --duration-fast: 150ms;
  --duration-base: 300ms;
}
```

### Core Utility Classes

**Glass Surface (base pattern):**
```
backdrop-blur-lg bg-[rgba(255,255,255,0.15)] border border-white/20
shadow-[0_8px_32px_rgba(31,38,135,0.15)]
```

**Enhanced with saturation:**
```
backdrop-blur-lg backdrop-saturate-[180%] bg-[rgba(255,255,255,0.15)]
border border-white/20
```

### Component Patterns

#### Glass Card
```html
<div class="rounded-2xl bg-[rgba(255,255,255,0.15)] backdrop-blur-lg
  backdrop-saturate-[180%] border border-white/20
  shadow-[0_8px_32px_rgba(31,38,135,0.15)] p-6">
  <!-- Content -->
</div>
```

#### Glass Button — Primary
```html
<button class="px-5 py-2.5 rounded-2xl text-white font-medium
  bg-[rgba(255,255,255,0.15)] backdrop-blur-lg border border-white/15
  shadow-lg hover:-translate-y-0.5 active:scale-95
  transition-all duration-300">
  Label
</button>
```

#### Glass Button — Secondary
```html
<button class="px-5 py-2.5 rounded-2xl text-white/90 font-medium
  bg-[rgba(255,255,255,0.08)] backdrop-blur-lg border border-white/10
  shadow-md hover:-translate-y-0.5 active:scale-95
  transition-all duration-300">
  Label
</button>
```

#### Glass Button — Pill
```html
<button class="px-5 py-2.5 rounded-full text-sm font-medium text-white/90
  bg-[rgba(255,255,255,0.08)] backdrop-blur-lg border border-white/10
  shadow-md hover:-translate-y-0.5 active:scale-95
  transition-all duration-300">
  Label
</button>
```

#### Glass Button — FAB (Floating Action)
```html
<button class="w-12 h-12 rounded-full flex items-center justify-center
  text-white bg-[rgba(59,130,246,0.25)] backdrop-blur-lg
  border border-blue-400/20 shadow-lg hover:-translate-y-0.5
  active:scale-95 transition-all duration-300">
  <svg>...</svg>
</button>
```

#### Glass Navbar
```html
<nav class="fixed top-0 inset-x-0 z-50 h-16
  bg-[rgba(255,255,255,0.12)] backdrop-blur-xl backdrop-saturate-[180%]
  border-b border-white/10">
  <!-- Content -->
</nav>
```

#### Glass Modal / Sheet
```html
<div class="rounded-t-3xl bg-[rgba(255,255,255,0.15)] backdrop-blur-2xl
  backdrop-saturate-[180%] border border-white/20
  shadow-[0_-8px_32px_rgba(31,38,135,0.2)] p-6">
  <!-- Content -->
</div>
```

#### Glass Input
```html
<input class="w-full px-4 py-3 rounded-xl text-white placeholder-white/50
  bg-[rgba(255,255,255,0.08)] backdrop-blur-lg border border-white/15
  focus:border-white/30 focus:bg-[rgba(255,255,255,0.12)]
  outline-none transition-all duration-200" />
```

#### Glass Segmented Control
```html
<div class="inline-flex rounded-xl bg-[rgba(255,255,255,0.08)]
  backdrop-blur-lg border border-white/10 p-1">
  <button class="px-4 py-2 rounded-lg text-sm font-medium text-white
    bg-[rgba(255,255,255,0.15)] shadow-sm">
    Active
  </button>
  <button class="px-4 py-2 rounded-lg text-sm font-medium text-white/60
    hover:text-white/80 transition-colors">
    Inactive
  </button>
</div>
```

### Specular Highlight (Shine Effect)

Add a `::after` pseudo-element for the characteristic rim light:

```css
.glass-shine {
  position: relative;
  overflow: hidden;
}
.glass-shine::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.25) 0%,
    transparent 40%,
    transparent 60%,
    rgba(255, 255, 255, 0.05) 100%
  );
  pointer-events: none;
}
```

Or as Tailwind in a `@layer`:
```css
@layer components {
  .glass-shine {
    @apply relative overflow-hidden;
  }
  .glass-shine::after {
    content: '';
    @apply absolute inset-0 rounded-[inherit] pointer-events-none;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.25) 0%,
      transparent 40%,
      transparent 60%,
      rgba(255, 255, 255, 0.05) 100%
    );
  }
}
```

## Modern Theme System

Beyond glass surfaces, a modern theme pairs translucent materials with a
coherent color, elevation, and motion system.

### Color Roles
| Role | Light | Dark | Use |
|------|-------|------|-----|
| Background | `#f8fafc` | `#0b0f17` | App canvas behind glass |
| Surface | `rgba(255,255,255,0.10)` | `rgba(255,255,255,0.06)` | Cards, sheets |
| Surface elevated | `rgba(255,255,255,0.18)` | `rgba(255,255,255,0.10)` | Modals, popovers |
| Border | `rgba(255,255,255,0.20)` | `rgba(255,255,255,0.08)` | Hairline edges |
| Text primary | `#0f172a` | `#f1f5f9` | Body copy |
| Text secondary | `#475569` | `#94a3b8` | Captions, hints |
| Accent | brand-dependent | brand-dependent | CTAs, focus rings |

### Elevation Scale
| Level | Shadow | Use |
|-------|--------|-----|
| 0 | none | Flat background |
| 1 | `0 1px 2px rgba(0,0,0,0.06)` | Resting cards |
| 2 | `0 4px 12px rgba(0,0,0,0.08)` | Hover state |
| 3 | `0 8px 32px rgba(31,38,135,0.15)` | Glass surfaces |
| 4 | `0 16px 48px rgba(0,0,0,0.20)` | Modals, FABs |

### Motion
- Default duration: `300ms` (fast: `150ms`, slow: `500ms`)
- Default easing: `cubic-bezier(0.4, 0, 0.2, 1)` (standard)
- Spring easing for playful interactions: `cubic-bezier(0.34, 1.56, 0.64, 1)`
- Hover lift: `hover:-translate-y-0.5`
- Press feedback: `active:scale-95`
- Entrance: `animate-in fade-in slide-in-from-bottom-4 duration-300`

### Dark Mode Adaptation

```html
<!-- Light context -->
<div class="bg-[rgba(255,255,255,0.15)] border-white/20 text-gray-900">

<!-- Dark context -->
<div class="dark:bg-[rgba(0,0,0,0.25)] dark:border-white/10 dark:text-white">
```

Adjust opacity ranges:
- **Light mode:** bg opacity 0.08–0.25, border-white/15–30
- **Dark mode:** bg opacity 0.15–0.35, border-white/5–15

## Hierarchy Through Opacity

| Level       | Background Opacity | Border Opacity | Blur     |
|-------------|-------------------|----------------|----------|
| Primary     | 0.15–0.25         | 0.20           | blur-lg  |
| Secondary   | 0.08–0.12         | 0.10–0.15      | blur-lg  |
| Tertiary    | 0.04–0.08         | 0.10           | blur-md  |
| Elevated    | 0.20–0.30         | 0.25–0.30      | blur-xl  |

## Animations

Frosted glass favors smooth, spring-like transitions:

```
/* Hover lift */
hover:-translate-y-0.5 transition-all duration-300

/* Press feedback */
active:scale-95 transition-transform duration-150

/* Entrance */
animate-in fade-in slide-in-from-bottom-4 duration-300

/* Keep it subtle — no bouncy or flashy animations */
```

## Accessibility Requirements

1. **Contrast:** Always verify text contrast against translucent backgrounds. Use `text-white` with sufficient shadow or a darker glass surface if needed.
2. **Reduce Transparency:** Respect `prefers-reduced-transparency`:
   ```css
   @media (prefers-reduced-transparency: reduce) {
     .glass { backdrop-filter: none; background: rgba(30, 30, 30, 0.95); }
   }
   ```
3. **Reduce Motion:** Respect `prefers-reduced-motion`:
   ```css
   @media (prefers-reduced-motion: reduce) {
     .glass { transition: none; animation: none; }
   }
   ```
4. **Dynamic Type:** Use relative units (`rem`, `em`) for font sizes.
5. **Focus states:** Ensure visible focus rings on all interactive glass elements.

## Performance Guidelines

- `backdrop-filter: blur()` triggers compositing — use sparingly on scroll-heavy views
- Avoid stacking more than 2-3 glass layers
- Test on lower-end devices
- Prefer CSS-only effects over JS-driven animations

## Anti-Patterns

- **Too much blur** — max `blur-xl` (20px) for most elements
- **Fully transparent backgrounds** — always have some tint (min 0.04 opacity)
- **Heavy borders** — keep borders at max 1px, low opacity
- **Inconsistent radii** — pick 2-3 radius values and stick to them
- **Glass on glass on glass** — avoid deep nesting of translucent layers
- **No fallback** — always degrade gracefully for unsupported browsers
- **Ignoring accessibility** — translucent != illegible
- **Refraction/displacement filters** — out of scope; use SVG filters only for hero elements and always provide a fallback
