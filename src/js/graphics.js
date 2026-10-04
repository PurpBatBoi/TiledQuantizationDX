"use strict";

// Graphics Conversion page: loads a PNG or a Tiled map layer, converts it in graphics-worker.js (inline where workers are blocked,
// e.g. file:// pages) and shows the rebuilt map and tileset with synchronized, inspection-only selection.

const TILESET_COLUMNS = 16;
const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const PASTEBOARD_COLOR = "#161616";

const imageSelector = document.getElementById("image_selector");
const sourceFilename = document.getElementById("source_filename");
const layerDialog = document.getElementById("layer_dialog");
const layerSelect = document.getElementById("layer_select");
const systemSelect = document.getElementById("system");
const sharedColorRow = document.getElementById("shared_color_row");
const autoShadesRow = document.getElementById("auto_shades_row");
const autoShadesInput = document.getElementById("auto_shades");
const genericRows = document.querySelectorAll(".generic-row");
const genericInputs = ["generic_block", "generic_colors", "generic_palettes", "generic_tiles", "generic_flips"].map((id) => document.getElementById(id));
const sharedAuto = document.getElementById("shared_auto");
const sharedValue = document.getElementById("shared_value");
const sharedSwatches = document.getElementById("shared_swatches");
const zoomInput = document.getElementById("zoom");
const gridVisible = document.getElementById("grid_visible");
const showTileIndex = document.getElementById("show_tile_index");
const showPaletteIndex = document.getElementById("show_palette_index");
const paletteGrid = document.getElementById("palette_grid");
const paletteHelp = document.getElementById("palette_help");
const paletteReset = document.getElementById("palette_reset");
const nesColorDialog = document.getElementById("nes_color_dialog");
const nesColorTitle = document.getElementById("nes_color_title");
const nesColorGrid = document.getElementById("nes_color_grid");
const statsView = document.getElementById("graphics_stats");
const diagnosticsView = document.getElementById("graphics_diagnostics");
const selectionInfo = document.getElementById("selection_info");
const downloadList = document.getElementById("download_list");
const statusRegion = document.getElementById("graphics_status");
const mapCanvas = document.getElementById("map_canvas");
const tilesetCanvas = document.getElementById("tileset_canvas");

let sourceName = "image";
let input = null;
let loadError = null;
let result = null;
// The worker's result before palette edits; `result` is it with paletteEdits applied (NES).
let converted = null;
// NES palette touch-ups: "palette:index" -> PPU color, color 0 keyed "0". Cleared by every new conversion.
const paletteEdits = new Map();
let editingSlot = null;
let outputs = null;
let sharedOverride = null;
let selectedCell = null;
let selectedTile = null;
let worker = null;
let jobId = 0;
// Rendered at 1× per result: rebuilt map and tileset.
let bases = null;
let firstCell = null;

function hex(value, digits = 2) {
    return value.toString(16).padStart(digits, "0");
}

function css(rgb) {
    return `#${hex(rgb, 6)}`;
}

function announce(text) {
    statusRegion.textContent = text;
}

function canvasFrom(width, height, fill) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    if (width > 0 && height > 0) {
        const pixels = new ImageData(width, height);
        fill(pixels.data);
        canvas.getContext("2d").putImageData(pixels, 0, 0);
    }
    return canvas;
}

// image: decodeIndexedPng's or flattenLayer's { width, height, palette, alpha, indexes }.
function indexedInput({ width, height, palette, alpha, indexes }) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    indexes.forEach((entry, i) => {
        rgba.set([palette[entry * 3] ?? 0, palette[entry * 3 + 1] ?? 0, palette[entry * 3 + 2] ?? 0,
            alpha !== null && entry < alpha.length ? alpha[entry] : 255], i * 4);
    });
    return { width, height, rgba, indexed: { palette, indexes } };
}

async function readPng(file) {
    const bytes = await file.arrayBuffer();
    let indexed = null;
    try {
        indexed = await decodeIndexedPng(bytes);
    }
    catch {
        indexed = null;
    }
    if (indexed !== null) {
        return indexedInput(indexed);
    }
    // Raw pixel values: no color management, no premultiplied alpha.
    const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: data, indexed: null };
}

