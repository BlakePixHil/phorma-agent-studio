/**
 * Phorma design-language overrides for the PrimeNG Aura preset.
 *
 * ## Why this file exists
 *
 * Aura's stock form fields are a near-black fill (`{surface.950}`) inside a
 * hard grey border (`{surface.600}`), and its content/overlay/text surfaces
 * come from a single global slate (light) / zinc (dark) ramp. That ramp knows
 * nothing about our six theme modes, so a Nord panel ended up hosting a
 * `#09090b` input: the field read as a hole punched through the panel rather
 * than a recess in it.
 *
 * Every colour below therefore points at a `--phorma-*` CSS variable that each
 * theme mode defines in `styles.scss`. The indirection is the whole point:
 *
 *   - Adding a theme mode stays "one registry entry + one CSS block"
 *     (`theme-modes.ts`), with no PrimeNG token names involved.
 *   - The light/dark split lives in the theme class blocks, not here, so both
 *     colour schemes below reference the SAME var names.
 *
 * ## The field recipe (Framer-style)
 *
 * Resting: soft translucent fill, `border-color: transparent` on dark themes
 * and a hairline on light, `box-shadow: none`, 8px radius.
 * Hover: the fill lifts a few percent (applied in `styles.scss` - Aura has no
 * `hoverBackground` token for the default outlined variant).
 * Focus: a 1px border in the active primary palette colour and nothing else.
 * The resting border-WIDTH stays 1px so focus never reflows the field.
 *
 * ## Cascade note
 *
 * These colours must be declared inside `colorScheme.light` / `colorScheme.dark`
 * rather than once at the `semantic` level. PrimeNG emits the semantic block
 * before the colour-scheme blocks in the same CSS layer, so a semantic-level
 * value loses to Aura's own `colorScheme.light.formField.*` on source order.
 */

/** Form field colours, shared verbatim by both colour schemes. */
const FIELD_COLORS = {
  background: 'var(--phorma-field-bg)',
  disabledBackground: 'var(--phorma-field-bg-disabled)',
  filledBackground: 'var(--phorma-field-bg)',
  filledHoverBackground: 'var(--phorma-field-bg-hover)',
  filledFocusBackground: 'var(--phorma-field-bg-focus)',
  borderColor: 'var(--phorma-field-border)',
  hoverBorderColor: 'var(--phorma-field-border-hover)',
  focusBorderColor: 'var(--p-primary-color)',
  color: 'var(--phorma-field-text)',
  disabledColor: 'var(--phorma-field-text-disabled)',
  placeholderColor: 'var(--phorma-field-placeholder)',
  iconColor: 'var(--phorma-field-icon)',
  floatLabelColor: 'var(--phorma-field-placeholder)',
  floatLabelActiveColor: 'var(--phorma-field-placeholder)',
  floatLabelFocusColor: 'var(--p-primary-color)',
  shadow: 'var(--phorma-field-shadow)',
} as const;

/**
 * Content, overlay, list, navigation and text surfaces, retinted per theme.
 * Without this, dropdown panels, popovers and menus keep Aura's zinc/slate
 * hue while the panel around them follows the theme - the single biggest
 * source of the "jarring" mismatch on Nord, Solarized and Midnight.
 */
const SURFACE_COLORS = {
  content: {
    background: 'var(--phorma-overlay-bg)',
    hoverBackground: 'var(--phorma-hover-bg)',
    borderColor: 'var(--phorma-overlay-border)',
  },
  overlay: {
    select: {
      background: 'var(--phorma-overlay-bg)',
      borderColor: 'var(--phorma-overlay-border)',
    },
    popover: {
      background: 'var(--phorma-overlay-bg)',
      borderColor: 'var(--phorma-overlay-border)',
    },
    modal: {
      background: 'var(--phorma-overlay-bg)',
      borderColor: 'var(--phorma-overlay-border)',
    },
  },
  list: {
    option: {
      focusBackground: 'var(--phorma-hover-bg)',
      icon: {
        color: 'var(--phorma-field-icon)',
        focusColor: 'var(--phorma-text)',
      },
    },
  },
  navigation: {
    item: {
      focusBackground: 'var(--phorma-hover-bg)',
      activeBackground: 'var(--phorma-hover-bg)',
      icon: {
        color: 'var(--phorma-field-icon)',
        focusColor: 'var(--phorma-text)',
        activeColor: 'var(--phorma-text)',
      },
    },
    submenuIcon: {
      color: 'var(--phorma-field-icon)',
      focusColor: 'var(--phorma-text)',
      activeColor: 'var(--phorma-text)',
    },
  },
  text: {
    color: 'var(--phorma-text)',
    hoverColor: 'var(--phorma-text)',
    mutedColor: 'var(--phorma-text-muted)',
    hoverMutedColor: 'var(--phorma-text)',
  },
} as const;

