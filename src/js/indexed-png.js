"use strict";

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pngCrcTable = createPngCrcTable();

async function encodeIndexedPng(image) {
    const {
        width,
        height,
        totalPaletteColors,
        colorsPerPalette,
        transparentIndexZero,
        paletteData,
        colorIndexes,
    } = image;
    if (totalPaletteColors < 1 || totalPaletteColors > 256) {
        throw new RangeError("Indexed PNG supports at most 256 palette entries");
    }

    const header = new Uint8Array(13);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, width);
    headerView.setUint32(4, height);
    header[8] = 8;
    header[9] = 3;

    const palette = new Uint8Array(totalPaletteColors * 3);
    for (let i = 0; i < totalPaletteColors; i++) {
        palette[i * 3] = paletteData[i * 4 + 2];
        palette[i * 3 + 1] = paletteData[i * 4 + 1];
        palette[i * 3 + 2] = paletteData[i * 4];
    }

    const rowStride = Math.ceil(width / 4) * 4;
    const scanlines = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
        const destination = y * (width + 1);
        const source = (height - 1 - y) * rowStride;
        scanlines[destination] = 0;
        scanlines.set(colorIndexes.subarray(source, source + width), destination + 1);
    }

    const compressed = await compressPngData(scanlines);
    const chunks = [
        pngSignature,
        createPngChunk("IHDR", header),
        createPngChunk("PLTE", palette),
    ];
    if (transparentIndexZero) {
        const transparency = new Uint8Array(totalPaletteColors);
        transparency.fill(255);
        for (let i = 0; i < totalPaletteColors; i += colorsPerPalette) {
            transparency[i] = 0;
        }
        chunks.push(createPngChunk("tRNS", transparency));
    }
    chunks.push(createPngChunk("IDAT", compressed));
    chunks.push(createPngChunk("IEND", new Uint8Array()));
    return concatenatePngBytes(chunks);
}

// Returns palette as RGB triplets, alpha from tRNS (or null) and top-down indexes, one byte per pixel.
async function decodeIndexedPng(bytes) {
    const png = new Uint8Array(bytes);
    if (png.length < 8 || pngSignature.some((value, i) => png[i] !== value)) {
        throw new Error("Not a PNG file");
    }
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let header = null;
    let palette = null;
    let alpha = null;
    const imageData = [];
    let offset = 8;
    while (offset + 8 <= png.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") header = data;
        else if (type === "PLTE") palette = data;
        else if (type === "tRNS") alpha = data;
        else if (type === "IDAT") imageData.push(data);
        else if (type === "IEND") break;
        offset += 12 + length;
    }
    if (header === null || header.length < 13) {
        throw new Error("PNG is missing its IHDR header");
    }
    const headerView = new DataView(header.buffer, header.byteOffset, 13);
    const width = headerView.getUint32(0);
    const height = headerView.getUint32(4);
    const depth = header[8];
    if (header[9] !== 3) {
        throw new Error("PNG must use indexed (palette) color");
    }
    if (header[12] !== 0) {
        throw new Error("Interlaced PNGs are not supported");
    }
    if (![1, 2, 4, 8].includes(depth)) {
        throw new Error(`Unsupported indexed bit depth: ${depth}`);
    }
    if (palette === null) {
        throw new Error("Indexed PNG is missing its PLTE palette");
    }

    const raw = await decompressPngData(concatenatePngBytes(imageData));
    const stride = Math.ceil(width * depth / 8);
    if (raw.length < height * (stride + 1)) {
        throw new Error("PNG image data is truncated");
    }
    const pixelsPerByte = 8 / depth;
    const mask = (1 << depth) - 1;
    const indexes = new Uint8Array(width * height);
    let previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const start = y * (stride + 1);
        const filter = raw[start];
        const line = raw.slice(start + 1, start + 1 + stride);
        for (let x = 0; x < stride; x++) {
            const a = x > 0 ? line[x - 1] : 0;
            const b = previous[x];
            const c = x > 0 ? previous[x - 1] : 0;
            let predictor;
            if (filter === 0) predictor = 0;
            else if (filter === 1) predictor = a;
            else if (filter === 2) predictor = b;
            else if (filter === 3) predictor = (a + b) >> 1;
            else if (filter === 4) predictor = paethPredictor(a, b, c);
            else throw new Error(`Invalid PNG filter type: ${filter}`);
            line[x] = (line[x] + predictor) & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const shift = 8 - depth * (x % pixelsPerByte + 1);
            indexes[y * width + x] = (line[Math.floor(x / pixelsPerByte)] >> shift) & mask;
        }
        previous = line;
    }
    return {
        width,
        height,
        palette: palette.slice(),
        alpha: alpha === null ? null : alpha.slice(),
        indexes,
    };
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

// format: "deflate" (zlib, as in PNG) or "gzip".
async function decompressPngData(data, format = "deflate") {
    const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function compressPngData(data) {
    const stream = new Blob([data])
        .stream()
        .pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createPngChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < type.length; i++) {
        typeBytes[i] = type.charCodeAt(i);
    }
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcData = new Uint8Array(typeBytes.length + data.length);
    crcData.set(typeBytes);
    crcData.set(data, typeBytes.length);
    view.setUint32(data.length + 8, calculatePngCrc(crcData));
    return chunk;
}

function calculatePngCrc(data) {
    let crc = 0xffffffff;
    for (const value of data) {
        crc = pngCrcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createPngCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < table.length; i++) {
        let value = i;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[i] = value >>> 0;
    }
    return table;
}

function concatenatePngBytes(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
