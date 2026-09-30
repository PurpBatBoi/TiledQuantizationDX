"use strict";

// NES attribute table export, byte-compatible with NEXXT (see NEXXT_ATTRIBUTE_EXPORT.md).

// attributes: one palette (0-3) per 16×16 block, row-major, blocksX wide.
// Each byte covers 2×2 blocks: top-left in bits 0-1, top-right 2-3, bottom-left 4-5, bottom-right 6-7.
// Blocks past the edge (e.g. below a 30-tile-high screen) are 0.
function packNesAttributes(attributes, blocksX, blocksY) {
    const width = Math.ceil(blocksX / 2);
    const height = Math.ceil(blocksY / 2);
    const bytes = new Uint8Array(width * height);
    const at = (x, y) => (x < blocksX && y < blocksY ? attributes[y * blocksX + x] & 3 : 0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            bytes[y * width + x] = at(2 * x, 2 * y)
                | at(2 * x + 1, 2 * y) << 2
                | at(2 * x, 2 * y + 1) << 4
                | at(2 * x + 1, 2 * y + 1) << 6;
        }
    }
    return { bytes, width, height };
}

// MMC5 extended attributes (ExRAM, $5104 = 1): one byte per 8×8 tile, palette in bits 6-7. Bits 0-5 pick the
// tile's 4 KB CHR page and stay 0 here. Row-major over the whole map (see MMC5_ATTRIBUTE_EXPORT.md).
function packMmc5Attributes(attributes, width, height) {
    const bytes = Uint8Array.from(attributes, (row) => (row & 3) << 6);
    return { bytes, width, height, kind: "MMC5 ExRAM attribute" };
}

// NESlib RLE as NEXXT writes it: tag byte, literals, "value, tag, count-1" for runs of 3+, "tag, 0" at the end.
function encodeNesRle(bytes) {
    const counts = new Array(256).fill(0);
    for (const value of bytes) {
        counts[value]++;
    }
    // Prefer a byte that never occurs; otherwise the least used one (not NESlib-safe, but it's NEXXT's fallback).
    let tag = counts.indexOf(0);
    if (tag < 0) {
        tag = counts.indexOf(Math.min(...counts));
    }
    const out = [tag];
    const writeRun = (value, length) => {
        const literal = value === tag ? [value, 1] : [value];
        out.push(...literal);
        if (length === 2) {
            out.push(...literal);
        }
        else if (length > 2) {
            out.push(tag, length - 1);
        }
    };
    let previous = -1;
    let length = 0;
    for (const value of bytes) {
        if (value !== previous || length >= 255) {
            if (length > 0) {
                writeRun(previous, length);
            }
            previous = value;
            length = 1;
        }
        else {
            length++;
        }
    }
    if (length > 0) {
        writeRun(previous, length);
    }
    out.push(tag, 0);
    return Uint8Array.from(out);
}

// A C/assembler identifier from a file name, e.g. "map_tmx" -> "map_tmx_attr".
function nesAttributeLabel(name) {
    const identifier = name.replace(/[^A-Za-z0-9_]/g, "_");
    return `${/^[0-9]/.test(identifier) ? "_" : ""}${identifier}_attr`;
}

function chunk(bytes, size) {
    const rows = [];
    for (let i = 0; i < bytes.length; i += size) {
        rows.push(Array.from(bytes.subarray(i, i + size)));
    }
    return rows;
}

function cArray(comment, label, bytes, perRow) {
    const rows = chunk(bytes, perRow).map((row, i, all) =>
        `\t${row.map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(",")}${i < all.length - 1 ? "," : ""}`);
    return [comment, `const unsigned char ${label}[${bytes.length}]={`, ...rows, "};", ""].join("\n");
}

// format: "asm-byte", "asm-db", "c" or "c-rle". table comes from packNesAttributes or packMmc5Attributes.
function formatNesAttributes(table, format, label, source) {
    const { bytes, width, height, kind = "attribute" } = table;
    const description = `${bytes.length} ${kind} bytes (${width}x${height})`;
    if (format === "asm-byte" || format === "asm-db") {
        const keyword = format === "asm-byte" ? ".byte" : ".db";
        const rows = chunk(bytes, width).map((row) =>
            `\t${keyword} ${row.map((value) => `$${value.toString(16).padStart(2, "0")}`).join(",")}`);
        return [`; ${description}, from ${source}`, `${label}:`, ...rows, ""].join("\n");
    }
    // C goes in a .c source file (data belongs in sources, headers only declare), so say how to declare it.
    const declare = (name, size) => `// Declare it where it's used: extern const unsigned char ${name}[${size}];`;
    if (format === "c") {
        return cArray(`// ${description}, from ${source}\n${declare(label, bytes.length)}`, label, bytes, width);
    }
    if (format === "c-rle") {
        const packed = encodeNesRle(bytes);
        return cArray(`// ${description}, NESlib RLE packed to ${packed.length}, from ${source}\n${declare(`${label}_rle`, packed.length)}`,
            `${label}_rle`, packed, 16);
    }
    throw new Error(`Unknown attribute format "${format}"`);
}
