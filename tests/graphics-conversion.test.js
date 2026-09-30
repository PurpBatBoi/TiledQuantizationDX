const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/js/nes-attributes.js", "utf8"), context);
vm.runInContext(fs.readFileSync("src/js/graphics-conversion.js", "utf8"), context);
// structuredClone moves results out of the vm realm (so deepEqual compares plainly), like the worker's postMessage.
const exported = vm.runInContext("({ convertBackgroundAsset, graphicsOutputs, graphicsOutputNames, packNesTile, packGbTile, recolorNesPalettes })", context);
const [convertBackgroundAsset, graphicsOutputs, graphicsOutputNames, packNesTile, packGbTile, recolorNesPalettes] =
    Object.values(exported).map((fn) => (...args) => structuredClone(fn(...args)));

const BLACK = 0x000000;
const WHITE = 0xffffff;
const RED = 0xff0000;
const GREEN = 0x00ff00;
const BLUE = 0x0000ff;
const GRAY = 0x808080;
const TRANSPARENT = -1;

// pixel(x, y) -> 0xRRGGBB, TRANSPARENT, or [r, g, b, a].
function image(width, height, pixel) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = pixel(x, y);
            rgba.set(Array.isArray(value) ? value : value === TRANSPARENT ? [0, 0, 0, 0]
                : [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255], (y * width + x) * 4);
        }
    }
    return { width, height, rgba };
}

// An indexed image: palette is a list of 0xRRGGBB entries, alpha an optional list of per-entry alpha values.
function indexedImage(width, height, palette, entry, alpha = null) {
    const indexes = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) indexes[y * width + x] = entry(x, y);
    }
    const rgb = Uint8Array.from(palette.flatMap((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]));
    const base = image(width, height, (x, y) => {
        const e = indexes[y * width + x];
        const c = palette[e];
        return [(c >> 16) & 255, (c >> 8) & 255, c & 255, alpha === null ? 255 : alpha[e]];
    });
    return { ...base, indexed: { palette: rgb, indexes } };
}

// Tiles side by side, each tile given as a function (x, y) -> color.
function tileStrip(tiles) {
    return image(tiles.length * 8, 8, (x, y) => tiles[Math.floor(x / 8)](x % 8, y));
}

const convert = (input, options) => convertBackgroundAsset(input, options);
const codes = (result) => result.diagnostics.map((d) => d.code);

test("packs NES planar and Game Boy interleaved 2bpp tiles", () => {
    const pattern = new Uint8Array(64);
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) pattern[y * 8 + x] = y === 7 ? 3 : x & 3;
    }
    assert.deepEqual(Array.from(packNesTile(pattern)), [...Array(7).fill(0x55), 0xff, ...Array(7).fill(0x33), 0xff]);
    assert.deepEqual(Array.from(packGbTile(pattern)), [...Array(7).fill([0x55, 0x33]).flat(), 0xff, 0xff]);
});

test("converted tiles carry those exact bytes", () => {
    const art = tileStrip([(x, y) => [BLACK, GRAY, 0xc0c0c0, WHITE][y === 7 ? 0 : 3 - (x & 3)]]);
    // Light to dark: white 0, light gray 1, gray 2, black 3. Row 7 is all black.
    const gb = convert(art, { system: "gb" });
    assert.ok(gb.ok);
    assert.deepEqual(Array.from(gb.tileBytes), [...Array(7).fill([0x55, 0x33]).flat(), 0xff, 0xff]);
});