// A Tiled map (.tmx/.tmj) is selected together with its tileset (.tsx/.tsj) and image files, as in the Attribute
// Editor; its layer is flattened through the tileset images and converted like an indexed PNG.
async function loadFiles(fileList) {
    const files = new Map([...fileList].map((file) => [file.name.toLowerCase(), file]));
    const mapFile = [...files.values()].find((file) => /\.(tmx|tmj)$/i.test(file.name));
    const mainFile = mapFile ?? [...files.values()].find((file) => /\.png$/i.test(file.name)) ?? fileList[0];
    let label = mainFile.name;
    let name = mainFile.name.substring(0, mainFile.name.lastIndexOf(".")) || mainFile.name;
    let loaded;
    let error = null;
    try {
        if (mapFile === undefined) {
            loaded = await readPng(mainFile);
        }
        else {
            const map = await loadTiledMap(mapFile, files);
            if (map.layers.length === 0) {
                throw new Error(`${mapFile.name} has no tile layers`);
            }
            const layerIndex = map.layers.length === 1 ? 0 : await chooseLayer(map.layers.map((layer) => layer.name));
            if (layerIndex === null) {
                return;
            }
            const layer = map.layers[layerIndex];
            loaded = indexedInput(flattenLayer(map, layer));
            if (map.layers.length > 1) {
                label += ` — ${layer.name}`;
                name += `_${layer.name.replace(/[^\w-]+/g, "_")}`;
            }
        }
    }
    catch (caught) {
        loaded = null;
        error = `Couldn't read ${mainFile.name}: ${caught.message || "not a PNG"}`;
    }
    sourceName = name;
    sourceFilename.textContent = label;
    selectedCell = null;
    selectedTile = null;
    for (const view of views) view.fitMode = true;
    input = loaded;
    loadError = error;
    convert();
}

// Resolves with the chosen layer index, or null when the dialog is cancelled.
function chooseLayer(names) {
    layerSelect.replaceChildren(...names.map((layerName, i) => new Option(layerName, i)));
    layerDialog.showModal();
    return new Promise((resolve) => {
        // The form uses method="dialog", so submitting also closes the dialog; Esc fires "cancel".
        layerDialog.querySelector("form").onsubmit = (event) => {
            resolve(event.submitter?.value === "ok" ? Number(layerSelect.value) : null);
        };
        layerDialog.oncancel = () => resolve(null);
    });
}

// Every change starts a fresh job; the previous worker is terminated so stale results never arrive.
function convert() {
    worker?.terminate();
    worker = null;
    result = null;
    converted = null;
    outputs = null;
    bases = null;
    const id = ++jobId;
    render();
    if (input === null) {
        if (loadError !== null) announce(loadError);
        return;
    }
    const message = { id, input, options: { system: systemSelect.value, sharedColor: sharedOverride, autoShades: autoShadesInput.checked,
        generic: genericRules() } };
    const finish = (converted) => {
        if (id === jobId) receive(converted);
    };
    const runInline = () => setTimeout(() => finish(convertBackgroundAsset(message.input, message.options)), 0);
    try {
        worker = new Worker("js/graphics-worker.js");
    }
    catch {
        runInline();
        return;
    }
    const current = worker;
    current.onmessage = ({ data }) => {
        current.terminate();
        if (worker === current) worker = null;
        if (data.error) {
            if (id === jobId) {
                loadError = data.error;
                render();
                announce(data.error);
            }
            return;
        }
        finish(data.result);
    };
    // The script failed to load (e.g. blocked): convert on the main thread instead.
    current.onerror = (event) => {
        event.preventDefault();
        current.terminate();
        if (worker === current) worker = null;
        runInline();
    };
    current.postMessage(message);
}

