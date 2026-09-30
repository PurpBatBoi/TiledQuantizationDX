const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

function loadEncoder() {
    const context = vm.createContext({
        ArrayBuffer,
        Blob,
        CompressionStream,
        DataView,
        DecompressionStream,
        Response,
        Uint8Array,
    });
    const source = fs.existsSync("src/js/indexed-png.js")
        ? fs.readFileSync("src/js/indexed-png.js", "utf8")
        : "";
    vm.runInContext(source, context);
    return context;
}

function readChunks(png) {
    const chunks = new Map();
    let offset = 8;
    while (offset < png.length) {
        const length = new DataView(
            png.buffer,
            png.byteOffset + offset,
            4,
        ).getUint32(0);
        const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
        const expectedCrc = new DataView(
            png.buffer,
            png.byteOffset + offset + 8 + length,
            4,
        ).getUint32(0);
        assert.equal(
            zlib.crc32(png.subarray(offset + 4, offset + 8 + length)),
            expectedCrc,
            `${type} CRC`,
        );
        chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
    }
    return chunks;
}

test("encodes exact duplicate palette entries, indices, and transparency", async () => {
    const context = loadEncoder();
    context.fixture = {
        width: 2,
        height: 2,
        totalPaletteColors: 4,
        colorsPerPalette: 2,
        transparentIndexZero: true,
        paletteData: new Uint8Array([
            0, 0, 255, 0,
            0, 255, 0, 0,
            0, 0, 255, 0,
            255, 0, 0, 0,
        ]),
        // Worker rows are padded to four bytes and stored bottom-up.
        colorIndexes: new Uint8Array([
            3, 2, 0, 0,
            1, 0, 0, 0,
        ]),
    };

    const encoded = await vm.runInContext("encodeIndexedPng(fixture)", context);
    const png = new Uint8Array(encoded);
    assert.deepEqual(
        Array.from(png.subarray(0, 8)),
        [137, 80, 78, 71, 13, 10, 26, 10],
    );

    const chunks = readChunks(png);
    assert.equal(chunks.get("IHDR")[8], 8);
    assert.equal(chunks.get("IHDR")[9], 3);
    assert.deepEqual(
        Array.from(chunks.get("PLTE")),
        [255, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255],
    );
    assert.deepEqual(Array.from(chunks.get("tRNS")), [0, 255, 0, 255]);
    assert.deepEqual(
        Array.from(zlib.inflateSync(chunks.get("IDAT"))),
        [0, 1, 0, 0, 3, 2],
    );
});

test("rejects palettes larger than the indexed PNG limit", async () => {
    const context = loadEncoder();
    context.fixture = {
        width: 1,
        height: 1,
        totalPaletteColors: 257,
        colorsPerPalette: 257,
        transparentIndexZero: false,
        paletteData: new Uint8Array(1028),
        colorIndexes: new Uint8Array(4),
    };

    await assert.rejects(
        vm.runInContext("encodeIndexedPng(fixture)", context),
        /at most 256 palette entries/,
    );
});

function buildPng(header, chunks) {
    const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
    for (const [type, data] of [["IHDR", header], ...chunks, ["IEND", Buffer.alloc(0)]]) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body));
        parts.push(length, body, crc);
    }
    return new Uint8Array(Buffer.concat(parts));
}

function ihdr(width, height, depth, colorType) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = colorType;
    return header;
}

test("decodes what the encoder writes", async () => {
    const context = loadEncoder();
    context.fixture = {
        width: 2,
        height: 2,
        totalPaletteColors: 4,
        colorsPerPalette: 2,
        transparentIndexZero: true,
        paletteData: new Uint8Array([
            0, 0, 255, 0,
            0, 255, 0, 0,
            0, 0, 255, 0,
            255, 0, 0, 0,
        ]),
        colorIndexes: new Uint8Array([
            3, 2, 0, 0,
            1, 0, 0, 0,
        ]),
    };

    const decoded = await vm.runInContext(
        "encodeIndexedPng(fixture).then(decodeIndexedPng)",
        context,
    );
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    assert.deepEqual(Array.from(decoded.indexes), [1, 0, 3, 2]);
    assert.deepEqual(
        Array.from(decoded.palette),
        [255, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255],
    );
    assert.deepEqual(Array.from(decoded.alpha), [0, 255, 0, 255]);
});

test("decodes packed 2-bit rows with Paeth filtering", async () => {
    const context = loadEncoder();
    // Row 0 raw: 0,1,2,3,1 -> 0x1b 0x40. Row 1 raw: 3,3,3,3,0 -> 0xff 0x00, Paeth-filtered.
    const scanlines = Buffer.from([0, 0x1b, 0x40, 4, 0xe4, 0x01]);
    context.png = buildPng(ihdr(5, 2, 2, 3), [
        ["PLTE", Buffer.alloc(12)],
        ["IDAT", zlib.deflateSync(scanlines)],
    ]);

    const decoded = await vm.runInContext("decodeIndexedPng(png)", context);
    assert.deepEqual(
        Array.from(decoded.indexes),
        [0, 1, 2, 3, 1, 3, 3, 3, 3, 0],
    );
    assert.equal(decoded.alpha, null);
});

test("rejects PNGs that are not indexed", async () => {
    const context = loadEncoder();
    context.png = buildPng(ihdr(1, 1, 8, 2), [
        ["IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0]))],
    ]);

    await assert.rejects(
        vm.runInContext("decodeIndexedPng(png)", context),
        /indexed \(palette\) color/,
    );
});
