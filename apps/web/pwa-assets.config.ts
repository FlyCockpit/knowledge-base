import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// `assets/logo.png` is the bare artwork on a transparent canvas. The transparent
// icons (favicon and pwa-*) use it as is, so they sit on any page background.
// The maskable icon must be opaque, so its padding uses the FlyCockpit suite
// blue (#4a97fa) instead of the generator's default white. Padding 0.29 is
// tuned for this logo so its farthest opaque pixel stays inside the center
// 80% maskable safe-zone circle (messages-mcp's artwork uses 0.27).
//
// The apple touch icon is NOT generated here (`sizes: []`): it is the Icon
// Composer tile `assets/app-icon.png` with its transparent corners filled by
// the tile's own background, sampled row by row (a dark vertical gradient),
// and resized to `public/apple-touch-icon-180x180.png` (iOS rounds the corners
// itself, shows transparency as black, and has no dark variant for web clips).
//
// The header logo (`AppBrand`, components/app-brand.tsx; `APP_LOGO` in
// src/lib/app-logo.ts) is drawn at 32 CSS px, so the transparent set adds 32
// and 128 to the preset's 64: `pwa-32x32.png`, `pwa-64x64.png` and
// `pwa-128x128.png` are its 32w/64w/128w sources. They come from the same
// source image as the favicon and the install icons, so the three never
// drift. The generator writes next to `assets/logo.png`; copy new files to
// `public/` (vite-plugin-pwa's `pwaAssets` also serves and emits them).
// docs/ui.md § Logo slot.
const background = "#4a97fa";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: {
    ...minimal2023Preset,
    transparent: {
      ...minimal2023Preset.transparent,
      sizes: [32, ...minimal2023Preset.transparent.sizes, 128],
    },
    maskable: { ...minimal2023Preset.maskable, padding: 0.29, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, sizes: [] },
  },
  images: ["assets/logo.png"],
});