function receive(conversion) {
    converted = conversion;
    paletteEdits.clear();
    result = conversion;
    loadError = null;
    if (result.ok) {
        firstCell = new Int32Array(result.tileCount).fill(-1);
        result.cells.tile.forEach((tile, cell) => {
            if (firstCell[tile] < 0) firstCell[tile] = cell;
        });
    }
    bases = buildBases();
    if (result.ok) {
        outputs = graphicsOutputs(result, sourceName);
        if (selectedCell !== null && selectedCell < result.cells.tile.length) {
            selectedTile = result.cells.tile[selectedCell];
        }
        else {
            selectedCell = null;
            selectedTile = null;
        }
        announce(`Converted: ${statsText()}`);
    }
    else {
        selectedCell = null;
        selectedTile = null;
        announce(`Conversion failed: ${result.diagnostics.map((d) => d.message).join(" ")}`);
    }
    render();
}

function genericRules() {
    const [block, colors, palettes, tiles, flips] = genericInputs;
    const whole = (input, fallback) => Math.max(1, Math.floor(Number(input.value)) || fallback);
    return { block: Number(block.value), colors: Number(colors.value), maxPalettes: whole(palettes, 8), maxTiles: whole(tiles, 256), flips: flips.checked };
}

function currentBlock() {
    return systemSelect.value === "generic" ? genericRules().block : GRAPHICS_TARGETS[systemSelect.value].block;
}

function buildBases() {
    const { width, height } = input;
    // A failed conversion has no tiles: the map view shows the art in matched hardware colors under the red outlines.
    if (!result.ok) {
        return { map: canvasFrom(width, height, (data) => data.set(result.preview)), tileset: null };
    }
    const { tilePixels, paletteColors, cells, tilesX, tileCount } = result;
    const drawTile = (data, stride, left, top, tile, palette, flags) => {
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const value = tilePixels[tile * 64 + (flags & 2 ? 7 - y : y) * 8 + (flags & 1 ? 7 - x : x)];
                const rgb = paletteColors[palette][value];
                data.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255], ((top + y) * stride + left + x) * 4);
            }
        }
    };
    const map = canvasFrom(width, height, (data) => {
        cells.tile.forEach((tile, cell) => drawTile(data, width, (cell % tilesX) * 8, Math.floor(cell / tilesX) * 8,
            tile, cells.palette[cell], cells.flags[cell]));
    });
    // Tiles have no palette of their own; each is shown with the palette of its first use.
    const columns = Math.min(TILESET_COLUMNS, tileCount);
    const tileset = canvasFrom(columns * 8, Math.ceil(tileCount / TILESET_COLUMNS) * 8, (data) => {
        for (let tile = 0; tile < tileCount; tile++) {
            drawTile(data, columns * 8, (tile % TILESET_COLUMNS) * 8, Math.floor(tile / TILESET_COLUMNS) * 8,
                tile, cells.palette[firstCell[tile]], 0);
        }
    });
    return { map, tileset };
}

function statsText() {
    if (!result?.ok) return "";
    const flipped = result.cells.flags.reduce((count, flags) => count + (flags & 3 ? 1 : 0), 0);
    const flipText = result.flips ? `, ${flipped} flipped reuse(s)` : "";
    const shadeText = result.autoShaded > 0 ? `, ${result.autoShaded} colors grouped into 4 shades` : "";
    return `${result.width}×${result.height} px, ${result.tilesX}×${result.tilesY} tiles, ${result.tileCount} unique tile(s), `
        + `${result.paletteCount} palette(s)${flipText}${shadeText}`;
}

// Each view is a viewport like the Attribute Editor's: the image floats on a pasteboard, the wheel zooms around the
// cursor, middle-drag or Space + drag pans. source() -> { base, grid, rects, block }.
function createView(canvas, source) {
    return { canvas, source, zoom: 1, offsetX: 0, offsetY: 0, fitMode: true, pan: null };
}

const EMPTY_GRID = { columns: 1, count: 0, cell: () => ({}), selected: () => false, related: () => false };
const mapView = createView(mapCanvas, () => ({
    base: bases?.map ?? null,
    grid: cellGrid(),
    rects: result?.diagnostics.flatMap((d) => d.rects) ?? [],
    block: currentBlock(),
}));
const tilesetView = createView(tilesetCanvas, () => ({
    base: bases?.tileset ?? null,
    grid: result?.ok ? tileGrid() : EMPTY_GRID,
    rects: [],
    block: 0,
}));
const views = [mapView, tilesetView];

