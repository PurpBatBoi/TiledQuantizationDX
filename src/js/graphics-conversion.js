"use strict";

// Background tile conversion for NES, Game Boy and Game Boy Color. No DOM: the page, graphics-worker.js and the
// tests all load this file. Needs packNesAttributes from nes-attributes.js.
//
// Provenance (reimplemented, not vendored):
// - NES colors: nespal.py's nearest-color match (squared RGB distance, first match wins) against its bundled
//   palgen.pal, skipping nespal's default invalid colors, except that black is $0F and white $30.
// - Tile packing, first-fit palette merging and GBC attribute bits (palette 0-2, bank 3, H flip 5, V flip 6):
//   GBDK-2020's png2asset.

const GRAPHICS_TILE = 8;

// palgen.pal, 0xRRGGBB per PPU color $00-$3F.
const NES_PALGEN = [
    0x464646, 0x00065a, 0x000678, 0x020673, 0x35034c, 0x57000e, 0x5a0000, 0x410000,
    0x120200, 0x001400, 0x001e00, 0x001e00, 0x001521, 0x000000, 0x000000, 0x000000,
    0x9d9d9d, 0x004ab9, 0x0530e1, 0x5718da, 0x9f07a7, 0xcc0255, 0xcf0b00, 0xa42300,
    0x5c3f00, 0x0b5800, 0x006600, 0x006713, 0x005e6e, 0x000000, 0x000000, 0x000000,
    0xfeffff, 0x1f9eff, 0x5376ff, 0x9865ff, 0xfc67ff, 0xff6cb3, 0xff7466, 0xff8014,
    0xc49a00, 0x71b300, 0x28c421, 0x00c874, 0x00bfd0, 0x2b2b2b, 0x000000, 0x000000,
    0xfeffff, 0x9ed5ff, 0xafc0ff, 0xd0b8ff, 0xfebfff, 0xffc0e0, 0xffc3bd, 0xffca9c,
    0xe7d58b, 0xc5df8e, 0xa6e6a3, 0x94e8c5, 0x92e4eb, 0xa7a7a7, 0x000000, 0x000000,
];
// nespal.py's default --invalid_colors: blacker-than-black $0D and the duplicate blacks.
const NES_INVALID_COLORS = [0x0d, 0x0e, 0x1e, 0x2e, 0x3e, 0x0f, 0x1f, 0x2f, 0x3f];
// Where several PPU colors look identical, these win: black $0F and white $30, the values NES tools expect.
// neslib's pal_bg runs colors through its brightness tables, which turn $1D into $00 and $20 into $10.
const NES_CANONICAL_COLORS = [0x0f, 0x30];
// DMG shades 0 (lightest) to 3, as shown in the preview.
const DMG_SHADES = [0xffffff, 0xaaaaaa, 0x555555, 0x000000];
const TRANSPARENT_KEY = -1;

// block: pixels per palette area. flips: dedupe mirrored tiles through the attribute flip bits.
const GRAPHICS_TARGETS = {
    nes: { name: "NES", block: 16, maxPalettes: 4, maxTiles: 256, flips: false },
    gb: { name: "Game Boy", block: 8, maxPalettes: 1, maxTiles: 256, flips: false },
    gbc: { name: "Game Boy Color", block: 8, maxPalettes: 8, maxTiles: 512, flips: true },
};

const QUANTIZE_HINT = "Reduce the colors with the Palette Quantization tab (index.html) first.";
const GB_HINT = "Turn on Auto Shades, or reduce the colors with the Palette Quantization tab (index.html) first.";
const ATTRIBUTE_HINT = "Fix the palette assignment in the Attribute Editor (attributes.html).";

function luminance(rgb) {
    return ((rgb >> 16) & 255) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114;
}

function nearestNesColor(rgb, preferred) {
    // The first candidate wins a tie, so a forced color 0 beats the canonical colors, which beat the rest.
    const candidates = [];
    if (preferred !== undefined && preferred !== null) candidates.push(preferred);
    candidates.push(...NES_CANONICAL_COLORS);
    for (let i = 0; i < 64; i++) {
        if (!NES_INVALID_COLORS.includes(i)) candidates.push(i);
    }
    let best = candidates[0];
    let bestDistance = Infinity;
    for (const index of candidates) {
        const color = NES_PALGEN[index];
        const dr = ((color >> 16) & 255) - ((rgb >> 16) & 255);
        const dg = ((color >> 8) & 255) - ((rgb >> 8) & 255);
        const db = (color & 255) - (rgb & 255);
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    }
    return best;
}

