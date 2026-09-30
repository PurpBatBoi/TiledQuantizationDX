const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

function loadTiledMapScripts() {
    const context = vm.createContext({
        ArrayBuffer,
        Blob,
        CompressionStream,
        DataView,
        DecompressionStream,
        Response,
        Uint8Array,
        Uint32Array,
        atob,
    });
    vm.runInContext(fs.readFileSync("src/js/indexed-png.js", "utf8"), context);
    vm.runInContext(fs.readFileSync("src/js/tiled-map.js", "utf8"), context);
    return context;
}

// 16×8 tileset with two 8×8 tiles: tile 1 pixel (x, y) = y * 8 + x, tile 2 = 64 + y * 8 + x.
async function tilesetPng(context) {
    const width = 16;
    const height = 8;
    const colorIndexes = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Encoder rows are bottom-up.
            colorIndexes[(height - 1 - y) * width + x] = (x >= 8 ? 64 : 0) + y * 8 + (x % 8);
        }
    }
    context.fixture = {
        width,
        height,
        totalPaletteColors: 128,
        colorsPerPalette: 4,
        transparentIndexZero: false,
        paletteData: new Uint8Array(128 * 4),
        colorIndexes,
    };
    return new File([await vm.runInContext("encodeIndexedPng(fixture)", context)], "tiles.png");
}

function tmj(layers, tilesets) {
    return new File([JSON.stringify({
        width: 2,
        height: 2,
        tilewidth: 8,
        tileheight: 8,
        infinite: false,
        tilesets: tilesets ?? [{
            firstgid: 1,
            image: "art/tiles.png",
            tilewidth: 8,
            tileheight: 8,
            columns: 2,
            tilecount: 2,
        }],
        layers,
    })], "map.tmj");
}

async function load(context, mapFile, extraFiles = []) {
    const files = [await tilesetPng(context), ...extraFiles];
    context.mapFile = mapFile;
    context.files = new Map(files.map((file) => [file.name.toLowerCase(), file]));
    return vm.runInContext("loadTiledMap(mapFile, files)", context);
}

function flatten(context, map, layerIndex = 0) {
    context.map = map;
    context.layerIndex = layerIndex;
    return vm.runInContext("flattenLayer(map, map.layers[layerIndex])", context);
}

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;

test("flattens a layer, applying Tiled flip flags", async () => {
    const context = loadTiledMapScripts();
    const map = await load(context, tmj([{
        type: "tilelayer",
        name: "BG",
        data: [1, (2 | FLIP_H) >>> 0, (1 | FLIP_V) >>> 0, (1 | FLIP_D) >>> 0],
    }]));
    const image = flatten(context, map);
    const pixel = (x, y) => image.indexes[y * image.width + x];

    assert.equal(image.width, 16);
    assert.equal(image.height, 16);
    assert.equal(pixel(3, 2), 2 * 8 + 3);
    assert.equal(pixel(8 + 3, 2), 64 + 2 * 8 + (7 - 3));
    assert.equal(pixel(3, 8 + 2), (7 - 2) * 8 + 3);
    assert.equal(pixel(8 + 3, 8 + 2), 3 * 8 + 2);
});

test("decodes base64 zlib layers and names layers inside groups", async () => {
    const context = loadTiledMapScripts();
    const gids = Buffer.alloc(16);
    [2, 0, 0, 1].forEach((gid, i) => gids.writeUInt32LE(gid, i * 4));
    const map = await load(context, tmj([
        {
            type: "group",
            name: "World",
            layers: [{
                type: "tilelayer",
                name: "BG",
                encoding: "base64",
                compression: "zlib",
                data: zlib.deflateSync(gids).toString("base64"),
            }],
        },
        { type: "tilelayer", name: "Top", data: [0, 0, 0, 0] },
    ]));

    assert.deepEqual(Array.from(map.layers, (layer) => layer.name), ["World/BG", "Top"]);
    assert.deepEqual(Array.from(map.layers[0].gids), [2, 0, 0, 1]);
    const image = flatten(context, map);
    assert.equal(image.indexes[0], 64);
    assert.equal(image.indexes[8 * 16 + 8], 0);
});

test("loads external .tsj tilesets and reports missing files by name", async () => {
    const context = loadTiledMapScripts();
    const layers = [{ type: "tilelayer", name: "BG", data: [2, 0, 0, 0] }];
    const tilesets = [{ firstgid: 1, source: "sets/tiles.tsj" }];
    const tileset = new File([JSON.stringify({
        image: "tiles.png",
        tilewidth: 8,
        tileheight: 8,
        columns: 2,
        tilecount: 2,
    })], "tiles.tsj");

    const map = await load(context, tmj(layers, tilesets), [tileset]);
    assert.equal(flatten(context, map).indexes[0], 64);
    await assert.rejects(load(context, tmj(layers, tilesets)), /Missing "tiles\.tsj"/);
});

test("rejects tilesets whose tile size differs from the map", async () => {
    const context = loadTiledMapScripts();
    const tilesets = [{ firstgid: 1, image: "tiles.png", tilewidth: 16, tileheight: 16, columns: 1, tilecount: 1 }];
    await assert.rejects(
        load(context, tmj([{ type: "tilelayer", name: "BG", data: [0, 0, 0, 0] }], tilesets)),
        /uses 16×16 tiles, but the map uses 8×8/,
    );
});
