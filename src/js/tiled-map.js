"use strict";

// Reads Tiled maps (.tmx/.tmj) and flattens one tile layer into an indexed image.
// Tilesets (.tsx/.tsj or inline) must use indexed PNGs that all share one palette.

const TILED_FLIP_H = 0x80000000;
const TILED_FLIP_V = 0x40000000;
const TILED_FLIP_D = 0x20000000;
const TILED_GID_MASK = 0x0fffffff;

function tiledBaseName(path) {
    return path.split(/[\\/]/).pop();
}

// Browsers can't follow the relative paths inside a map, so referenced files are matched by name among the selected ones.
function findTiledFile(files, path) {
    const file = files.get(tiledBaseName(path).toLowerCase());
    if (file === undefined) {
        throw new Error(`Missing "${tiledBaseName(path)}" — select it together with the map (map, tileset and image files).`);
    }
    return file;
}

function parseTiledXml(text, fileName) {
    const document = new DOMParser().parseFromString(text, "application/xml");
    if (document.querySelector("parsererror") !== null) {
        throw new Error(`${fileName} is not valid XML`);
    }
    return document.documentElement;
}

function tiledNumber(element, name, fallback = 0) {
    const value = element.getAttribute(name);
    return value === null ? fallback : Number(value);
}

function readTmx(root) {
    const map = {
        width: tiledNumber(root, "width"),
        height: tiledNumber(root, "height"),
        tileWidth: tiledNumber(root, "tilewidth"),
        tileHeight: tiledNumber(root, "tileheight"),
        infinite: root.getAttribute("infinite") === "1",
        tilesetRefs: [],
        layers: [],
    };
    for (const element of root.children) {
        if (element.tagName === "tileset") {
            const source = element.getAttribute("source");
            map.tilesetRefs.push({
                firstGid: tiledNumber(element, "firstgid"),
                source,
                info: source === null ? readTsx(element) : null,
            });
        }
    }
    const walk = (parent, prefix) => {
        for (const element of parent.children) {
            const name = element.getAttribute("name") ?? "";
            if (element.tagName === "layer") {
                const data = element.querySelector("data");
                const tiles = [...data.getElementsByTagName("tile")];
                map.layers.push({
                    name: prefix + name,
                    data: {
                        encoding: data.getAttribute("encoding"),
                        compression: data.getAttribute("compression"),
                        value: data.getAttribute("encoding") === null
                            ? tiles.map((tile) => tiledNumber(tile, "gid"))
                            : data.textContent,
                    },
                });
            }
            else if (element.tagName === "group") {
                walk(element, `${prefix}${name}/`);
            }
        }
    };
    walk(root, "");
    return map;
}

function readTmj(json) {
    const map = {
        width: json.width,
        height: json.height,
        tileWidth: json.tilewidth,
        tileHeight: json.tileheight,
        infinite: Boolean(json.infinite),
        tilesetRefs: json.tilesets.map((tileset) => ({
            firstGid: tileset.firstgid,
            source: tileset.source ?? null,
            info: tileset.source === undefined ? readTsj(tileset) : null,
        })),
        layers: [],
    };
    const walk = (layers, prefix) => {
        for (const layer of layers) {
            if (layer.type === "tilelayer") {
                map.layers.push({
                    name: prefix + layer.name,
                    data: { encoding: layer.encoding ?? null, compression: layer.compression ?? null, value: layer.data },
                });
            }
            else if (layer.type === "group") {
                walk(layer.layers, `${prefix}${layer.name}/`);
            }
        }
    };
    walk(json.layers, "");
    return map;
}

function readTsx(element) {
    const image = element.querySelector("image");
    return {
        tileWidth: tiledNumber(element, "tilewidth"),
        tileHeight: tiledNumber(element, "tileheight"),
        columns: tiledNumber(element, "columns"),
        margin: tiledNumber(element, "margin"),
        spacing: tiledNumber(element, "spacing"),
        tileCount: tiledNumber(element, "tilecount"),
        image: image === null ? null : image.getAttribute("source"),
    };
}

function readTsj(json) {
    return {
        tileWidth: json.tilewidth,
        tileHeight: json.tileheight,
        columns: json.columns ?? 0,
        margin: json.margin ?? 0,
        spacing: json.spacing ?? 0,
        tileCount: json.tilecount ?? 0,
        image: json.image ?? null,
    };
}