test("encodes NES PPU and GBC RGB555 palettes", () => {
    // Black background with palgen's $16, $27 and $2A.
    const nes = convert(image(16, 16, (x, y) => (y === 0 ? [0xcf0b00, 0xff8014, 0x28c421][x % 3] : BLACK)), { system: "nes" });
    assert.ok(nes.ok);
    assert.equal(nes.sharedColor, 0x0f);
    // Light to dark after the shared color.
    assert.deepEqual(Array.from(nes.paletteBytes), [0x0f, 0x27, 0x2a, 0x16]);

    const gbc = convert(tileStrip([(x) => [WHITE, RED, GREEN, BLUE][x & 3]]), { system: "gbc" });
    assert.ok(gbc.ok);
    assert.deepEqual(Array.from(gbc.paletteValues[0]), [0x7fff, 0x03e0, 0x001f, 0x7c00]);
    assert.deepEqual(Array.from(gbc.paletteBytes), [0xff, 0x7f, 0xe0, 0x03, 0x1f, 0x00, 0x00, 0x7c]);
});

test("GBC quantizes to RGB555 before counting colors", () => {
    // 0xf8 and 0xff are the same 5-bit value.
    const gbc = convert(tileStrip([(x) => [0xf80000, 0xff0000, 0xfc0000, 0x0000ff, 0x00ff00][x % 5]]), { system: "gbc" });
    assert.ok(gbc.ok);
    assert.equal(gbc.paletteValues[0].filter((word) => word === 0x001f).length, 1);
});

test("keeps indexed palette groups, their order and duplicate entries", () => {
    const palette = [BLACK, RED, RED, WHITE, BLUE, GREEN, GRAY, WHITE];
    // Tile 0 uses group 1 (entries 4-7), tile 1 group 0, both with every index.
    const input = indexedImage(16, 8, palette, (x) => (x < 8 ? 4 : 0) + (x & 3));
    const gbc = convert(input, { system: "gbc" });
    assert.ok(gbc.ok);
    assert.deepEqual(Array.from(gbc.cells.palette), [1, 0]);
    assert.deepEqual(gbc.paletteValues.map((row) => Array.from(row)), [[0x0000, 0x001f, 0x001f, 0x7fff], [0x7c00, 0x03e0, 0x4210, 0x7fff]]);
    // Same index pattern in both tiles, so one tile, indexes kept as entry % 4.
    assert.equal(gbc.tileCount, 1);
    assert.deepEqual(Array.from(gbc.tilePixels.subarray(0, 8)), [0, 1, 2, 3, 0, 1, 2, 3]);
});

test("rejects indexed areas that mix palette groups", () => {
    const input = indexedImage(8, 8, [BLACK, RED, GREEN, BLUE, WHITE, GRAY, RED, RED], (x) => (x === 0 ? 5 : 1));
    const gbc = convert(input, { system: "gbc" });
    assert.deepEqual(codes(gbc), ["region-palettes"]);
    assert.deepEqual(gbc.diagnostics[0].rects, [{ x: 0, y: 0, width: 8, height: 8 }]);
});

test("infers palettes deterministically in scan order", () => {
    const tiles = [
        (x) => [RED, GREEN][x & 1],
        (x) => [BLUE, WHITE][x & 1],
        (x) => [RED, GREEN, BLUE, WHITE][x & 3],
        (x) => [GRAY, BLACK][x & 1],
        (x) => [GRAY, BLACK, 0x123456][x % 3],
    ];
    const first = convert(tileStrip(tiles), { system: "gbc" });
    const second = convert(tileStrip(tiles), { system: "gbc" });
    assert.ok(first.ok);
    assert.deepEqual(Array.from(first.cells.palette), [0, 0, 0, 1, 1]);
    assert.equal(first.paletteCount, 2);
    assert.deepEqual(first.paletteValues, second.paletteValues);
    assert.deepEqual(Array.from(first.tileBytes), Array.from(second.tileBytes));
});