function toRgb555(rgb) {
    return ((rgb >> 19) & 31) | ((rgb >> 11) & 31) << 5 | ((rgb >> 3) & 31) << 10;
}

function fromRgb555(word) {
    const expand = (value) => (value << 3) | (value >> 2);
    return expand(word & 31) << 16 | expand((word >> 5) & 31) << 8 | expand((word >> 10) & 31);
}

// NES CHR: 8 bytes of bit plane 0, then 8 of plane 1; bit 7 is the leftmost pixel.
function packNesTile(pattern) {
    const bytes = new Uint8Array(16);
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const value = pattern[y * 8 + x];
            bytes[y] |= (value & 1) << (7 - x);
            bytes[y + 8] |= ((value >> 1) & 1) << (7 - x);
        }
    }
    return bytes;
}

// Game Boy 2bpp: each row is its low-bit byte followed by its high-bit byte.
function packGbTile(pattern) {
    const bytes = new Uint8Array(16);
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const value = pattern[y * 8 + x];
            bytes[y * 2] |= (value & 1) << (7 - x);
            bytes[y * 2 + 1] |= ((value >> 1) & 1) << (7 - x);
        }
    }
    return bytes;
}

function flipPattern(pattern, horizontal, vertical) {
    const out = new pattern.constructor(64);
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            out[y * 8 + x] = pattern[(vertical ? 7 - y : y) * 8 + (horizontal ? 7 - x : x)];
        }
    }
    return out;
}

// Scan-order first-fit, as png2asset does, except a set already covered by a palette goes there first.
// ponytail: greedy, can need more palettes than an optimal packing; exact set cover if users hit the limit.
function mergeColorSets(sets, capacity) {
    const palettes = [];
    const assignment = sets.map((set) => {
        if (set.size > capacity) return -1;
        const covering = palettes.findIndex((palette) => [...set].every((key) => palette.has(key)));
        if (covering >= 0) return covering;
        for (let i = 0; i < palettes.length; i++) {
            const merged = new Set([...palettes[i], ...set]);
            if (merged.size <= capacity) {
                palettes[i] = merged;
                return i;
            }
        }
        palettes.push(new Set(set));
        return palettes.length - 1;
    });
    return { palettes, assignment };
}

// Game Boy Auto Shades: splits colors into up to `levels` brightness groups with the least pixel-weighted squared
// error, solved exactly by dynamic programming over the 256 luminance values. counts: Map color -> pixel count.
// Returns each color's group (0 = lightest) and the group count.
function groupByLuminance(counts, levels) {
    const weight = new Float64Array(256);
    const binOf = (rgb) => Math.round(luminance(rgb) / 1000);
    for (const [rgb, count] of counts) weight[binOf(rgb)] += count;
    const bins = [];
    for (let bin = 0; bin < 256; bin++) {
        if (weight[bin] > 0) bins.push(bin);
    }
    const n = bins.length;
    const groups = Math.min(levels, n);
    // Prefix sums of weight, weight × luminance and weight × luminance², for the error of bins i..j-1 in one group.
    const w = [0];
    const s1 = [0];
    const s2 = [0];
    bins.forEach((bin, i) => {
        w.push(w[i] + weight[bin]);
        s1.push(s1[i] + weight[bin] * bin);
        s2.push(s2[i] + weight[bin] * bin * bin);
    });
    const error = (i, j) => s2[j] - s2[i] - (s1[j] - s1[i]) ** 2 / (w[j] - w[i]);
    // best[g][j]: least error of the first j bins in g groups; start[g][j]: where the last of those groups begins.
    const best = [Float64Array.from({ length: n + 1 }, (_, j) => (j === 0 ? 0 : Infinity))];
    const start = [null];
    for (let g = 1; g <= groups; g++) {
        best.push(new Float64Array(n + 1).fill(Infinity));
        start.push(new Int32Array(n + 1));
        for (let j = g; j <= n; j++) {
            for (let i = g - 1; i < j; i++) {
                const total = best[g - 1][i] + error(i, j);
                if (total < best[g][j]) {
                    best[g][j] = total;
                    start[g][j] = i;
                }
            }
        }
    }
    // The last group holds the brightest bins, so it becomes group 0.
    const groupOfBin = new Int32Array(256);
    for (let g = groups, j = n; g > 0; g--) {
        const i = start[g][j];
        for (let t = i; t < j; t++) groupOfBin[bins[t]] = groups - g;
        j = i;
    }
    return { groupOf: (rgb) => groupOfBin[binOf(rgb)], groups };
}

