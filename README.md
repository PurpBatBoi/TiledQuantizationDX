# Tiled Palette Quantization++

A fork of [Selbi's Mega Drive fork](https://github.com/Selbi182/tiledpalettequant) of [rilden's Tiled Palette Quant web tool](https://rilden.github.io/tiledpalettequant), with four tools:

- **Palette Quantization** (`src/index.html`): the original quantizer, tuned for retro-console art.
- **Attribute Editor** (`src/attributes.html`): paint which palette each tile uses on an indexed image or a Tiled map, then export attribute data for NES, NES MMC5 or Game Boy Color.
- **Graphics Conversion** (`src/graphics.html`): turn finished PNG background art or a Tiled map layer into NES, Game Boy or Game Boy Color tile (`.chr`) and palette (`.pal`) files.
- **Tile Compression** (`src/tile-reuse.html`): reduce a PNG to a target number of unique tiles by reusing the closest tiles, with no color limits, then download the result.

Switch between them with the tabs under the page title.

This version is perma hosted at https://purpbatboi.github.io/TiledQuantizationDX/.

## Running it

It's a static site with no build step. Serve `src/` with any web server, for example:

```sh
python -m http.server -d src
```

Then open http://localhost:8000/. The quantizer uses a Web Worker, which Chromium browsers (Chrome, Edge) block on `file://` pages. Opening the HTML file directly works for the Attribute Editor but not for quantizing. Graphics Conversion and Tile Compression also use a worker, but fall back to converting on the page when the worker is blocked.

Tests use Node's built-in runner:

```sh
node --test tests/*.test.js
```

The quantizer itself is C++ in `src/wasm/quantize.cpp`, compiled to the committed `src/js/quantize.wasm`. You only need to rebuild it after changing the C++. Install Zig with `pip install ziglang`, then run the build command from the top of that file.

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


## Graphics Conversion

Converts PNG background art into hardware data, entirely in the browser. Apart from Game Boy Auto Shades, it never reduces colors itself: art over a limit is explained and outlined in red, and every download stays disabled until the conversion succeeds.

### Workflow

1. **Palette Quantization:** reduce the art to the target's palette layout, for example 4 palettes of 4 colors in 16×16 tiles for NES, or 8 palettes of 4 colors in 8×8 tiles for Game Boy Color.
2. **Attribute Editor** (optional): fix which palette each block uses, then download the indexed PNG.
3. **Graphics Conversion:** load the PNG or Tiled map, pick the target, check the Tileset Map Preview and tileset, then download the files.

When an otherwise valid PNG has too many unique tiles, open **Tile Compression** instead. It ignores color limits, deduplicates exact tiles, then applies lossy tile substitutions only if the result exceeds the target tile count you choose.

### Targets

| Target | Colors | Tiles | Flipped tiles |
|---|---|---|---|
| NES | Nearest color from the palgen NES palette. 4 palettes of 3 colors per 16×16 block, plus a shared color 0 | 256 | Not reused (standard nametables can't flip) |
| Game Boy | 4 colors in the whole image, ordered light to dark over the 4 DMG shades. Auto Shades handles art with more | 256 | Not reused |
| Game Boy Color | Rounded to RGB555. 8 palettes of 4 colors per 8×8 tile | 512 (tiles 256+ use VRAM bank 1) | Reused through the attribute flip bits |

- **NES color 0:** Auto picks the most used opaque color. Click a swatch to force a different one.
- **NES palette touch-up:** after converting, click any color in the Palettes panel and pick a replacement from the NES palette. Tiles keep their color indexes; only the color changes, in the previews and in the `.pal`. Color 0 is shared, so editing it changes every palette. Edited colors get a corner dot, and each can be reset from its popup or all at once with Reset Palette Edits. Edits clear when the image is converted again (new file, target or Color 0 choice).
- **Game Boy Auto Shades** (on by default): art with more than 4 colors, or indexed art using entries past 3, is grouped into the 4 shades by brightness instead of being rejected. The split into shades gives each shade the colors closest in brightness, weighted by pixel count, so large areas keep their detail. Art that already fits keeps its exact colors. Turn it off to get the error instead.
- **Tiled maps:** select the `.tmx`/`.tmj` together with its `.tsx`/`.tsj` tileset and the indexed tileset `.png`, as in the Attribute Editor. Maps with several tile layers ask which layer to convert. The layer is flattened (Tiled flips included) and converted like an indexed PNG, so file names get the layer name, for example `level_Ground.chr`.
- **Indexed PNGs:** keep their palettes. Entries 0-3 are palette 0, entries 4-7 are palette 1 and so on, with their order and any duplicate entries. Each tile keeps the palette its pixels use.
- **Other PNGs:** palettes are built in scan order. Each block's colors join the first palette they fit in.

### Input rules

- Width and height must be multiples of 8.
- Pixels must be fully opaque or fully transparent. Transparent pixels become color index 0:
  - Indexed PNGs keep that palette entry's RGB.
  - Other PNGs use the NES shared color, DMG shade 0, or black on Game Boy Color.

### Views

- **Tileset Map Preview:** the image rebuilt from the tileset. When conversion fails, it shows the art in the nearest hardware colors, with invalid areas outlined in red.
- **Tileset:** the deduplicated tiles.

Both views zoom and pan like the Attribute Editor. The mouse wheel zooms around the cursor, and middle-drag or Space + drag pans. The Zoom list sets both views, and Fit shows the whole image. A new image starts at Fit.

Click a tile, or focus a view and use the arrow keys, to select it. A view pans to bring the selection on screen. Every view then highlights the selection and all other uses of the same tile. The sidebar shows the tile's index, palette, position, bank and flip flags, and its packed bytes.

### Downloads

Graphics only, as plain binary files named after the source image, for example `title.png` gives `title.chr` and `title.pal`. The map and attributes are shown for checking but not exported.

| File | NES | Game Boy | Game Boy Color |
|---|---|---|---|
| `<name>.chr` | Planar 2bpp tiles padded to a 4 KB pattern table (256 tiles), as NEXXT and YYCHR load it | Interleaved 2bpp tiles, unpadded | Interleaved 2bpp tiles, unpadded (tiles 256+ go to VRAM bank 1) |
| `<name>.pal` | 16 bytes: the 4 background palettes as PPU colors (NEXXT's format), unused palettes filled with color 0 | 1 byte: the BGP register value | The used palettes as little-endian RGB555, 8 bytes each (rgbgfx's `.pal`) |

## Tile Compression

Reduces a PNG to a target number of unique 8×8 tiles. It applies no palette, color or hardware limits: tiles are compared by their exact RGBA pixels, and the only requirement is that width and height are multiples of 8. It does not accept Tiled maps or export hardware data.

Exact duplicate tiles are always reused first. **Tolerance** (0 to 128) then lets a tile reuse the first earlier tile whose average difference per RGBA channel is within it, like the tileset extractor in [platforms](https://github.com/andremichelle/platforms) (reimplemented, not bundled). If the result still exceeds the **Target tiles** count (1 to 65536, default 256; blank for no limit), the editor keeps the most-used tile patterns (with scan order breaking ties) and replaces every remaining cell with its closest kept tile by RGBA distance. With **Match flipped tiles** on, horizontally and vertically mirrored tiles count as the same tile and can be used as matches.

The **Keep brush** (yellow flag, left of the Source preview) marks cells whose tiles must stay exact, such as faces, text or logos. Their tiles claim the target budget before any other tile, so the loss moves to unmarked areas. A stroke that starts on a kept cell clears instead, and **Clear kept cells** removes every mark. If the kept cells alone need more unique tiles than the target, the Result panel warns and only the most-used of them stay exact.

The Source and Compressed previews share one viewport, as in the Attribute Editor: the wheel zooms around the cursor, dragging pans, and the View panel sets zoom, grid, grid color and grid opacity.

The Result panel shows the exact and final tile counts, number of substituted cells and root-mean-square RGBA error. The download is a truecolor `<name>_compressed.png` at the source dimensions; run it through Palette Quantization afterwards if it has to fit a system's colors.

### Where the rules come from

The rules are reimplemented, not bundled, from GBDK-2020's tools:

- **NES colors:** from `nespal`. Nearest palgen color, skipping nespal's default invalid colors. Where colors look identical, black is `$0F` and white `$30`: neslib's `pal_bg` turns `$1D` into gray `$00` and `$20` into light gray `$10`. neslib also remaps the grays `$2D`/`$3D` to `$10`/`$20`.
- **Everything else:** from `png2asset`. That covers tile packing, first-fit palette merging and the GBC attribute bits.
- **Checked against the real tools:**
  - Game Boy Color tiles, map, attributes and palettes match `png2asset -map -use_map_attributes` byte for byte on a test image.
  - Game Boy tiles and map match `png2asset -map -noflip`.
  - NES output differs from `png2asset`, which doesn't treat color 0 as shared.

## Differences to the [original version](https://github.com/rilden/tiledpalettequant)

- Quantization:
  - Palette images are generated with 8x8 pixels per color instead of 16x16. This is a requirement of many art importers, including SonPLN and GetArt.NET
  - Added a color-space selector with Default, Megadrive and NES (2C02G NESdev wiki palette) options (Megadrive enabled by default)
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
  - Added the Attribute Editor, with tabs to switch between the tools
  - Added the Graphics Conversion tool
- Project:
  - Restructured original folder layout
  - Changed [sample image](https://wallscloud.net/en/wallpaper/nature/plants/Pablo-Garcia-Saldana/pKL1)
  - Added favicon (based on sample image)
  - Removed TS stuff
  - Removed duplicated v0.1 source folder
  - Added Node tests (`tests/`)