test("NES picks the most used color as color 0 unless overridden", () => {
    const art = image(16, 16, (x, y) => (y < 4 ? 0x1f9eff : BLACK));
    const auto = convert(art, { system: "nes" });
    // Black is the canonical $0F, not one of its look-alikes.
    assert.equal(auto.sharedColor, 0x0f);
    assert.deepEqual(Array.from(auto.paletteBytes.subarray(0, 2)), [0x0f, 0x21]);

    // $1D looks like $0F, so black pixels follow the override and stay color 0.
    const black = convert(art, { system: "nes", sharedColor: 0x1d });
    assert.equal(black.sharedColor, 0x1d);
    assert.equal(black.paletteBytes[0], 0x1d);
    assert.equal(black.paletteBytes.length, 4);
    assert.equal(black.tilePixels[4 * 8], 0);

    // A color 0 absent from the art: black becomes an ordinary palette color.
    const white = convert(art, { system: "nes", sharedColor: 0x30 });
    assert.equal(white.sharedColor, 0x30);
    assert.deepEqual(Array.from(white.paletteBytes), [0x30, 0x21, 0x0f, 0x30]);
});

test("packs one NES palette per 16×16 block into the attribute table", () => {
    const sets = [[0x16, 0x27, 0x2a], [0x11, 0x21, 0x31], [0x14, 0x24, 0x34], [0x19, 0x29, 0x39]]
        .map((row) => row.map((color) => vm.runInContext(`NES_PALGEN[${color}]`, context)));
    const art = image(32, 32, (x, y) => (y % 16 === 0 && x % 16 < 3 ? sets[Math.floor(y / 16) * 2 + Math.floor(x / 16)][x % 16] : BLACK));
    const nes = convert(art, { system: "nes" });
    assert.ok(nes.ok);
    assert.equal(nes.paletteCount, 4);
    assert.deepEqual(Array.from(nes.attributes), [0 | 1 << 2 | 2 << 4 | 3 << 6]);
    // Every 8×8 cell of a block reports the block's palette.
    assert.deepEqual(Array.from(nes.cells.palette), [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3]);
});

test("Game Boy orders colors light to dark and builds BGP", () => {
    const four = convert(tileStrip([(x) => [BLACK, GRAY, 0xc0c0c0, WHITE][x & 3]]), { system: "gb" });
    assert.ok(four.ok);
    assert.deepEqual(Array.from(four.tilePixels.subarray(0, 4)), [3, 2, 1, 0]);
    assert.equal(four.bgp, 0xe4);

    // Two colors spread to shades 0 and 3; unused indexes are shade 3.
    const two = convert(tileStrip([(x) => [BLACK, WHITE][x & 1]]), { system: "gb" });
    assert.deepEqual(Array.from(two.paletteValues[0]), [0, 3, 3, 3]);
    assert.equal(two.bgp, 0xfc);

    // Indexed: entry order kept, shades follow each entry's lightness, duplicates share a shade.
    const indexed = convert(indexedImage(8, 8, [BLACK, WHITE, WHITE, GRAY], (x) => x & 3), { system: "gb" });
    assert.deepEqual(Array.from(indexed.paletteValues[0]), [3, 0, 0, 2]);
    assert.equal(indexed.bgp, 3 | 2 << 6);
});

test("GBC reuses flipped tiles through the attribute flip bits; NES and GB don't", () => {
    // An asymmetric tile: one mark in the top-left corner and a stripe.
    const base = (x, y) => (x === 0 && y === 0 ? RED : x === 1 ? GREEN : BLACK);
    const art = tileStrip([base, (x, y) => base(7 - x, y), (x, y) => base(x, 7 - y), (x, y) => base(7 - x, 7 - y)]);
    const gbc = convert(art, { system: "gbc" });
    assert.ok(gbc.ok);
    assert.equal(gbc.tileCount, 1);
    assert.deepEqual(Array.from(gbc.cells.flags), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(gbc.attributes), [0x00, 0x20, 0x40, 0x60]);
    assert.deepEqual(Array.from(gbc.map), [0, 0, 0, 0]);
    assert.equal(convert(art, { system: "gb" }).tileCount, 4);
    assert.equal(convert(art, { system: "nes" }).tileCount, 4);
});