function fitView(view, base) {
    const { canvas } = view;
    const scale = Math.min(canvas.width / base.width, canvas.height / base.height);
    view.zoom = ZOOM_LEVELS.filter((level) => level <= scale).pop() ?? ZOOM_LEVELS[0];
    view.offsetX = Math.round((canvas.width - base.width * view.zoom) / 2);
    view.offsetY = Math.round((canvas.height - base.height * view.zoom) / 2);
}

function zoomAt(view, level, anchorX, anchorY) {
    const imageX = (anchorX - view.offsetX) / view.zoom;
    const imageY = (anchorY - view.offsetY) / view.zoom;
    view.zoom = level;
    view.offsetX = Math.round(anchorX - imageX * level);
    view.offsetY = Math.round(anchorY - imageY * level);
    view.fitMode = false;
}

// grid: { columns, count, cell(i) -> { tile, palette }, selected(i), related(i) }. rects: invalid areas in pixels.
function drawView(view) {
    const { canvas } = view;
    const { base, grid, rects, block } = view.source();
    const context = canvas.getContext("2d");
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    context.fillStyle = PASTEBOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (base === null || base.width === 0) return;
    if (view.fitMode) fitView(view, base);
    const { zoom: z, offsetX: ox, offsetY: oy } = view;
    const width = base.width * z;
    const height = base.height * z;
    context.imageSmoothingEnabled = false;
    context.shadowColor = "#000";
    context.shadowBlur = 16;
    context.drawImage(base, ox, oy, width, height);
    context.shadowBlur = 0;
    const size = 8 * z;
    if (gridVisible.checked && size >= 4) {
        const stroke = (step, alpha) => {
            context.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
            context.lineWidth = 1;
            context.beginPath();
            for (let x = step; x < width; x += step) {
                context.moveTo(Math.floor(ox + x) + 0.5, oy);
                context.lineTo(Math.floor(ox + x) + 0.5, oy + height);
            }
            for (let y = step; y < height; y += step) {
                context.moveTo(ox, Math.floor(oy + y) + 0.5);
                context.lineTo(ox + width, Math.floor(oy + y) + 0.5);
            }
            context.stroke();
        };
        stroke(size, 0.3);
        if (block > 8) stroke(block * z, 0.7);
    }
    const origin = (i) => [ox + (i % grid.columns) * size, oy + Math.floor(i / grid.columns) * size];
    const visible = (x, y) => x + size > 0 && y + size > 0 && x < canvas.width && y < canvas.height;
    if (grid.count > 0 && size >= 16 && (showTileIndex.checked || showPaletteIndex.checked)) {
        context.font = `bold ${Math.max(8, Math.floor(size / 3.2))}px monospace`;
        context.lineWidth = 3;
        context.strokeStyle = "#000";
        context.fillStyle = "#fff";
        for (let i = 0; i < grid.count; i++) {
            const [x, y] = origin(i);
            if (!visible(x, y)) continue;
            const { tile, palette } = grid.cell(i);
            if (showTileIndex.checked) {
                context.textAlign = "left";
                context.textBaseline = "top";
                context.strokeText(String(tile), x + 2, y + 2);
                context.fillText(String(tile), x + 2, y + 2);
            }
            if (showPaletteIndex.checked) {
                context.textAlign = "right";
                context.textBaseline = "bottom";
                context.strokeText(`p${palette}`, x + size - 2, y + size - 2);
                context.fillText(`p${palette}`, x + size - 2, y + size - 2);
            }
        }
    }
    for (let i = 0; i < grid.count; i++) {
        const [x, y] = origin(i);
        if (!visible(x, y)) continue;
        if (grid.selected(i)) {
            context.lineWidth = 3;
            context.strokeStyle = "#000";
            context.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
            context.lineWidth = 1;
            context.strokeStyle = "#fff";
            context.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
        }
        else if (grid.related(i)) {
            context.lineWidth = 1;
            context.strokeStyle = "#fd0";
            context.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
        }
    }
    context.lineWidth = 2;
    context.strokeStyle = "#f44";
    for (const rect of rects) {
        context.strokeRect(ox + rect.x * z + 1, oy + rect.y * z + 1, rect.width * z - 2, rect.height * z - 2);
    }
}

