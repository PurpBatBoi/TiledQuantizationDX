const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadGbcAttributes() {
    const context = vm.createContext({ Uint8Array, Int32Array });
    for (const file of ["nes-attributes", "gb-compression", "gbc-attributes"]) {
        vm.runInContext(fs.readFileSync(`src/js/${file}.js`, "utf8"), context);
    }
    return context;
}

// A 4×2-tile image painted with rows 0 3 5 7 / 1 2 6 4. png2asset -keep_palette_order -noflip writes
// exactly these bytes as _map_attributes, and rgbgfx -c gbc:<pal> -a as the attrmap (GBC_ATTRIBUTE_EXPORT.md 7.1).
const painted = [0, 3, 5, 7, 1, 2, 6, 4];

test("binary is one palette byte per tile, other bits clear", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    const bytes = formatGbcAttributes([...painted.slice(0, 7), 0xfc], 4, "bin", "x_attr", "x.png");
    assert.deepEqual(Array.from(bytes), [0x00, 0x03, 0x05, 0x07, 0x01, 0x02, 0x06, 0x04]);
});

test("priority tiles set bit 7 on top of the palette", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    const bytes = formatGbcAttributes(painted, 4, "bin", "x_attr", "x.png", [1, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual(Array.from(bytes), [0x80, 0x03, 0x05, 0x87, 0x01, 0x02, 0x06, 0x84]);
});

test("C is a source file with the data and the extern line to declare it", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    assert.equal(formatGbcAttributes(painted, 4, "c", "flip_attr", "flip.png"), [
        "// 8 GBC BG attributes (4x2 tiles), from flip.png",
        "// Declare it where it's used: extern const unsigned char flip_attr[8];",
        "const unsigned char flip_attr[8]={",
        "\t0x00,0x03,0x05,0x07,",
        "\t0x01,0x02,0x06,0x04",
        "};",
        "",
    ].join("\n"));
});

test("GBDK asm uses sdas syntax: 0x bytes and a global _label", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    assert.equal(formatGbcAttributes(painted, 4, "asm-gbdk", "flip_attr", "flip.png"), [
        "; 8 GBC BG attributes (4x2 tiles), from flip.png",
        "; Declare it in C: extern const unsigned char flip_attr[8];",
        "\t.module flip_attr",
        "\t.area _CODE",
        "_flip_attr::",
        "\t.db 0x00,0x03,0x05,0x07",
        "\t.db 0x01,0x02,0x06,0x04",
        "",
    ].join("\n"));
});

test("RGBDS asm has a label and one db line per tile row", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    assert.equal(formatGbcAttributes(painted, 4, "asm-rgbds", "flip_attr", "flip.png"), [
        "; 8 GBC BG attributes (4x2 tiles), from flip.png",
        "flip_attr:",
        "\tdb $00,$03,$05,$07",
        "\tdb $01,$02,$06,$04",
        "",
    ].join("\n"));
});

test("C + RLE packs the bytes, renames the symbol and says how to unpack", () => {
    const { formatGbcAttributes } = loadGbcAttributes();
    const rows = [4, 4, 0, 1, 2, 3, 3, 3, 6, 6, 6, 6, 1, 0, 0, 0];  // 4 tiles wide, 4 high
    assert.equal(formatGbcAttributes(rows, 4, "c-rle", "x_attr", "x.png"), [
        "// 16 GBC BG attributes (4x4 tiles), GBDK RLE packed to 15, from x.png",
        "// Unpack with rle_init() then rle_decompress() (gbdk/rledecompress.h)",
        "// Declare it where it's used: extern const unsigned char x_attr_rle[15];",
        "const unsigned char x_attr_rle[15]={",
        "\t0x05,0x04,0x04,0x00,0x01,0x02,0xfd,0x03,0xfc,0x06,0x01,0x01,0xfd,0x00,0x00",  // gbcompress --alg=rle
        "};",
        "",
    ].join("\n"));
});