// 257 unique tiles (bit patterns in rows 0-1) that never match each other flipped: only tile corners (7, 7) are red.
function manyTiles(count, cells) {
    const tilesX = 17;
    const tilesY = Math.ceil(cells / tilesX);
    return image(tilesX * 8, tilesY * 8, (x, y) => {
        const cell = Math.floor(y / 8) * tilesX + Math.floor(x / 8);
        const tile = cell < count ? cell : 0;
        const px = x % 8;
        const py = y % 8;
        if (px === 7 && py === 7) return RED;
        const bit = py === 0 ? px : py === 1 ? 8 + px : -1;
        return bit >= 0 && (tile >> bit) & 1 ? WHITE : BLACK;
    });
}

test("GBC sets the VRAM bank bit for tiles above 255", () => {
    const gbc = convert(manyTiles(257, 272), { system: "gbc" });
    assert.ok(gbc.ok, JSON.stringify(gbc.diagnostics));
    assert.equal(gbc.tileCount, 257);
    assert.equal(gbc.cells.tile[256], 256);
    assert.equal(gbc.map[256], 0);
    assert.equal(gbc.attributes[256], 0x08);
    assert.equal(gbc.attributes[255], 0x00);
    assert.equal(gbc.tileBytes.length, 257 * 16);
});

test("rejects too many tiles", () => {
    const nes = convert(manyTiles(257, 272), { system: "nes" });
    assert.deepEqual(codes(nes), ["tile-count"]);
    assert.deepEqual(nes.diagnostics[0].rects, [{ x: (256 % 17) * 8, y: Math.floor(256 / 17) * 8, width: 8, height: 8 }]);
    assert.deepEqual(codes(convert(manyTiles(257, 272), { system: "gb" })), ["tile-count"]);
});

