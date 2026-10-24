/**
 * Extend Excalidraw's FONT_FAMILY to add custom Chinese fonts.
 *
 * Excalidraw has no public API for registering custom fonts, but since
 * FONT_FAMILY is a plain object exported from the package, we can extend
 * it at runtime before the Excalidraw component mounts.
 *
 * Font IDs: use high numbers (1000+) to avoid conflicts with built-in fonts.
 */
import { FONT_FAMILY } from '@excalidraw/excalidraw'

const CUSTOM_FONTS = {
  /** 霞鹜文楷 — open-source, loaded from Google Fonts */
  '霞鹜文楷': 1000,
  /** 华文行楷 — macOS system font "STXingkai", Windows "华文行楷" */
  '华文行楷': 1001,
  /** 方正行楷 — commercial font, must be installed on the system */
  '方正行楷': 1002,
} as const

// Extend FONT_FAMILY at module init time
Object.assign(FONT_FAMILY as Record<string, number>, CUSTOM_FONTS)

/**
 * CSS font-family names mapped to FONT_FAMILY keys.
 * These are applied via document styles so the canvas text rendering
 * (ctx.font) can resolve the correct typeface.
 */
export const CUSTOM_FONT_CSS_NAMES: Record<number, string> = {
  1000: '"LXGW WenKai", "霞鹜文楷", sans-serif',
  1001: 'STXingkai, "华文行楷", "STXingkai SC", serif',
  1002: '"FZXingKai", "方正行楷简体", "方正行楷", serif',
}