function diagnostic(code, message, hint, rects = []) {
    return { code, message, hint, rects };
}

// input: { width, height, rgba, indexed? } where indexed is decodeIndexedPng's { palette, indexes }.
// options: { system: "nes" | "gb" | "gbc", sharedColor?: NES PPU color overriding the automatic color 0,
// autoShades?: Game Boy art over 4 colors is grouped into the 4 shades by brightness instead of rejected }.
function convertBackgroundAsset(input, options) {
    const system = options.system;
    const target = GRAPHICS_TARGETS[system];
    if (target === undefined) {
        throw new Error(`Unknown target "${system}"`);
    }
    const { width, height, rgba } = input;
    let indexed = input.indexed ?? null;
    const override = system === "nes" && Number.isInteger(options.sharedColor) ? options.sharedColor : null;
    const pixelCount = width * height;
    const block = target.block;
    const blocksX = Math.ceil(width / block);
    const blocksY = Math.ceil(height / block);
    const rectOfBlock = (index) => {
        const x = (index % blocksX) * block;
        const y = Math.floor(index / blocksX) * block;
        return { x, y, width: Math.min(block, width - x), height: Math.min(block, height - y) };
    };

    // Hardware color key per pixel: NES PPU color, source RGB (GB) or RGB555 (GBC). TRANSPARENT_KEY for alpha 0.
    const nesCache = new Map();
    const keyOfRgb = (rgb) => {
        if (system === "gb") return rgb;
        if (system === "gbc") return toRgb555(rgb);
        if (!nesCache.has(rgb)) nesCache.set(rgb, nearestNesColor(rgb, override));
        return nesCache.get(rgb);
    };
    const rgbOfKey = (key) => {
        if (key === TRANSPARENT_KEY) return 0;
        if (system === "nes") return NES_PALGEN[key];
        return system === "gbc" ? fromRgb555(key) : key;
    };
    const keys = new Int32Array(pixelCount);
    const partialAlpha = new Set();
    for (let i = 0; i < pixelCount; i++) {
        const alpha = rgba[i * 4 + 3];
        const rgb = rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2];
        if (alpha > 0 && alpha < 255) {
            partialAlpha.add(Math.floor(i / width / GRAPHICS_TILE) * Math.ceil(width / GRAPHICS_TILE)
                + Math.floor((i % width) / GRAPHICS_TILE));
        }
        if (indexed !== null) {
            const entry = indexed.indexes[i];
            const p = indexed.palette;
            keys[i] = keyOfRgb(entry * 3 + 2 < p.length ? p[entry * 3] << 16 | p[entry * 3 + 1] << 8 | p[entry * 3 + 2] : 0);
        }
        else {
            keys[i] = alpha === 0 ? TRANSPARENT_KEY : keyOfRgb(rgb);
        }
    }

    const result = {
        ok: false,
        system,
        width,
        height,
        tilesX: Math.floor(width / GRAPHICS_TILE),
        tilesY: Math.floor(height / GRAPHICS_TILE),
        diagnostics: [],
        // Game Boy Auto Shades: how many source colors were grouped into the shades (0 when the colors fit).
        autoShaded: 0,
        preview: new Uint8ClampedArray(pixelCount * 4),
    };
    // Until conversion succeeds, the preview shows each pixel's matched hardware color.
    for (let i = 0; i < pixelCount; i++) {
        const rgb = rgbOfKey(keys[i]);
        result.preview.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, rgba[i * 4 + 3]], i * 4);
    }
    const fail = (...found) => {
        result.diagnostics.push(...found);
        return result;
    };

    if (width === 0 || height === 0 || width % GRAPHICS_TILE !== 0 || height % GRAPHICS_TILE !== 0) {
        const rects = [];
        if (width % GRAPHICS_TILE) rects.push({ x: width - width % GRAPHICS_TILE, y: 0, width: width % GRAPHICS_TILE, height });
        if (height % GRAPHICS_TILE) rects.push({ x: 0, y: height - height % GRAPHICS_TILE, width, height: height % GRAPHICS_TILE });
        return fail(diagnostic("dimensions", `Image is ${width}×${height}; width and height must be non-zero multiples of 8.`,
            "Crop or pad the image to whole 8×8 tiles.", rects));
    }
    const tilesX = width / GRAPHICS_TILE;
    const tilesY = height / GRAPHICS_TILE;
    const rectOfTile = (tile) => ({
        x: (tile % tilesX) * GRAPHICS_TILE, y: Math.floor(tile / tilesX) * GRAPHICS_TILE,
        width: GRAPHICS_TILE, height: GRAPHICS_TILE,
    });
    if (partialAlpha.size > 0) {
        return fail(diagnostic("partial-alpha", `${partialAlpha.size} tile(s) contain partially transparent pixels.`,
            "Make every pixel fully opaque or fully transparent.", [...partialAlpha].map(rectOfTile)));
    }

    const blockOfPixel = (i) => Math.floor(i / width / block) * blocksX + Math.floor((i % width) / block);
    const blockPalette = new Uint8Array(blocksX * blocksY);
    const pixelIndex = new Uint8Array(pixelCount);
    // entries[palette] = 4 color keys. GB pads with null (unused, shade 3).
    let entries;
    let sharedColor = null;
    // Auto Shades: the shade of each palette index, when the colors were grouped rather than kept.
    let autoShades = null;
    const autoShadesOn = system === "gb" && options.autoShades === true;
    // Indexed art past entry 3 can't keep its indexes on the Game Boy: Auto Shades converts it from its colors.
    if (autoShadesOn && indexed !== null && indexed.indexes.some((entry) => entry > 3)) {
        indexed = null;
    }

    if (indexed !== null) {
        // Keep the PNG's four-entry groups: group = palette number, entry % 4 = color index.
        const groupsUsed = new Array(blocksX * blocksY).fill(null).map(() => new Set());
        let highestGroup = 0;
        for (let i = 0; i < pixelCount; i++) {
            const entry = indexed.indexes[i];
            pixelIndex[i] = entry & 3;
            // NES color 0 is shared by every palette, so it doesn't tie a block to one.
            if (!(system === "nes" && (entry & 3) === 0)) {
                groupsUsed[blockOfPixel(i)].add(entry >> 2);
            }
            highestGroup = Math.max(highestGroup, entry >> 2);
        }
        const mixed = [];
        const outOfRange = [];
        groupsUsed.forEach((groups, index) => {
            if (groups.size > 1) mixed.push(index);
            if ([...groups].some((group) => group >= target.maxPalettes)) outOfRange.push(index);
            blockPalette[index] = groups.size > 0 ? Math.min(...groups) : 0;
        });
        if (outOfRange.length > 0) {
            result.diagnostics.push(diagnostic("palette-count",
                `${outOfRange.length} area(s) use palette entries past ${target.name}'s ${target.maxPalettes * 4} colors (${target.maxPalettes} palette(s) of 4).`,
                target.maxPalettes === 1 ? GB_HINT : ATTRIBUTE_HINT, outOfRange.map(rectOfBlock)));
        }
        if (mixed.length > 0) {
            result.diagnostics.push(diagnostic("region-palettes",
                `${mixed.length} ${block}×${block} area(s) mix colors from several palettes.`, ATTRIBUTE_HINT,
                mixed.map(rectOfBlock)));
        }
        if (result.diagnostics.length > 0) return result;
        entries = [];
        for (let group = 0; group <= highestGroup; group++) {
            const row = [];
            for (let column = 0; column < 4; column++) {
                const entry = group * 4 + column;
                const p = indexed.palette;
                row.push(entry * 3 + 2 < p.length ? keyOfRgb(p[entry * 3] << 16 | p[entry * 3 + 1] << 8 | p[entry * 3 + 2])
                    : (system === "gb" ? null : 0));
            }
            entries.push(row);
        }
        if (system === "nes") {
            sharedColor = override ?? entries[0][0];
            entries.forEach((row) => { row[0] = sharedColor; });
        }
    }
    else {
        const byLight = (a, b) => luminance(rgbOfKey(b)) - luminance(rgbOfKey(a)) || a - b;
        if (system === "nes") {
            const counts = new Map();
            for (const key of keys) {
                if (key !== TRANSPARENT_KEY) counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            let best = 0x0f;
            let bestCount = 0;
            for (const [key, count] of counts) {
                if (count > bestCount || (count === bestCount && key < best)) {
                    best = key;
                    bestCount = count;
                }
            }
            sharedColor = override ?? best;
            keys.forEach((key, i) => { if (key === TRANSPARENT_KEY) keys[i] = sharedColor; });
        }
        if (system === "gb") {
            const colors = new Map();
            for (const key of keys) {
                if (key !== TRANSPARENT_KEY) colors.set(key, (colors.get(key) ?? 0) + 1);
            }
            if (colors.size > 4 && autoShadesOn) {
                const { groupOf, groups } = groupByLuminance(colors, 4);
                autoShades = Array.from({ length: 4 }, (_, i) => (i >= groups ? 3 : groups === 1 ? 0 : Math.round(i * 3 / (groups - 1))));
                result.autoShaded = colors.size;
                // Each index's palette entry: the pixel-weighted mean color of its group, for reference only.
                const sums = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
                for (const [rgb, count] of colors) {
                    const sum = sums[groupOf(rgb)];
                    sum[0] += ((rgb >> 16) & 255) * count;
                    sum[1] += ((rgb >> 8) & 255) * count;
                    sum[2] += (rgb & 255) * count;
                    sum[3] += count;
                }
                entries = [sums.map(([r, g, b, count]) => (count === 0 ? null
                    : Math.round(r / count) << 16 | Math.round(g / count) << 8 | Math.round(b / count)))];
                keys.forEach((key, i) => { pixelIndex[i] = key === TRANSPARENT_KEY ? 0 : groupOf(key); });
            }
            else if (colors.size > 4) {
                // Outline the tiles holding colors beyond the four most used.
                const kept = new Set([...colors].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4).map(([key]) => key));
                const tiles = new Set();
                keys.forEach((key, i) => {
                    if (key !== TRANSPARENT_KEY && !kept.has(key)) tiles.add(blockOfPixel(i));
                });
                return fail(diagnostic("image-colors", `Image uses ${colors.size} colors; Game Boy backgrounds allow 4.`,
                    GB_HINT, [...tiles].map(rectOfBlock)));
            }
            else {
                const sorted = [...colors.keys()].sort(byLight);
                entries = [[0, 1, 2, 3].map((i) => sorted[i] ?? null)];
                keys.forEach((key, i) => { pixelIndex[i] = key === TRANSPARENT_KEY ? 0 : sorted.indexOf(key); });
            }
        }
        else {
            // NES: 3 colors per 16×16 block besides the shared color 0. GBC: 4 per tile, transparent pinned to index 0.
            const capacity = system === "nes" ? 3 : 4;
            const sets = new Array(blocksX * blocksY).fill(null).map(() => new Set());
            keys.forEach((key, i) => {
                if (!(system === "nes" && key === sharedColor)) sets[blockOfPixel(i)].add(key);
            });
            const overfull = [];
            sets.forEach((set, index) => { if (set.size > capacity) overfull.push(index); });
            if (overfull.length > 0) {
                return fail(diagnostic("region-colors",
                    `${overfull.length} ${block}×${block} area(s) use more than ${system === "nes" ? "3 colors plus the shared color 0" : "4 colors"}.`,
                    QUANTIZE_HINT, overfull.map(rectOfBlock)));
            }
            const { palettes, assignment } = mergeColorSets(sets, capacity);
            if (palettes.length > target.maxPalettes) {
                const extra = [];
                assignment.forEach((palette, index) => { if (palette >= target.maxPalettes) extra.push(index); });
                return fail(diagnostic("palette-count",
                    `Artwork needs ${palettes.length} palettes; ${target.name} backgrounds allow ${target.maxPalettes}.`,
                    QUANTIZE_HINT, extra.map(rectOfBlock)));
            }
            entries = palettes.map((set) => {
                const sorted = [...set].filter((key) => key !== TRANSPARENT_KEY).sort(byLight);
                const row = system === "nes" ? [sharedColor, ...sorted] : [...(set.has(TRANSPARENT_KEY) ? [TRANSPARENT_KEY] : []), ...sorted];
                while (row.length < 4) row.push(system === "nes" ? sharedColor : 0);
                return row;
            });
            blockPalette.set(assignment);
            keys.forEach((key, i) => {
                pixelIndex[i] = system === "nes" && key === sharedColor ? 0 : entries[blockPalette[blockOfPixel(i)]].indexOf(key);
            });
        }
    }

    // Hardware colors and encoded values per palette entry.
    let paletteValues;
    let paletteColors;
    if (system === "gb") {
        const distinct = [...new Set(entries[0].filter((key) => key !== null))]
            .sort((a, b) => luminance(b) - luminance(a) || a - b);
        const shadeOf = (key) => key === null ? 3
            : distinct.length === 1 ? 0 : Math.round(distinct.indexOf(key) * 3 / (distinct.length - 1));
        paletteValues = [autoShades ?? entries[0].map(shadeOf)];
        paletteColors = [paletteValues[0].map((shade) => DMG_SHADES[shade])];
        result.bgp = paletteValues[0].reduce((byte, shade, i) => byte | shade << (i * 2), 0);
    }
    else {
        paletteValues = entries.map((row) => row.map((key) => (key === TRANSPARENT_KEY ? 0 : key)));
        paletteColors = paletteValues.map((row) => row.map((value) => (system === "nes" ? NES_PALGEN[value] : fromRgb555(value))));
    }

    // Deduplicate tiles by their 2bpp pattern: the palette lives in the attributes, so it isn't part of the tile.
    const cellCount = tilesX * tilesY;
    const cells = { tile: new Uint16Array(cellCount), palette: new Uint8Array(cellCount), flags: new Uint8Array(cellCount) };
    const patterns = [];
    const lookup = new Map();
    const patternKey = (pattern) => String.fromCharCode(...pattern);
    const flipOrder = target.flips ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]];
    for (let cell = 0; cell < cellCount; cell++) {
        const left = (cell % tilesX) * GRAPHICS_TILE;
        const top = Math.floor(cell / tilesX) * GRAPHICS_TILE;
        const pattern = new Uint8Array(64);
        for (let y = 0; y < 8; y++) {
            pattern.set(pixelIndex.subarray((top + y) * width + left, (top + y) * width + left + 8), y * 8);
        }
        let tile = -1;
        let flags = 0;
        // A cell equal to tile T mirrored is the cell mirrored back to T, so look up the mirrored cell.
        for (const [h, v] of flipOrder) {
            const found = lookup.get(patternKey(h || v ? flipPattern(pattern, h, v) : pattern));
            if (found !== undefined) {
                tile = found;
                flags = h | v << 1;
                break;
            }
        }
        if (tile < 0) {
            tile = patterns.length;
            patterns.push(pattern);
            lookup.set(patternKey(pattern), tile);
        }
        cells.tile[cell] = tile;
        cells.palette[cell] = blockPalette[blockOfPixel(top * width + left)];
        cells.flags[cell] = flags | (tile > 255 ? 4 : 0);
    }
    if (patterns.length > target.maxTiles) {
        const extra = [];
        cells.tile.forEach((tile, cell) => { if (tile >= target.maxTiles) extra.push(cell); });
        return fail(diagnostic("tile-count", `Artwork needs ${patterns.length} unique tiles; ${target.name} allows ${target.maxTiles}.`,
            "Reuse more identical tiles, or split the artwork into smaller screens.", extra.map(rectOfTile)));
    }

    const pack = system === "nes" ? packNesTile : packGbTile;
    const tileBytes = new Uint8Array(patterns.length * 16);
    const tilePixels = new Uint8Array(patterns.length * 64);
    patterns.forEach((pattern, i) => {
        tileBytes.set(pack(pattern), i * 16);
        tilePixels.set(pattern, i * 64);
    });

    let attributes = null;
    if (system === "nes") {
        attributes = packNesAttributes(blockPalette, blocksX, blocksY).bytes;
    }
    else if (system === "gbc") {
        attributes = Uint8Array.from(cells.palette, (palette, cell) => palette
            | (cells.flags[cell] & 4 ? 0x08 : 0) | (cells.flags[cell] & 1 ? 0x20 : 0) | (cells.flags[cell] & 2 ? 0x40 : 0));
    }

    let paletteBytes = null;
    if (system === "nes") {
        paletteBytes = Uint8Array.from(paletteValues.flat());
    }
    else if (system === "gbc") {
        paletteBytes = new Uint8Array(paletteValues.length * 8);
        paletteValues.flat().forEach((word, i) => {
            paletteBytes[i * 2] = word & 255;
            paletteBytes[i * 2 + 1] = word >> 8;
        });
    }

    for (let i = 0; i < pixelCount; i++) {
        const rgb = paletteColors[blockPalette[blockOfPixel(i)]][pixelIndex[i]];
        result.preview.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255], i * 4);
    }
    return Object.assign(result, {
        ok: true,
        sharedColor,
        paletteValues,
        paletteColors,
        paletteBytes,
        tilePixels,
        tileBytes,
        map: Uint8Array.from(cells.tile, (tile) => tile & 255),
        attributes,
        cells,
        tileCount: patterns.length,
        paletteCount: paletteValues.length,
    });
}