/** One colour-scheme block. Both schemes are identical by design - see header. */
const SCHEME = {
  formField: FIELD_COLORS,
  ...SURFACE_COLORS,
} as const;

/** Semantic overrides merged into the Aura preset. */
export const PHORMA_SEMANTIC = {
  formField: {
    /* 8px reads softer than Aura's 6px `border.radius.md` and matches the
       radius the rest of our chrome uses. */
    borderRadius: '8px',
  },
  colorScheme: {
    light: SCHEME,
    dark: SCHEME,
  },
} as const;

/**
 * Component overrides for the controls that do NOT inherit `{form.field.*}`
 * colours, or that inherit them in a way which erases the control.
 *
 * - checkbox / radiobutton: they DO read `{form.field.border.color}`, which is
 *   now transparent. A 1.25rem box with no border and a 5% fill is invisible,
 *   so selection controls get their own slightly stronger resting edge.
 * - toggleswitch: its off-state track is a raw `{surface.700}`, which lands
 *   almost exactly on the Nord panel colour.
 * - togglebutton (`p-selectbutton`): the whole segmented control was
 *   `{surface.950}` - the black period strip in the usage panel, the usage and
 *   evals dialogs, and the prompt dialog's mode switch.
 * - slider: its track and handle are `{content.border.color}`, which is now a
 *   faint hairline, so the track needs the stronger control edge instead.
 */
export const PHORMA_COMPONENTS = {
  checkbox: {
    root: {
      background: 'var(--phorma-field-bg)',
      borderColor: 'var(--phorma-control-border)',
      hoverBorderColor: 'var(--phorma-control-border-hover)',
      focusBorderColor: 'var(--p-primary-color)',
    },
  },
  radiobutton: {
    root: {
      background: 'var(--phorma-field-bg)',
      borderColor: 'var(--phorma-control-border)',
      hoverBorderColor: 'var(--phorma-control-border-hover)',
      focusBorderColor: 'var(--p-primary-color)',
    },
  },
  toggleswitch: {
    colorScheme: {
      light: {
        root: {
          background: 'var(--phorma-switch-track)',
          hoverBackground: 'var(--phorma-switch-track-hover)',
        },
      },
      dark: {
        root: {
          background: 'var(--phorma-switch-track)',
          hoverBackground: 'var(--phorma-switch-track-hover)',
        },
      },
    },
  },
  togglebutton: {
    colorScheme: {
      light: {
        root: {
          background: 'var(--phorma-segment-bg)',
          hoverBackground: 'var(--phorma-segment-bg)',
          checkedBackground: 'var(--phorma-segment-bg)',
          borderColor: 'transparent',
          checkedBorderColor: 'transparent',
          color: 'var(--phorma-text-muted)',
          hoverColor: 'var(--phorma-text)',
          checkedColor: 'var(--phorma-text)',
        },
        content: { checkedBackground: 'var(--phorma-segment-selected)' },
        icon: {
          color: 'var(--phorma-text-muted)',
          hoverColor: 'var(--phorma-text)',
          checkedColor: 'var(--phorma-text)',
        },
      },
      dark: {
        root: {
          background: 'var(--phorma-segment-bg)',
          hoverBackground: 'var(--phorma-segment-bg)',
          checkedBackground: 'var(--phorma-segment-bg)',
          borderColor: 'transparent',
          checkedBorderColor: 'transparent',
          color: 'var(--phorma-text-muted)',
          hoverColor: 'var(--phorma-text)',
          checkedColor: 'var(--phorma-text)',
        },
        content: { checkedBackground: 'var(--phorma-segment-selected)' },
        icon: {
          color: 'var(--phorma-text-muted)',
          hoverColor: 'var(--phorma-text)',
          checkedColor: 'var(--phorma-text)',
        },
      },
    },
  },
  slider: {
    track: { background: 'var(--phorma-control-border)' },
    handle: {
      background: 'var(--phorma-control-border)',
      hoverBackground: 'var(--phorma-control-border-hover)',
      content: {
        hoverBackground: 'var(--phorma-overlay-bg)',
      },
    },
    colorScheme: {
      light: { handle: { content: { background: 'var(--phorma-overlay-bg)' } } },
      dark: { handle: { content: { background: 'var(--phorma-overlay-bg)' } } },
    },
  },
} as const;