function cellGrid() {
    if (!result?.ok) {
        return EMPTY_GRID;
    }
    return {
        columns: result.tilesX,
        count: result.cells.tile.length,
        cell: (i) => ({ tile: result.cells.tile[i], palette: result.cells.palette[i] }),
        selected: (i) => i === selectedCell,
        related: (i) => result.cells.tile[i] === selectedTile,
    };
}

function tileGrid() {
    return {
        columns: TILESET_COLUMNS,
        count: result.tileCount,
        cell: (i) => ({ tile: i, palette: result.cells.palette[firstCell[i]] }),
        selected: (i) => i === selectedTile,
        related: () => false,
    };
}

// The zoom list follows the map view, the main one.
function drawViews() {
    views.forEach(drawView);
    zoomInput.value = mapView.fitMode ? "fit" : String(mapView.zoom);
}

function renderSharedColor() {
    sharedColorRow.hidden = systemSelect.value !== "nes";
    autoShadesRow.hidden = systemSelect.value !== "gb";
    for (const row of genericRows) row.hidden = systemSelect.value !== "generic";
    sharedAuto.setAttribute("aria-pressed", String(sharedOverride === null));
    for (const button of sharedSwatches.children) {
        button.setAttribute("aria-pressed", String(Number(button.dataset.color) === sharedOverride));
    }
    // The conversion-time choice; palette touch-ups to color 0 show in the Palettes panel instead.
    const shared = converted?.ok ? converted.sharedColor : sharedOverride;
    sharedValue.textContent = shared === null || shared === undefined ? ""
        : `$${hex(shared).toUpperCase()}${sharedOverride === null ? " (auto)" : ""}`;
}

// Recolors the converted palettes with the edits, then refreshes everything that shows or exports them.
function applyPaletteEdits() {
    result = recolorNesPalettes(converted, paletteEdits);
    bases = buildBases();
    outputs = graphicsOutputs(result, sourceName);
    render();
}

function slotKey(p, i) {
    return i === 0 ? "0" : `${p}:${i}`;
}

function openColorDialog(p, i) {
    editingSlot = { p, i };
    nesColorTitle.textContent = i === 0 ? "Color 0 (shared by every palette)" : `Palette ${p}, color ${i}`;
    const current = result.paletteValues[p][i];
    for (const button of nesColorGrid.children) {
        button.setAttribute("aria-pressed", String(Number(button.dataset.color) === current));
    }
    nesColorDialog.showModal();
    nesColorGrid.querySelector('[aria-pressed="true"]')?.focus();
}

function setSlotColor(color) {
    const { p, i } = editingSlot;
    const key = slotKey(p, i);
    const original = converted.paletteValues[p][i];
    if (color === null || color === original) paletteEdits.delete(key);
    else paletteEdits.set(key, color);
    applyPaletteEdits();
    const value = result.paletteValues[p][i];
    announce(`${i === 0 ? "Color 0" : `Palette ${p} color ${i}`} is now $${hex(value).toUpperCase()}.`);
}

function renderPalettes() {
    paletteGrid.replaceChildren();
    const editable = result?.ok === true && result.system === "nes";
    paletteHelp.hidden = !editable;
    paletteReset.hidden = !editable || paletteEdits.size === 0;
    if (!result?.ok) return;
    const label = (value) => (result.system === "nes" ? `$${hex(value).toUpperCase()}`
        : result.system === "gb" ? `shade ${value}` : result.system === "generic" ? `#${hex(value, 6)}` : `0x${hex(value, 4)}`);
    result.paletteColors.forEach((row, p) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = p;
        tr.append(th);
        row.forEach((rgb, i) => {
            const td = document.createElement("td");
            const swatch = document.createElement(editable ? "button" : "div");
            swatch.className = "swatch";
            swatch.style.background = css(rgb);
            swatch.title = label(result.paletteValues[p][i]);
            if (editable) {
                swatch.type = "button";
                swatch.classList.toggle("edited", paletteEdits.has(slotKey(p, i)));
                swatch.setAttribute("aria-label", `palette ${p} color ${i}: ${swatch.title}${paletteEdits.has(slotKey(p, i)) ? ", edited" : ""}. Change color`);
                swatch.addEventListener("click", () => openColorDialog(p, i));
            }
            else {
                swatch.setAttribute("role", "img");
                swatch.setAttribute("aria-label", `palette ${p} color ${i}: ${swatch.title}`);
            }
            td.append(swatch);
            tr.append(td);
        });
        const values = document.createElement("td");
        values.className = "palette-values";
        values.textContent = result.paletteValues[p].map((value) =>
            (result.system === "nes" ? hex(value).toUpperCase() : result.system === "gb" ? value
                : hex(value, result.system === "generic" ? 6 : 4))).join(" ");
        tr.append(values);
        paletteGrid.append(tr);
    });
    if (result.system === "gb") {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.className = "palette-values";
        td.textContent = `BGP = $${hex(result.bgp).toUpperCase()}`;
        tr.append(td);
        paletteGrid.append(tr);
    }
}

