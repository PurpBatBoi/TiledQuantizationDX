"use strict";

// GBC BG map attribute export (see GBC_ATTRIBUTE_EXPORT.md). Uses chunk/cArray from nes-attributes.js and
// the codecs from gb-compression.js.

// Compressed C formats, GBDK only since GBDK ships the decompressors: format -> [name, symbol suffix, compress,
// how to unpack]. gb-compression.js also has PB8/PB16, left out here: they're made for 2bpp tile data.
const GBC_COMPRESSED_FORMATS = {
    "c-rle": ["GBDK RLE", "_rle", compressGbdkRle, "rle_init() then rle_decompress() (gbdk/rledecompress.h)"],
    "c-gb": ["GBDK GB (GBTD)", "_gb", compressGbdkGb, "gb_decompress() (gb/gbdecompress.h)"],
    "c-zx0": ["GBDK ZX0", "_zx0", compressZx0, "zx0_decompress() (gbdk/zx0decompress.h)"],
};

function hexRows(bytes, width, prefix, byteFormat) {
    return chunk(bytes, width).map((row) => `\t${prefix} ${row.map(byteFormat).join(",")}`);
}

// attributes: one palette (0-7) per 8×8 tile, row-major, width tiles wide. priority (optional): one 0/1 flag per
// tile, written as bit 7. Flip and bank stay 0 (the build tools own those), so without priority the bytes equal
// rgbgfx's attrmap and png2asset's `_map_attributes` with -keep_palette_order -noflip.
// format: "bin", "c" (a .c source with the data), "c-rle" / "c-gb" / "c-zx0" (compressed .c), "asm-gbdk"
// (sdas, GBDK's assembler) or "asm-rgbds". Returns a Uint8Array for "bin", text otherwise.
function formatGbcAttributes(attributes, width, format, label, source, priority) {
    const bytes = Uint8Array.from(attributes, (row, i) => (row & 7) | (priority?.[i] ? 0x80 : 0));
    const height = bytes.length / width;
    const description = `${bytes.length} GBC BG attributes (${width}x${height} tiles)`;
    const declare = (symbol, size) => `extern const unsigned char ${symbol}[${size}];`;
    if (format === "bin") {
        return bytes;
    }
    if (format === "c") {
        return cArray(`// ${description}, from ${source}\n// Declare it where it's used: ${declare(label, bytes.length)}`,
            label, bytes, width);
    }
    if (format in GBC_COMPRESSED_FORMATS) {
        const [name, suffix, compress, unpack] = GBC_COMPRESSED_FORMATS[format];
        const packed = compress(bytes);
        return cArray([`${description}, ${name} packed to ${packed.length}, from ${source}`, `Unpack with ${unpack}`,
            `Declare it where it's used: ${declare(label + suffix, packed.length)}`].map((line) => `// ${line}`).join("\n"),
        label + suffix, packed, 16);
    }
    if (format === "asm-gbdk") {
        // C sees the sdas label _name as name; "::" makes it global.
        return [`; ${description}, from ${source}`, `; Declare it in C: ${declare(label, bytes.length)}`,
            `\t.module ${label}`, "\t.area _CODE", `_${label}::`,
            ...hexRows(bytes, width, ".db", (value) => `0x${value.toString(16).padStart(2, "0")}`), ""].join("\n");
    }
    if (format === "asm-rgbds") {
        return [`; ${description}, from ${source}`, `${label}:`,
            ...hexRows(bytes, width, "db", (value) => `$${value.toString(16).padStart(2, "0")}`), ""].join("\n");
    }
    throw new Error(`Unknown attribute format "${format}"`);
}
