# Little Stack icon source

These five SVGs were supplied by the user in `little-stack-avatars-eyes.zip` on 2026-11-05. They are the source artwork, preserved byte for byte; the site does not load their original infinite animation styles. `preview.gif` is a reference preview and is not shipped.

| Source file | SHA-256 |
| --- | --- |
| `little-stack.svg` | `8c03e323c5fad2d2bac8233840cd9d3e8807f29ab6ff92fa5549ad42f96139b7` |
| `little-harness.svg` | `e1dd096bb5168c1b94753cb247064d384e82822792bdd216c603d0bfb7354c3e` |
| `little-workflow.svg` | `657cd462ebdae3330a61e4235b2cafa21af7df382b1f99e65b9c766fb7afcfac` |
| `littledb.svg` | `184cafd4b42d23029fe7c70c0374d23e05aa11b7b10ef3ca49e70b9b8e52d112` |
| `little-compute.svg` | `7045cad401a44d7d01045f9e476c01f9d6c2d8febba3e2bc7d6005946ee8bb22` |

`src/lib/stack-icon-artwork.ts` preserves the source path geometry, fills, strokes, eye shapes, and eye transforms. Its plain SVG helpers and the corresponding `public/icons/*.svg` omit the eye layer. No raster tracing, recoloring, or generated replacements are used.

`src/app/stack-icon-motion.css` preserves every supplied keyframe and the 12-second ease-in-out timing. Keyframe names are prefixed to avoid collisions. Infinite playback is replaced by one iteration, controlled by `StackIconMotion`:

- Initial HTML and normal interaction show the plain mark.
- After five seconds without pointer, keyboard, touch, wheel, or scroll activity, visible icons reveal eyes and play once for twelve seconds. Eyes then remain still.
- Interaction immediately hides eyes and cancels playback. A new sequence requires five idle seconds and a cooldown of sixty seconds after the previous sequence's scheduled finish. Remaining idle never loops playback.
- Reduced-motion users always see the plain mark. Hidden tabs have no motion or pending timers. Offscreen icons do not animate; entering an already idle scene reveals still eyes.
- One controller owns the listeners, timers, and shared observers. All are cleaned up on unmount.

`StackIcon` is decorative by default; use its optional `label` only where no adjacent text names the icon. The shared 48×48 viewBox and explicit dimensions reserve layout space before hydration.