function renderResult() {
    diagnosticsView.replaceChildren();
    if (input === null) {
        statsView.textContent = loadError ?? "No image loaded.";
        statsView.className = loadError === null ? "" : "result-warning";
        return;
    }
    statsView.className = "";
    if (result === null) {
        statsView.textContent = loadError ?? "Converting…";
        statsView.className = loadError === null ? "" : "result-warning";
        return;
    }
    statsView.textContent = result.ok ? statsText() : "Conversion failed. Invalid areas are outlined in red.";
    for (const d of result.diagnostics) {
        const li = document.createElement("li");
        const message = document.createElement("div");
        message.textContent = d.message;
        const hint = document.createElement("div");
        hint.className = "diagnostic-hint";
        hint.textContent = d.hint;
        const page = d.hint.includes("attributes.html") ? ["attributes.html", "Open Attribute Editor"]
            : d.hint.includes("index.html") ? ["index.html", "Open Palette Quantization"] : null;
        if (page !== null) {
            const link = document.createElement("a");
            link.href = page[0];
            link.textContent = page[1];
            hint.append(" ", link);
        }
        li.append(message, hint);
        diagnosticsView.append(li);
    }
}

function renderDownloads() {
    const fileNames = [...graphicsOutputNames(systemSelect.value, sourceName), `${sourceName}_tileset.png`];
    downloadList.replaceChildren(...fileNames.map((fileName) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = fileName;
        button.disabled = outputs === null;
        button.title = outputs === null ? "Available once the conversion succeeds." : `Download ${fileName}`;
        button.addEventListener("click", () => {
            // The tileset preview at 1×, each tile in the palette of its first use.
            if (fileName.endsWith(".png")) {
                bases?.tileset?.toBlob((blob) => { if (blob) downloadBlob(blob, fileName); }, "image/png");
                return;
            }
            const file = outputs?.find((output) => output.fileName === fileName);
            if (file) {
                downloadBlob(new Blob([file.data], { type: "application/octet-stream" }), fileName);
            }
        });
        return button;
    }));
}