async function decodeTiledGids(data, count, layerName) {
    let gids;
    if (Array.isArray(data.value)) {
        gids = Uint32Array.from(data.value);
    }
    else if (data.encoding === "csv") {
        gids = Uint32Array.from(data.value.trim().split(/\s*,\s*/), Number);
    }
    else if (data.encoding === "base64") {
        let bytes = Uint8Array.from(atob(data.value.trim()), (char) => char.charCodeAt(0));
        if (data.compression === "zlib" || data.compression === "gzip") {
            bytes = await decompressPngData(bytes, data.compression === "zlib" ? "deflate" : "gzip");
        }
        else if (data.compression) {
            throw new Error(`Layer "${layerName}" uses ${data.compression} compression; save the map with CSV, zlib or gzip.`);
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        gids = new Uint32Array(Math.floor(bytes.byteLength / 4));
        for (let i = 0; i < gids.length; i++) {
            gids[i] = view.getUint32(i * 4, true);
        }
    }
    else {
        throw new Error(`Layer "${layerName}" uses unsupported encoding "${data.encoding}"`);
    }
    if (gids.length !== count) {
        throw new Error(`Layer "${layerName}" has ${gids.length} tiles, expected ${count}`);
    }
    return gids;
}

function samePalette(a, b) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

// files: Map of lower-case file name -> File, holding the map's tilesets and images.
async function loadTiledMap(mapFile, files) {
    const text = await mapFile.text();
    const map = /\.tmj$/i.test(mapFile.name) ? readTmj(JSON.parse(text)) : readTmx(parseTiledXml(text, mapFile.name));
    if (map.infinite) {
        throw new Error("Infinite maps are not supported; turn off Infinite in Tiled's map properties.");
    }

    const tilesets = [];
    for (const ref of map.tilesetRefs) {
        let info = ref.info;
        if (ref.source !== null) {
            const file = findTiledFile(files, ref.source);
            const tilesetText = await file.text();
            info = /\.(tsj|json)$/i.test(file.name)
                ? readTsj(JSON.parse(tilesetText))
                : readTsx(parseTiledXml(tilesetText, file.name));
        }
        if (info.image === null) {
            throw new Error("Image-collection tilesets are not supported; use a single tileset image.");
        }
        if (info.tileWidth !== map.tileWidth || info.tileHeight !== map.tileHeight) {
            throw new Error(`Tileset "${tiledBaseName(info.image)}" uses ${info.tileWidth}×${info.tileHeight} tiles, but the map uses ${map.tileWidth}×${map.tileHeight}.`);
        }
        const image = await decodeIndexedPng(await findTiledFile(files, info.image).arrayBuffer());
        const columns = info.columns || Math.floor((image.width - 2 * info.margin + info.spacing) / (info.tileWidth + info.spacing));
        tilesets.push({ ...info, columns, firstGid: ref.firstGid, image });
    }
    if (tilesets.length === 0) {
        throw new Error(`${mapFile.name} has no tilesets`);
    }
    tilesets.sort((a, b) => a.firstGid - b.firstGid);
    if (!tilesets.every((tileset) => samePalette(tileset.image.palette, tilesets[0].image.palette))) {
        throw new Error("All tileset images must share the same palette.");
    }

    const layers = [];
    for (const layer of map.layers) {
        layers.push({ name: layer.name, gids: await decodeTiledGids(layer.data, map.width * map.height, layer.name) });
    }
    return { width: map.width, height: map.height, tileWidth: map.tileWidth, tileHeight: map.tileHeight, tilesets, layers };
}

// Returns the editor's image shape: { width, height, palette, alpha, indexes }. Empty cells stay index 0.
function flattenLayer(map, layer) {
    const { tileWidth, tileHeight, tilesets } = map;
    const width = map.width * tileWidth;
    const height = map.height * tileHeight;
    const indexes = new Uint8Array(width * height);
    for (let cell = 0; cell < layer.gids.length; cell++) {
        const raw = layer.gids[cell];
        const gid = raw & TILED_GID_MASK;
        if (gid === 0) {
            continue;
        }
        const outside = () => new Error(`Tile ${gid} in layer "${layer.name}" is outside its tileset image`);
        const tileset = tilesets.findLast((candidate) => candidate.firstGid <= gid);
        if (tileset === undefined) {
            throw outside();
        }
        const id = gid - tileset.firstGid;
        const sourceX = tileset.margin + (id % tileset.columns) * (tileWidth + tileset.spacing);
        const sourceY = tileset.margin + Math.floor(id / tileset.columns) * (tileHeight + tileset.spacing);
        if (sourceX + tileWidth > tileset.image.width || sourceY + tileHeight > tileset.image.height) {
            throw outside();
        }
        const destinationX = (cell % map.width) * tileWidth;
        const destinationY = Math.floor(cell / map.width) * tileHeight;
        for (let y = 0; y < tileHeight; y++) {
            for (let x = 0; x < tileWidth; x++) {
                // Tiled flips horizontally/vertically after the diagonal (x/y swap), so undo them in reverse.
                let u = raw & TILED_FLIP_H ? tileWidth - 1 - x : x;
                let v = raw & TILED_FLIP_V ? tileHeight - 1 - y : y;
                if (raw & TILED_FLIP_D) {
                    [u, v] = [v, u];
                }
                indexes[(destinationY + y) * width + destinationX + x] =
                    tileset.image.indexes[(sourceY + v) * tileset.image.width + sourceX + u];
            }
        }
    }
    return { width, height, palette: tilesets[0].image.palette, alpha: tilesets[0].image.alpha, indexes };
}
