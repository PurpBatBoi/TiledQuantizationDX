const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadNesAttributes() {
    const context = vm.createContext({ Uint8Array });
    vm.runInContext(fs.readFileSync("src/js/nes-attributes.js", "utf8"), context);
    return context;
}

// The SPECIAL-1A example scene exported from NEXXT: one palette per 16×16 block (16×15 blocks).
const sceneBlocks = [
    "1111111111111111",
    "1111111111111111",
    "1111111111111111",
    "1111211111122111",
    "1111221111222211",
    "1111122122222211",
    "1122221111222111",
    "1122221112333111",
    "3322223333303330",
    "3333333333333300",
    "0333333333333000",
    "0333333333330000",
    "0033333333303300",
    "0003333333333330",
    "0000003330333030",
];

// NEXXT "Copy Attributes as text > ASM code" for that scene.
const nexxtBytes = [
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
    0x55, 0x55, 0x65, 0x55, 0x55, 0x95, 0x65, 0x55,
    0x55, 0x55, 0x9a, 0x65, 0xa5, 0xaa, 0xaa, 0x55,
    0x55, 0xaa, 0xaa, 0x55, 0x95, 0xfa, 0x76, 0x55,
    0xff, 0xfa, 0xfa, 0xff, 0xff, 0xf3, 0xff, 0x03,
    0xcc, 0xff, 0xff, 0xff, 0xff, 0xff, 0x03, 0x00,
    0x00, 0xcf, 0xff, 0xff, 0xff, 0xf3, 0xff, 0x30,
    0x00, 0x00, 0x00, 0x0f, 0x03, 0x0f, 0x03, 0x03,
];

// NEXXT "C code with RLE" for that scene.
const nexxtRle = [
    0x01, 0x55, 0x01, 0x09, 0x65, 0x55, 0x55, 0x95, 0x65, 0x55, 0x01, 0x02, 0x9a, 0x65, 0xa5, 0xaa,
    0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x95, 0xfa, 0x76, 0x55, 0xff, 0xfa, 0xfa, 0xff, 0xff, 0xf3,
    0xff, 0x03, 0xcc, 0xff, 0x01, 0x04, 0x03, 0x00, 0x00, 0xcf, 0xff, 0x01, 0x02, 0xf3, 0xff, 0x30,
    0x00, 0x01, 0x02, 0x0f, 0x03, 0x0f, 0x03, 0x03, 0x01, 0x00,
];

function packScene(context) {
    context.blocks = Uint8Array.from(sceneBlocks.join(""), Number);
    return vm.runInContext("packNesAttributes(blocks, 16, 15)", context);
}

test("packs the example scene to NEXXT's attribute bytes", () => {
    const table = packScene(loadNesAttributes());
    assert.equal(table.width, 8);
    assert.equal(table.height, 8);
    assert.deepEqual(Array.from(table.bytes), nexxtBytes);
});

test("RLE-encodes like NEXXT", () => {
    const context = loadNesAttributes();
    context.bytes = Uint8Array.from(nexxtBytes);
    assert.deepEqual(Array.from(vm.runInContext("encodeNesRle(bytes)", context)), nexxtRle);
});

test("fills quadrants past the edge with palette 0", () => {
    const context = loadNesAttributes();
    // 3×3 blocks (48×48 px), all palette 3: the right column and bottom row of bytes are half outside.
    context.blocks = new Uint8Array(9).fill(3);
    const table = vm.runInContext("packNesAttributes(blocks, 3, 3)", context);
    assert.equal(table.width, 2);
    assert.equal(table.height, 2);
    assert.deepEqual(Array.from(table.bytes), [0xff, 0x33, 0x0f, 0x03]);
});

test("formats ASM, C and C+RLE text without NEXXT's quirks", () => {
    const context = loadNesAttributes();
    context.table = packScene(context);
    const format = (name) => vm.runInContext(`formatNesAttributes(table, "${name}", "map_tmx_attr", "map_tmx.tmx")`, context);

    const asm = format("asm-byte").split("\n");
    assert.equal(asm[0], "; 64 attribute bytes (8x8), from map_tmx.tmx");
    assert.equal(asm[1], "map_tmx_attr:");
    assert.equal(asm[2], "\t.byte $55,$55,$55,$55,$55,$55,$55,$55");
    assert.equal(asm[9], "\t.byte $00,$00,$00,$0f,$03,$0f,$03,$03");
    assert.equal(format("asm-db").split("\n")[3], "\t.db $55,$55,$65,$55,$55,$95,$65,$55");

    const c = format("c").split("\n");
    assert.equal(c[1], "// Declare it where it's used: extern const unsigned char map_tmx_attr[64];");
    assert.equal(c[2], "const unsigned char map_tmx_attr[64]={");
    assert.equal(c[3], "\t0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,");
    assert.equal(c[10], "\t0x00,0x00,0x00,0x0f,0x03,0x0f,0x03,0x03");
    assert.equal(c[11], "};");

    const rle = format("c-rle").split("\n");
    assert.equal(rle[0], "// 64 attribute bytes (8x8), NESlib RLE packed to 58, from map_tmx.tmx");
    assert.equal(rle[1], "// Declare it where it's used: extern const unsigned char map_tmx_attr_rle[58];");
    assert.equal(rle[2], "const unsigned char map_tmx_attr_rle[58]={");
    assert.equal(rle[3], "\t0x01,0x55,0x01,0x09,0x65,0x55,0x55,0x95,0x65,0x55,0x01,0x02,0x9a,0x65,0xa5,0xaa,");
    assert.equal(rle[6], "\t0x00,0x01,0x02,0x0f,0x03,0x0f,0x03,0x03,0x01,0x00");
});

test("builds identifiers from file names", () => {
    const context = loadNesAttributes();
    assert.equal(vm.runInContext('nesAttributeLabel("map_tmx")', context), "map_tmx_attr");
    assert.equal(vm.runInContext('nesAttributeLabel("1-level map_Tile Layer 2")', context), "_1_level_map_Tile_Layer_2_attr");
});

test("MMC5 ExRAM puts each 8x8 tile's palette in bits 6-7, one row per tile row", () => {
    const context = loadNesAttributes();
    // 4x2 tiles: palettes that differ inside what would be one 16x16 block.
    context.tiles = Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0]);
    context.table = vm.runInContext("packMmc5Attributes(tiles, 4, 2)", context);
    assert.deepEqual(Array.from(context.table.bytes), [0x00, 0x40, 0x80, 0xc0, 0xc0, 0x80, 0x40, 0x00]);
    assert.equal(vm.runInContext('formatNesAttributes(table, "c", "map_tmx_attr_mmc5", "map_tmx.tmx")', context), [
        "// 8 MMC5 ExRAM attribute bytes (4x2), from map_tmx.tmx",
        "// Declare it where it's used: extern const unsigned char map_tmx_attr_mmc5[8];",
        "const unsigned char map_tmx_attr_mmc5[8]={",
        "\t0x00,0x40,0x80,0xc0,",
        "\t0xc0,0x80,0x40,0x00",
        "};",
        "",
    ].join("\n"));
});