// Tile Compression: no palette or hardware color limits. Tiles are compared by their RGBA pixels. With a tolerance, a
// tile reuses the first earlier tile within it (like platforms' tileset extractor). Then, when there are more unique
// tiles than targetTiles, the most-used ones (scan order breaking ties) are kept and every other cell is redrawn with
// its closest kept tile. options: { targetTiles, flips?: also match mirrored tiles,
// tolerance?: allowed mean absolute difference per RGBA channel (0-255) for reusing a tile,
// important?: per-cell flags; flagged cells are never approximated by tolerance and their tiles are kept first }.
function compressTiles(input, options) {
    const { width, height, rgba } = input;
    const result = { ok: false, width, height, diagnostics: [] };
    if (width === 0 || height === 0 || width % GRAPHICS_TILE !== 0 || height % GRAPHICS_TILE !== 0) {
        result.diagnostics.push(diagnostic("dimensions", `Image is ${width}×${height}; width and height must be non-zero multiples of 8.`,
            "Crop or pad the image to whole 8×8 tiles."));
        return result;
    }
    const tilesX = width / GRAPHICS_TILE;
    const cellCount = tilesX * (height / GRAPHICS_TILE);
    const flipOrder = options.flips ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]];
    const pixelAt = (i) => (rgba[i * 4] << 24 | rgba[i * 4 + 1] << 16 | rgba[i * 4 + 2] << 8 | rgba[i * 4 + 3]) >>> 0;
    const patternKey = (pattern) => pattern.join();
    const toleranceSum = Math.max(0, options.tolerance ?? 0) * 64 * 4;
    // Summed absolute RGBA difference between a and b mirrored, stopping early once past the tolerance.
    const withinTolerance = (a, b, h, v) => {
        let difference = 0;
        for (let p = 0; p < 64; p++) {
            const other = b[(v ? 7 - (p >> 3) : p >> 3) * 8 + (h ? 7 - (p & 7) : p & 7)];
            for (let shift = 0; shift < 32; shift += 8) {
                difference += Math.abs(((a[p] >>> shift) & 255) - ((other >>> shift) & 255));
            }
            if (difference > toleranceSum) return false;
        }
        return true;
    };

    // Exact deduplication, mirrored matches included when flips are allowed, then the tolerance search.
    const patterns = [];
    const lookup = new Map();
    // ponytail: first-fit scan over every earlier tile per new pattern, O(cells × tiles); add a coarse bucket index if large images get slow.
    const approximate = new Map();
    const cellTile = new Uint32Array(cellCount);
    const cellFlags = new Uint8Array(cellCount);
    for (let cell = 0; cell < cellCount; cell++) {
        const left = (cell % tilesX) * GRAPHICS_TILE;
        const top = Math.floor(cell / tilesX) * GRAPHICS_TILE;
        const pattern = new Uint32Array(64);
        for (let p = 0; p < 64; p++) pattern[p] = pixelAt((top + (p >> 3)) * width + left + (p & 7));
        let tile = -1;
        for (const [h, v] of flipOrder) {
            const found = lookup.get(patternKey(h || v ? flipPattern(pattern, h, v) : pattern));
            if (found !== undefined) {
                tile = found;
                cellFlags[cell] = h | v << 1;
                break;
            }
        }
        if (tile < 0 && toleranceSum > 0 && !options.important?.[cell]) {
            const key = patternKey(pattern);
            let found = approximate.get(key);
            if (found === undefined) {
                found = null;
                search: for (let t = 0; t < patterns.length; t++) {
                    for (const [h, v] of flipOrder) {
                        if (withinTolerance(pattern, patterns[t], h, v)) {
                            found = { tile: t, flags: h | v << 1 };
                            break search;
                        }
                    }
                }
                approximate.set(key, found);
            }
            if (found !== null) {
                tile = found.tile;
                cellFlags[cell] = found.flags;
            }
        }
        if (tile < 0) {
            tile = patterns.length;
            patterns.push(pattern);
            lookup.set(patternKey(pattern), tile);
        }
        cellTile[cell] = tile;
    }

    const targetTiles = Math.max(1, Math.floor(options.targetTiles));
    const originalTileCount = patterns.length + [...approximate.values()].filter((found) => found !== null).length;
    // Tiles of cells marked with the Keep brush are kept before any other.
    const marked = new Uint8Array(patterns.length);
    if (options.important) cellTile.forEach((tile, cell) => { if (options.important[cell]) marked[tile] = 1; });
    const markedTiles = marked.reduce((sum, value) => sum + value, 0);
    let kept = patterns;
    if (patterns.length > targetTiles) {
        const uses = new Uint32Array(patterns.length);
        cellTile.forEach((tile) => { uses[tile]++; });
        const retained = patterns.map((_, tile) => tile)
            .sort((a, b) => marked[b] - marked[a] || uses[b] - uses[a] || a - b)
            .slice(0, targetTiles);
        kept = retained.map((tile) => patterns[tile]);
        const errorBetween = (a, b) => {
            let error = 0;
            for (let p = 0; p < 64; p++) {
                for (let shift = 0; shift < 32; shift += 8) {
                    const d = ((a[p] >>> shift) & 255) - ((b[p] >>> shift) & 255);
                    error += d * d;
                }
            }
            return error;
        };
        // Closest kept tile per unique tile. Mirroring commutes, so a cell's flags compose with the match's by XOR.
        const match = patterns.map(() => null);
        retained.forEach((tile, index) => { match[tile] = { tile: index, flags: 0, error: 0 }; });
        cellTile.forEach((oldTile, cell) => {
            if (match[oldTile] === null) {
                let best = { tile: 0, flags: 0, error: Infinity };
                kept.forEach((candidate, tile) => {
                    for (const [h, v] of flipOrder) {
                        const error = errorBetween(patterns[oldTile], h || v ? flipPattern(candidate, h, v) : candidate);
                        if (error < best.error) best = { tile, flags: h | v << 1, error };
                    }
                });
                match[oldTile] = best;
            }
            const found = match[oldTile];
            cellTile[cell] = found.tile;
            cellFlags[cell] ^= found.flags;
        });
    }

    // Substitutions and error are measured on the rebuilt image, so both passes count.
    const preview = new Uint8ClampedArray(width * height * 4);
    let substitutions = 0;
    let totalSquaredError = 0;
    cellTile.forEach((tile, cell) => {
        const left = (cell % tilesX) * GRAPHICS_TILE;
        const top = Math.floor(cell / tilesX) * GRAPHICS_TILE;
        const flags = cellFlags[cell];
        const pattern = kept[tile];
        let cellError = 0;
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const value = pattern[(flags & 2 ? 7 - y : y) * 8 + (flags & 1 ? 7 - x : x)];
                const i = ((top + y) * width + left + x) * 4;
                preview.set([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255], i);
                for (let c = 0; c < 4; c++) cellError += (preview[i + c] - rgba[i + c]) ** 2;
            }
        }
        if (cellError > 0) substitutions++;
        totalSquaredError += cellError;
    });
    return Object.assign(result, {
        ok: true,
        preview,
        originalTileCount,
        markedTiles,
        tileCount: kept.length,
        substitutions,
        meanSquaredError: totalSquaredError / (width * height * 4),
    });
}