function renderSelection() {
    if (!result?.ok || selectedTile === null) {
        selectionInfo.textContent = "Click a tile, or focus a view and use the arrow keys.";
        return;
    }
    const cell = selectedCell;
    const tx = cell % result.tilesX;
    const ty = Math.floor(cell / result.tilesX);
    const flags = result.cells.flags[cell];
    const size = result.bytesPerTile;
    const bytes = Array.from(result.tileBytes.subarray(selectedTile * size, selectedTile * size + size), (b) => hex(b)).join(" ");
    const occurrences = result.cells.tile.reduce((count, tile) => count + (tile === selectedTile ? 1 : 0), 0);
    const rows = [
        ["Tile", `${selectedTile} of ${result.tileCount} (${occurrences} use(s))`],
        ["Cell", `${tx}, ${ty} (${tx * 8}, ${ty * 8} px)`],
        ["Palette", String(result.cells.palette[cell])],
        ["Map byte", `$${hex(result.map[cell]).toUpperCase()}`],
    ];
    if (result.system === "gbc") rows.push(["Bank", String(flags & 4 ? 1 : 0)]);
    if (result.flips) rows.push(["Flip", [flags & 1 ? "H" : "", flags & 2 ? "V" : ""].join("") || "none"]);
    if (result.system === "gbc") rows.push(["Attribute", `$${hex(result.attributes[cell]).toUpperCase()}`]);
    rows.push(["Bytes", bytes]);
    const dl = document.createElement("dl");
    for (const [term, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        dl.append(dt, dd);
    }
    selectionInfo.replaceChildren(dl);
}

function render() {
    renderSharedColor();
    renderPalettes();
    renderResult();
    renderDownloads();
    renderSelection();
    drawViews();
}

function describeSelection() {
    const cell = selectedCell;
    const flags = result.cells.flags[cell];
    const flip = flags & 3 ? `, flipped ${[flags & 1 ? "horizontally" : "", flags & 2 ? "vertically" : ""].filter(Boolean).join(" and ")}` : "";
    announce(`Tile ${selectedTile} at column ${cell % result.tilesX}, row ${Math.floor(cell / result.tilesX)}, `
        + `palette ${result.cells.palette[cell]}${flip}.`);
}

// Pans a view whose selection is off screen so it sits in the middle, keeping the views in step.
function reveal(view, index, columns) {
    const { canvas } = view;
    const size = 8 * view.zoom;
    const left = (index % columns) * size;
    const top = Math.floor(index / columns) * size;
    const x = view.offsetX + left;
    const y = view.offsetY + top;
    if (x < 0 || y < 0 || x + size > canvas.width || y + size > canvas.height) {
        view.offsetX = Math.round(canvas.width / 2 - left - size / 2);
        view.offsetY = Math.round(canvas.height / 2 - top - size / 2);
        view.fitMode = false;
    }
}

function selectCell(cell) {
    selectedCell = cell;
    selectedTile = result.cells.tile[cell];
    afterSelection();
}

function selectTile(tile) {
    selectedTile = tile;
    selectedCell = firstCell[tile];
    afterSelection();
}

function afterSelection() {
    reveal(mapView, selectedCell, result.tilesX);
    reveal(tilesetView, selectedTile, TILESET_COLUMNS);
    renderSelection();
    drawViews();
    describeSelection();
}

function canvasPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return [
        (event.clientX - rect.left) * canvas.width / rect.width,
        (event.clientY - rect.top) * canvas.height / rect.height,
    ];
}

function hitIndex(view, event, columns, count) {
    const [canvasX, canvasY] = canvasPoint(view.canvas, event);
    const size = 8 * view.zoom;
    const x = Math.floor((canvasX - view.offsetX) / size);
    const y = Math.floor((canvasY - view.offsetY) / size);
    const index = y * columns + x;
    return x >= 0 && x < columns && y >= 0 && index < count ? index : null;
}

let spaceHeld = false;

// Left click selects; middle drag or Space + left drag pans; the wheel zooms around the cursor.
function attachViewControls(view, select) {
    const { canvas } = view;
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        if (event.button === 1 || (event.button === 0 && spaceHeld)) {
            event.preventDefault();
            view.pan = { x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
            canvas.classList.add("panning");
        }
        else if (event.button === 0 && result?.ok) {
            select(event);
        }
    });
    canvas.addEventListener("pointermove", (event) => {
        if (view.pan !== null) {
            view.offsetX = view.pan.offsetX + event.clientX - view.pan.x;
            view.offsetY = view.pan.offsetY + event.clientY - view.pan.y;
            view.fitMode = false;
            drawViews();
        }
    });
    for (const type of ["pointerup", "pointercancel"]) {
        canvas.addEventListener(type, () => {
            view.pan = null;
            canvas.classList.remove("panning");
        });
    }
    // Stops the browser's middle-click autoscroll.
    canvas.addEventListener("mousedown", (event) => {
        if (event.button === 1) event.preventDefault();
    });
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        if (view.source().base === null) return;
        const current = ZOOM_LEVELS.indexOf(view.zoom);
        const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, current + (event.deltaY < 0 ? 1 : -1)));
        if (next !== current) {
            zoomAt(view, ZOOM_LEVELS[next], ...canvasPoint(canvas, event));
            drawViews();
        }
    }, { passive: false });
}

