# Tiled Palette Quantization++

A fork of [Selbi's Mega Drive fork](https://github.com/Selbi182/tiledpalettequant) of [rilden's Tiled Palette Quant web tool](https://rilden.github.io/tiledpalettequant), with two tools:

- **Palette Quantization** (`src/index.html`): the original quantizer, tuned for retro-console art.
- **Attribute Editor** (`src/attributes.html`): paint which palette each tile uses on an indexed image or a Tiled map, then export attribute data for NES, NES MMC5 or Game Boy Color.

Switch between them with the tabs under the page title.

This version is perma hosted at https://purpbatboi.github.io/TiledQuantizationDX/.

## Running it

It's a static site with no build step. Serve `src/` with any web server, for example:

```sh
python -m http.server -d src
```

Then open http://localhost:8000/. The quantizer uses a Web Worker, which Chromium browsers (Chrome, Edge) block on `file://` pages. Opening the HTML file directly works for the Attribute Editor but not for quantizing.

Tests use Node's built-in runner:

```sh
node --test tests/*.test.js
```

## Attribute Editor

### Loading

- **An indexed PNG:** each pixel's palette index tells the editor which palette row it uses.
- **A Tiled map:** select the `.tmx`/`.tmj` together with its `.tsx`/`.tsj` tileset and the tileset `.png`. Maps with several tile layers ask which layer to edit.

### Painting

- **Systems:**
  - Game Boy Color: 8 palettes of 4 colors, per 8×8 tile.
  - NES: 4 palettes of 4 colors with a shared color 0, per 16×16 block. The **8×8 Attributes** option switches to per-8×8 tiles (MMC5).
  - Mega Drive (WIP): 4 palettes of 16 colors, per 8×8 tile. No attribute export, since the palette lives in each tile's map entry.
- **Palette brush:** pick a palette row, then click or drag over tiles. Blocks whose pixels use more than one palette are outlined in red.
- **Priority brush (Game Boy Color):** marks tiles whose background colors 1-3 draw over sprites (attribute bit 7). Priority tiles show a yellow corner flag. Priority is saved in the attribute export only, not in the indexed PNG.
- **Navigation:** undo/redo with Ctrl+Z / Ctrl+Y. The mouse wheel zooms around the cursor. Middle-drag, or Space + drag, pans.

### Exports

- **Download Indexed PNG:** the image with each tile's pixels moved to its painted palette row.
- **Download Attributes:** the attribute data in the format picked from the list.

C exports are `.c` source files, and the first comment line gives the `extern` declaration to use.

| System | Formats | Data |
|---|---|---|
| NES | Binary, ASM `.byte` (ca65), ASM `.db` (asm6 / NESASM), C, C + RLE (NESlib) | Standard attribute table, byte-compatible with NEXXT |
| NES, 8×8 Attributes | Binary, ASM `.byte`, ASM `.db`, C | MMC5 ExRAM extended attributes: one byte per tile, palette in bits 6-7, whole map row by row |
| Game Boy Color | Binary, C, C + RLE / GB (GBTD) / ZX0 (GBDK), ASM for GBDK (sdas), ASM for RGBDS | BG map attributes: one byte per tile, palette in bits 0-2, priority in bit 7 |


## Differences to the [original version](https://github.com/rilden/tiledpalettequant)

- Quantization:
  - Palette images are generated with 8x8 pixels per color instead of 16x16. This is a requirement of many art importers, including SonPLN and GetArt.NET
  - Added a color-space selector with Default and Megadrive options (Megadrive enabled by default)
  - Added an option to sample the most frequent opaque source color as a shared color-zero entry
  - Changed default values:
    - Palettes: 1 (used to be 8)
    - Colors per palette: 16 (used to be 4)
    - Bits per channel: 4 (used to be 5)
- Website:
  - Gave the site a huge visual facelift to make it look less like it was created in the 90s
  - Always download quantized image as .png (never .bmp)
  - Download indexed PNGs with their full palette order and duplicate entries when the palette has at most 256 colors
  - Disable dither settings when set to Off
  - Added tooltips for every quantization option
  - Added cancellation for long-running quantization while retaining the partial result and applying the selected dithering
  - Disabled autocomplete for all inputs
  - Dereference image loading to avoid quirks with client-side width/height adjustments
  - Added the Attribute Editor, with tabs to switch between the two tools
- Project:
  - Restructured original folder layout
  - Changed [sample image](https://wallscloud.net/en/wallpaper/nature/plants/Pablo-Garcia-Saldana/pKL1)
  - Added favicon (based on sample image)
  - Removed TS stuff
  - Removed duplicated v0.1 source folder
  - Added Node tests (`tests/`)