test("transparent pixels flatten to color index 0", () => {
    const gbc = convert(tileStrip([(x) => (x < 4 ? TRANSPARENT : RED)]), { system: "gbc" });
    assert.ok(gbc.ok);
    assert.deepEqual(Array.from(gbc.tilePixels.subarray(0, 8)), [0, 0, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(gbc.paletteValues[0].slice(0, 2)), [0x0000, 0x001f]);

    const nes = convert(image(16, 16, (x) => (x < 12 ? TRANSPARENT : BLACK)), { system: "nes" });
    assert.equal(nes.sharedColor, 0x0f);
    assert.equal(nes.tilePixels.every((value) => value === 0), true);

    const gb = convert(tileStrip([(x) => (x < 4 ? TRANSPARENT : [BLACK, WHITE][x & 1])]), { system: "gb" });
    assert.deepEqual(Array.from(gb.tilePixels.subarray(0, 8)), [0, 0, 0, 0, 1, 0, 1, 0]);

    // Indexed: the transparent entry keeps its own RGB.
    const indexed = convert(indexedImage(8, 8, [0xff00ff, RED], (x) => x & 1, [0, 255]), { system: "gbc" });
    assert.ok(indexed.ok);
    assert.equal(indexed.paletteValues[0][0], 0x7c1f);
});

test("rejects partially transparent pixels", () => {
    const gbc = convert(tileStrip([() => RED, (x) => (x === 3 ? [255, 0, 0, 128] : RED)]), { system: "gbc" });
    assert.deepEqual(codes(gbc), ["partial-alpha"]);
    assert.deepEqual(gbc.diagnostics[0].rects, [{ x: 8, y: 0, width: 8, height: 8 }]);
});

test("reports dimension, color and palette limits", () => {
    const odd = convert(image(12, 8, () => BLACK), { system: "gbc" });
    assert.deepEqual(codes(odd), ["dimensions"]);
    assert.deepEqual(odd.diagnostics[0].rects, [{ x: 8, y: 0, width: 4, height: 8 }]);

    const five = convert(tileStrip([() => BLACK, (x) => [BLACK, WHITE, RED, GREEN, BLUE][x % 5]]), { system: "gbc" });
    assert.deepEqual(codes(five), ["region-colors"]);
    assert.deepEqual(five.diagnostics[0].rects, [{ x: 8, y: 0, width: 8, height: 8 }]);

    // NES: 3 colors plus the shared one per 16×16 block.
    const nesFull = convert(image(16, 16, (x) => [BLACK, BLACK, BLACK, BLACK, RED, GREEN, BLUE, WHITE][x % 8]), { system: "nes" });
    assert.deepEqual(codes(nesFull), ["region-colors"]);

    // Nine tiles with four colors each, none shared: GBC holds eight palettes.
    const nine = tileStrip(Array.from({ length: 9 }, (_, t) => (x) => (t * 16) << 16 | ((x & 3) * 64) << 8));
    const gbc = convert(nine, { system: "gbc" });
    assert.deepEqual(codes(gbc), ["palette-count"]);
    assert.deepEqual(gbc.diagnostics[0].rects, [{ x: 64, y: 0, width: 8, height: 8 }]);

    const gb = convert(tileStrip([(x) => [BLACK, WHITE, RED, GREEN][x & 3], () => BLUE]), { system: "gb" });
    assert.deepEqual(codes(gb), ["image-colors"]);
    // Blue is the most used; white ties with three others and loses on key order, so its tile is outlined.
    assert.deepEqual(gb.diagnostics[0].rects, [{ x: 0, y: 0, width: 8, height: 8 }]);

    // Indexed GB: only entries 0-3 exist.
    assert.deepEqual(codes(convert(indexedImage(8, 8, [BLACK, WHITE, RED, GREEN, BLUE], () => 4), { system: "gb" })), ["palette-count"]);
});

test("downloads only .chr and .pal", () => {
    for (const system of ["nes", "gb", "gbc"]) {
        assert.deepEqual(Array.from(graphicsOutputNames(system, "bg")), ["bg.chr", "bg.pal"]);
    }
    const result = convert(tileStrip([(x) => [BLACK, WHITE][x & 1]]), { system: "gb" });
    assert.deepEqual(graphicsOutputs(result, "bg").map((file) => file.fileName), ["bg.chr", "bg.pal"]);
});

test("writes .chr tiles and .pal palettes as plain binaries", () => {
    const file = (files, extension) => Array.from(files.find((f) => f.fileName.endsWith(extension)).data);

    // NES: tiles padded to a 4 KB pattern table, 16-byte palette with unused palettes as color 0.
    const nes = convert(image(16, 16, (x, y) => (y === 0 ? [0xcf0b00, 0xff8014, 0x28c421][x % 3] : BLACK)), { system: "nes" });
    const nesFiles = graphicsOutputs(nes, "bg");
    const chr = file(nesFiles, ".chr");
    assert.equal(chr.length, 4096);
    assert.deepEqual(chr.slice(0, nes.tileBytes.length), Array.from(nes.tileBytes));
    assert.equal(chr.slice(nes.tileBytes.length).every((byte) => byte === 0), true);
    assert.deepEqual(file(nesFiles, ".pal"), [0x0f, 0x27, 0x2a, 0x16, ...Array(12).fill(0x0f)]);

    // GBC: unpadded tiles; little-endian RGB555 palettes.
    const gbc = convert(tileStrip([(x) => [WHITE, RED, GREEN, BLUE][x & 3]]), { system: "gbc" });
    const gbcFiles = graphicsOutputs(gbc, "bg");
    assert.deepEqual(file(gbcFiles, ".chr"), Array.from(gbc.tileBytes));
    assert.deepEqual(file(gbcFiles, ".pal"), [0xff, 0x7f, 0xe0, 0x03, 0x1f, 0x00, 0x00, 0x7c]);

    // Game Boy: unpadded tiles; .pal is the BGP byte.
    const gb = convert(tileStrip([(x) => [BLACK, WHITE][x & 1]]), { system: "gb" });
    const gbFiles = graphicsOutputs(gb, "bg");
    assert.deepEqual(file(gbFiles, ".chr"), Array.from(gb.tileBytes));
    assert.deepEqual(file(gbFiles, ".pal"), [0xfc]);
});

test("Game Boy Auto Shades groups any colors into the 4 shades by brightness", () => {
    // Eight grays, light to dark across the tile: pairs fall into one shade each.
    const grays = [0xffffff, 0xeeeeee, 0xaaaaaa, 0x999999, 0x555555, 0x444444, 0x111111, 0x000000];
    const art = tileStrip([(x) => grays[x]]);
    assert.deepEqual(codes(convert(art, { system: "gb" })), ["image-colors"]);
    const gb = convert(art, { system: "gb", autoShades: true });
    assert.ok(gb.ok);
    assert.equal(gb.autoShaded, 8);
    assert.deepEqual(Array.from(gb.tilePixels.subarray(0, 8)), [0, 0, 1, 1, 2, 2, 3, 3]);
    assert.equal(gb.bgp, 0xe4);
    // Preview uses the DMG shades.
    assert.deepEqual(Array.from(gb.preview.subarray(0, 4)), [255, 255, 255, 255]);

    // Colors weigh by pixel count: a big dark area keeps its own shades.
    const weighted = convert(image(16, 8, (x, y) => (y < 7 ? [0x000000, 0x101010, 0x202020, 0x303030][x & 3] : [0xffffff, 0xf0f0f0][x & 1])),
        { system: "gb", autoShades: true });
    assert.ok(weighted.ok);
    const darkIndexes = new Set(Array.from(weighted.tilePixels.subarray(0, 56)));
    assert.equal(darkIndexes.size, 3);

    // Art that already fits keeps its exact colors and order.
    const four = tileStrip([(x) => [BLACK, GRAY, 0xc0c0c0, WHITE][x & 3]]);
    const exact = convert(four, { system: "gb", autoShades: true });
    assert.equal(exact.autoShaded, 0);
    assert.deepEqual(Array.from(exact.tileBytes), Array.from(convert(four, { system: "gb" }).tileBytes));

    // Indexed art using entries past 3 converts from its colors.
    const indexed = indexedImage(8, 8, [BLACK, WHITE, RED, GREEN, BLUE, GRAY], (x) => x % 6);
    assert.deepEqual(codes(convert(indexed, { system: "gb" })), ["palette-count", "region-palettes"]);
    const fixed = convert(indexed, { system: "gb", autoShades: true });
    assert.ok(fixed.ok);
    assert.equal(fixed.autoShaded, 6);
    assert.equal(fixed.tilePixels[1], 0);
    assert.equal(fixed.tilePixels[0], 3);
});

test("NES picks the canonical $0F black and $30 white", () => {
    const nes = convert(image(16, 16, (x, y) => (y === 0 && x < 2 ? WHITE : BLACK)), { system: "nes" });
    assert.ok(nes.ok);
    assert.deepEqual(Array.from(nes.paletteBytes), [0x0f, 0x30, 0x0f, 0x0f]);
});

test("NES palette touch-ups recolor entries without touching the tiles", () => {
    const art = image(16, 16, (x, y) => (y === 0 ? [0xcf0b00, 0xff8014, 0x28c421][x % 3] : BLACK));
    const nes = convert(art, { system: "nes" });
    // Palette 0 color 2 to $11, and color 0 (shared) to $01.
    const edited = recolorNesPalettes(nes, new Map([["0:2", 0x11], ["0", 0x01]]));
    assert.deepEqual(Array.from(edited.paletteBytes), [0x01, 0x27, 0x11, 0x16]);
    assert.equal(edited.sharedColor, 0x01);
    assert.deepEqual(Array.from(edited.tileBytes), Array.from(nes.tileBytes));
    const pal = Array.from(graphicsOutputs(edited, "bg").find((f) => f.fileName === "bg.pal").data);
    assert.deepEqual(pal, [0x01, 0x27, 0x11, 0x16, ...Array(12).fill(0x01)]);
    // No edits: the conversion's own palette.
    assert.deepEqual(Array.from(recolorNesPalettes(nes, new Map()).paletteBytes), Array.from(nes.paletteBytes));
});