attachViewControls(mapView, (event) => {
    const cell = hitIndex(mapView, event, result.tilesX, result.cells.tile.length);
    if (cell !== null) selectCell(cell);
});
attachViewControls(tilesetView, (event) => {
    const tile = hitIndex(tilesetView, event, TILESET_COLUMNS, result.tileCount);
    if (tile !== null) selectTile(tile);
});

function setSpaceHeld(event, held) {
    if (event.code !== "Space" || event.target.matches("input, select, textarea, button")) return;
    event.preventDefault();
    spaceHeld = held;
    for (const view of views) view.canvas.classList.toggle("grab", held);
}
document.addEventListener("keydown", (event) => setSpaceHeld(event, true));
document.addEventListener("keyup", (event) => setSpaceHeld(event, false));

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function moveWithKeys(event, current, columns, count, select) {
    const step = ARROWS[event.key];
    if (!step || !result?.ok) return;
    event.preventDefault();
    if (current === null) {
        select(0);
        return;
    }
    const x = current % columns + step[0];
    const y = Math.floor(current / columns) + step[1];
    const next = y * columns + x;
    if (x >= 0 && x < columns && y >= 0 && next < count) select(next);
}

mapCanvas.addEventListener("keydown", (event) =>
    moveWithKeys(event, selectedCell, result?.tilesX, result?.cells.tile.length, selectCell));
tilesetCanvas.addEventListener("keydown", (event) =>
    moveWithKeys(event, selectedTile, TILESET_COLUMNS, result?.tileCount, selectTile));

function downloadBlob(blob, fileName) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

// The 64 PPU colors as buttons ($0D, blacker than black, can upset TVs and is left out).
function addNesColorButtons(container, label, pick) {
    for (let color = 0; color < 64; color++) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.color = color;
        button.style.background = css(NES_PALGEN[color]);
        button.title = `$${hex(color).toUpperCase()}`;
        button.setAttribute("aria-label", `${label}$${hex(color).toUpperCase()}`);
        button.disabled = color === 0x0d;
        button.addEventListener("click", () => pick(color));
        container.append(button);
    }
}

// Conversion-time color 0: Auto, or a forced color (decides which pixels count as color 0).
addNesColorButtons(sharedSwatches, "Color 0 = ", (color) => {
    sharedOverride = color;
    convert();
});
// Palette touch-up popup.
addNesColorButtons(nesColorGrid, "", (color) => {
    nesColorDialog.close();
    setSlotColor(color);
});
nesColorDialog.addEventListener("close", () => {
    if (nesColorDialog.returnValue === "reset") setSlotColor(null);
    nesColorDialog.returnValue = "";
});
paletteReset.addEventListener("click", () => {
    paletteEdits.clear();
    applyPaletteEdits();
    announce("Palette edits reset.");
});
sharedAuto.addEventListener("click", () => {
    sharedOverride = null;
    convert();
});

document.getElementById("input_field").addEventListener("click", () => imageSelector.click());
imageSelector.addEventListener("change", () => {
    if (imageSelector.files !== null && imageSelector.files.length > 0) {
        void loadFiles(imageSelector.files);
        imageSelector.value = "";
    }
});
document.body.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
});
document.body.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null && event.dataTransfer.files.length > 0) {
        void loadFiles(event.dataTransfer.files);
    }
});

systemSelect.addEventListener("change", convert);
autoShadesInput.addEventListener("change", convert);
for (const control of genericInputs) control.addEventListener("change", convert);
zoomInput.addEventListener("change", () => {
    for (const view of views) {
        if (zoomInput.value === "fit") {
            view.fitMode = true;
        }
        else if (view.source().base !== null) {
            zoomAt(view, Number(zoomInput.value), view.canvas.width / 2, view.canvas.height / 2);
        }
    }
    drawViews();
});
for (const control of [gridVisible, showTileIndex, showPaletteIndex]) {
    control.addEventListener("change", drawViews);
}
new ResizeObserver(drawViews).observe(document.getElementById("graphics_views"));

render();
