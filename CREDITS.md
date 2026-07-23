# Visual credits and generation notes

## Early trainer-camp concept

Generated with the built-in OpenAI image generation tool. It was superseded by the user's final wallpaper and is retained only as an alternate source asset.

Final prompt:

> Use case: stylized-concept. Asset type: extra-wide desktop productivity application background. An original collectible-creature trainer camp at golden hour, with two completely original friendly fantasy companions resting beside a compact glowing field computer: one small round golden electric fox-cub with long leaf-shaped ears and amber cheek sparks, and one small cream-and-cinnamon woodland rabbit with a leafy tail. Lush grassy clearing beside a calm teal lake, distant blue mountains, soft clouds, tiny firefly-like motes. Premium polished anime adventure illustration, original character design, warm and elegant enough for a coding workspace. Place both creatures and the field computer entirely within the rightmost 40% of the extra-wide frame; preserve the center and left 55% as spacious, low-detail grass, lake, sky, and gentle atmospheric gradients for highly readable interface content. Soft golden-hour rim light, calm, optimistic, focused. Warm cream, field-guide red accents, amber yellow, leaf green, lake teal, sky blue. Wholly original creatures; no existing franchise characters; no text, logos, trademarks, watermark, interface mockup, frame, border, duplicates, or cropped faces.

## User-provided graphics

- `pokeball-logo-user.png`: original Poké Ball half-logo supplied by the user.
- `pokeball-logo-white.png`: theme-ready derivative with a white lower hemisphere, transparent exterior, and preserved black outlines; used in the sidebar.
- `mascot-transparent.png`: mascot capsule icon supplied by the user; the baked checkerboard was removed locally with a connected-background alpha mask after the image-generation edit path was rejected.
- `pokemon-onsen.jpg`: final hot-spring Pikachu workspace wallpaper supplied by the user.

## White lower-hemisphere edit

The built-in image editing tool was used first with this targeted prompt:

> Change only the transparent lower semicircle of the supplied Poké Ball to solid clean white. Preserve the exact canvas, centered geometry, red upper gradient, black horizontal divider and outlines, central white button, thin red inner ring, proportions, and transparent area outside the circular ball. Do not crop, rotate, redraw, add shadows, add text, or alter anything else.

For pixel-exact geometry, the shipped `pokeball-logo-white.png` was then finished locally with a deterministic antialiased white lower-circle layer beneath the unchanged original artwork. No CLI image-model fallback was used.
