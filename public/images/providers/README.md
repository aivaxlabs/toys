# Provider icons

Monochrome provider logos for the Image Playground model picker. The page draws them as CSS masks, so they follow the current theme color.

- Source: [LobeHub Icons](https://github.com/lobehub/lobe-icons) `@lobehub/icons-static-svg@1.102.0`, MIT license. File names match the provider part of the AIVAX model id (`@black-forest-labs/...` → `black-forest-labs.svg`; LobeHub's `bfl.svg` and `xai.svg` were renamed).
- `microsoft.svg` is drawn here (the four-squares mark), because LobeHub's `microsoft.svg` is the Azure logo.
- Trademarks belong to their owners and identify the model provider only.

To add a provider, save its monochrome (`fill="currentColor"`) SVG here and add it to `PROVIDERS` in `public/scripts/image-playground.js`. Providers without an icon get a letter badge.