// NES touch-up after conversion: recolor palette entries without touching the tiles, which keep their indexes.
// edits: Map "palette:index" -> PPU color, with color 0 (shared by every palette) keyed "0".
function recolorNesPalettes(result, edits) {
    const sharedColor = edits.get("0") ?? result.sharedColor;
    const paletteValues = result.paletteValues.map((row, p) =>
        row.map((value, i) => (i === 0 ? sharedColor : edits.get(`${p}:${i}`) ?? value)));
    return {
        ...result,
        sharedColor,
        paletteValues,
        paletteColors: paletteValues.map((row) => row.map((value) => NES_PALGEN[value])),
        paletteBytes: Uint8Array.from(paletteValues.flat()),
    };
}

// Downloads are graphics only, as plain binaries: <name>.chr (tiles) and <name>.pal (palettes). Known before
// conversion, so the page can list them disabled.
function graphicsOutputNames(system, name) {
    return [`${name}.chr`, `${name}.pal`];
}

// .chr: the tiles alone. NES pads to a full 4 KB pattern table (256 tiles), the size NEXXT and YYCHR load as one
// table; Game Boy tiles stay unpadded 2bpp, ready to copy to VRAM.
// .pal: NES is NEXXT's 16-byte background palette (4 palettes of 4 PPU colors, unused ones filled with color 0);
// Game Boy is the 1-byte BGP register value; GBC is rgbgfx's .pal, the used palettes as little-endian RGB555.
function graphicsOutputs(result, name) {
    let chr = result.tileBytes.slice();
    let pal;
    if (result.system === "nes") {
        chr = new Uint8Array(4096);
        chr.set(result.tileBytes);
        pal = new Uint8Array(16).fill(result.sharedColor);
        pal.set(result.paletteBytes);
    }
    else {
        pal = result.system === "gb" ? Uint8Array.of(result.bgp) : result.paletteBytes.slice();
    }
    return [{ fileName: `${name}.chr`, data: chr }, { fileName: `${name}.pal`, data: pal }];
}
