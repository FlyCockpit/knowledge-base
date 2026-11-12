import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// `assets/logo.png` is the bare artwork on a transparent canvas. The transparent
// icons (favicon and pwa-*) use it as is, so they sit on any page background.
// The maskable icon must be opaque, so its padding uses the FlyCockpit suite
// blue (#4a97fa) instead of the generator's default white. Padding 0.29 is
// tuned for this logo so its farthest opaque pixel stays inside the center
// 80% maskable safe-zone circle (messages-mcp's artwork uses 0.27).
//
// The apple touch icon is NOT generated here (`sizes: []`): keep
// `public/apple-touch-icon-180x180.png` as is until Apple-style tiles are supplied.
const background = "#4a97fa";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.29, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, sizes: [] },
  },
  images: ["assets/logo.png"],
});
