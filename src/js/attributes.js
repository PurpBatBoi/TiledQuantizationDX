"use strict";

const TILE_SIZE = 8;
// block: attribute area in pixels. sharedColorZero: color 0 of every palette mirrors palette 0's.
// priority: per-tile BG-over-OBJ priority can be painted and exported (GBC attribute bit 7).
const systems = {
    gbc: { columns: 4, rows: 8, block: 8, sharedColorZero: false, priority: true },
    nes: { columns: 4, rows: 4, block: 16, sharedColorZero: true, priority: false },
    md: { columns: 16, rows: 4, block: 8, sharedColorZero: true, priority: false },
};

const imageSelector = document.getElementById("image_selector");
const sourceFilename = document.getElementById("source_filename");
const layerDialog = document.getElementById("layer_dialog");
const layerSelect = document.getElementById("layer_select");
const systemSelect = document.getElementById("system");
const fineAttributes = document.getElementById("fine_attributes");
const zoomInput = document.getElementById("zoom");
const gridVisible = document.getElementById("grid_visible");
const gridColor = document.getElementById("grid_color");
const gridOpacity = document.getElementById("grid_opacity");
const paletteGrid = document.getElementById("palette_grid");
const paletteTool = document.getElementById("tool_palette");
const priorityTool = document.getElementById("tool_priority");
const pngPriorityNote = document.getElementById("png_priority_note");
const downloadButton = document.getElementById("download_button");
const attributeFormat = document.getElementById("attribute_format");
const attributeDownload = document.getElementById("attribute_download");
const undoButton = document.getElementById("undo_button");
const redoButton = document.getElementById("redo_button");
const editorStatus = document.getElementById("editor_status");
const editorView = document.getElementById("editor_view");
const canvas = document.getElementById("editor_canvas");
const context = canvas.getContext("2d");

let sourceName = "image";
let image = null;
let attributes = null;
let mixed = null;
// One flag per 8×8 tile. Kept across system switches; only shown and exported where the system supports it.
let priority = null;
let prioritySupported = true;
let tool = "palette";
let priorityStrokeValue = 1;
let columns = 4;
let rows = 8;
let blockSize = 8;
let sharedColorZero = false;
let activeRow = 0;
const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let strokeRecorded = false;
const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const PASTEBOARD_COLOR = "#161616";
const imageCanvas = document.createElement("canvas");
let zoom = 1;
let offsetX = 0;
let offsetY = 0;
let fitMode = true;
let pan = null;
let spaceHeld = false;

function setStatus(text, isError) {
    editorStatus.textContent = text;
    editorStatus.className = isError ? "result-warning" : "";
}

// What the hardware shows: with a shared color 0, every palette's color 0 displays as palette 0's.
function paletteColor(index) {
    return storedColor(sharedColorZero && index % columns === 0 ? 0 : index);
}

// The color actually stored in the file, so exports keep every palette entry as loaded.
function storedColor(index) {
    if (image === null || index * 3 + 2 >= image.palette.length) {
        return [0, 0, 0, 255];
    }
    const alpha = image.alpha !== null && index < image.alpha.length ? image.alpha[index] : 255;
    return [image.palette[index * 3], image.palette[index * 3 + 1], image.palette[index * 3 + 2], alpha];
}

function validateImage() {
    if (image.width % TILE_SIZE !== 0 || image.height % TILE_SIZE !== 0) {
        return `Image is ${image.width}×${image.height}; width and height must be multiples of ${TILE_SIZE}.`;
    }
    const total = columns * rows;
    const maxIndex = image.indexes.reduce((max, value) => Math.max(max, value), 0);
    if (maxIndex >= total) {
        return `Pixel uses color index ${maxIndex}, but ${systemSelect.selectedOptions[0].text} palettes only hold ${total} colors.`;
    }
    return null;
}

// Each attribute block gets the palette row most of its pixels already use; blocks spanning several rows are flagged.
function computeAttributes() {
    const blocksX = Math.ceil(image.width / blockSize);
    const blocksY = Math.ceil(image.height / blockSize);
    attributes = new Uint8Array(blocksX * blocksY);
    mixed = new Uint8Array(blocksX * blocksY);
    const counts = new Uint32Array(rows);
    for (let block = 0; block < attributes.length; block++) {
        counts.fill(0);
        forEachBlockPixel(block, (pixel) => {
            const index = image.indexes[pixel];
            // A shared color 0 looks the same in every palette, so it doesn't tie the block to one.
            if (!(sharedColorZero && index % columns === 0)) {
                counts[Math.floor(index / columns)]++;
            }
        });
        let best = 0;
        let used = 0;
        for (let row = 0; row < rows; row++) {
            if (counts[row] > 0) used++;
            if (counts[row] > counts[best]) best = row;
        }
        attributes[block] = best;
        mixed[block] = used > 1 ? 1 : 0;
    }
}

// Blocks on the right/bottom edge may be cut short when the image is not a multiple of the block size.
function forEachBlockPixel(block, callback) {
    const blocksX = Math.ceil(image.width / blockSize);
    const left = (block % blocksX) * blockSize;
    const top = Math.floor(block / blocksX) * blockSize;
    for (let y = top; y < Math.min(top + blockSize, image.height); y++) {
        for (let x = left; x < Math.min(left + blockSize, image.width); x++) {
            callback(y * image.width + x);
        }
    }
}

function applyLayout() {
    const system = systems[systemSelect.value];
    ({ columns, rows, sharedColorZero } = system);
    prioritySupported = system.priority;
    fineAttributes.closest("tr").hidden = system.block === TILE_SIZE;
    blockSize = fineAttributes.checked ? TILE_SIZE : system.block;
    activeRow = Math.min(activeRow, rows - 1);
    renderPalette();
    attributes = null;
    downloadButton.disabled = true;
    const error = image === null ? null : validateImage();
    if (error !== null) {
        setStatus(error, true);
    }
    else if (image !== null) {
        computeAttributes();
        renderImage();
        downloadButton.disabled = false;
        updateStatus();
    }
    updateHistoryButtons();
    updateAttributeExport();
    updatePriorityControls();
    // Last: showing/hiding controls can toggle the page scrollbar, and ResizeObserver misses same-frame size flips.
    drawCanvas();
}

function renderPalette() {
    paletteGrid.replaceChildren();
    paletteGrid.style.setProperty("--columns", columns);
    for (let row = 0; row < rows; row++) {
        const tr = document.createElement("tr");
        tr.classList.toggle("active", row === activeRow);
        tr.addEventListener("click", () => {
            activeRow = row;
            setTool("palette");
            renderPalette();
        });
        const label = document.createElement("th");
        label.textContent = row;
        tr.append(label);
        for (let column = 0; column < columns; column++) {
            const td = document.createElement("td");
            const swatch = document.createElement("div");
            swatch.className = "swatch";
            if (image !== null) {
                const [r, g, b, a] = paletteColor(row * columns + column);
                swatch.style.background = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
            }
            td.append(swatch);
            tr.append(td);
        }
        paletteGrid.append(tr);
    }
}

// Photoshop-style view: the canvas fills the tile area, the image floats on a darker pasteboard.
function renderImage() {
    const pixels = new ImageData(image.width, image.height);
    for (let i = 0; i < image.indexes.length; i++) {
        pixels.data.set(paletteColor(image.indexes[i]), i * 4);
    }
    imageCanvas.width = image.width;
    imageCanvas.height = image.height;
    imageCanvas.getContext("2d").putImageData(pixels, 0, 0);
}

function fitView() {
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
    zoom = ZOOM_LEVELS.filter((level) => level <= scale).pop() ?? ZOOM_LEVELS[0];
    offsetX = Math.round((canvas.width - image.width * zoom) / 2);
    offsetY = Math.round((canvas.height - image.height * zoom) / 2);
}

function zoomAt(level, anchorX, anchorY) {
    const imageX = (anchorX - offsetX) / zoom;
    const imageY = (anchorY - offsetY) / zoom;
    zoom = level;
    offsetX = Math.round(anchorX - imageX * zoom);
    offsetY = Math.round(anchorY - imageY * zoom);
    fitMode = false;
    drawCanvas();
}

function drawCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    context.fillStyle = PASTEBOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (image === null || attributes === null) {
        return;
    }
    if (fitMode) {
        fitView();
    }
    zoomInput.value = fitMode ? "fit" : String(zoom);

    context.imageSmoothingEnabled = false;
    context.shadowColor = "#000";
    context.shadowBlur = 16;
    context.drawImage(imageCanvas, offsetX, offsetY, image.width * zoom, image.height * zoom);
    context.shadowBlur = 0;

    if (gridVisible.checked && TILE_SIZE * zoom >= 4) {
        context.strokeStyle = gridColor.value;
        context.globalAlpha = Number(gridOpacity.value);
        strokeGrid(TILE_SIZE, 1);
        if (blockSize > TILE_SIZE) {
            strokeGrid(blockSize, 3);
        }
        context.globalAlpha = 1;
    }

    const blocksX = Math.ceil(image.width / blockSize);
    context.lineWidth = 2;
    context.strokeStyle = "#f44";
    for (let block = 0; block < mixed.length; block++) {
        if (mixed[block]) {
            const left = (block % blocksX) * blockSize;
            const top = Math.floor(block / blocksX) * blockSize;
            const width = Math.min(blockSize, image.width - left) * zoom;
            const height = Math.min(blockSize, image.height - top) * zoom;
            context.strokeRect(offsetX + left * zoom + 2, offsetY + top * zoom + 2, width - 4, height - 4);
        }
    }

    // Priority tiles: a yellow corner flag.
    if (prioritySupported) {
        const tilesX = Math.ceil(image.width / TILE_SIZE);
        const size = Math.max(4, TILE_SIZE * zoom * 0.4);
        context.fillStyle = "#fd0";
        context.strokeStyle = "#000";
        context.lineWidth = 1;
        for (let tile = 0; tile < priority.length; tile++) {
            if (priority[tile]) {
                const x = offsetX + (tile % tilesX) * TILE_SIZE * zoom;
                const y = offsetY + Math.floor(tile / tilesX) * TILE_SIZE * zoom;
                context.beginPath();
                context.moveTo(x, y);
                context.lineTo(x + size, y);
                context.lineTo(x, y + size);
                context.closePath();
                context.fill();
                context.stroke();
            }
        }
    }
}

function priorityCount() {
    return priority === null ? 0 : priority.reduce((sum, value) => sum + value, 0);
}

// Only Game Boy Color shows the priority brush. Painted flags stay in memory and come back when switching back.
function updatePriorityControls() {
    priorityTool.hidden = !prioritySupported;
    if (!prioritySupported && tool === "priority") {
        setTool("palette");
    }
    const count = prioritySupported ? priorityCount() : 0;
    pngPriorityNote.hidden = count === 0;
    pngPriorityNote.textContent = `${count} priority tile(s). The indexed PNG doesn't store priority; only the attribute export has it.`;
}

function setTool(name) {
    tool = name;
    paletteTool.setAttribute("aria-pressed", String(name === "palette"));
    priorityTool.setAttribute("aria-pressed", String(name === "priority"));
}

// Lines sit on whole or half pixels (by line width) so they stay crisp, clamped inside the image.
function strokeGrid(cellSize, lineWidth) {
    const width = image.width * zoom;
    const height = image.height * zoom;
    const half = lineWidth / 2;
    const snap = (value, max) => Math.min(Math.max(Math.floor(value) + (lineWidth % 2) / 2, half), max - half);
    context.lineWidth = lineWidth;
    context.beginPath();
    for (let x = 0; x <= image.width; x += cellSize) {
        const px = offsetX + snap(x * zoom, width);
        context.moveTo(px, offsetY);
        context.lineTo(px, offsetY + height);
    }
    for (let y = 0; y <= image.height; y += cellSize) {
        const py = offsetY + snap(y * zoom, height);
        context.moveTo(offsetX, py);
        context.lineTo(offsetX + width, py);
    }
    context.stroke();
}

function updateStatus() {
    const tilesX = image.width / TILE_SIZE;
    const tilesY = image.height / TILE_SIZE;
    const mixedCount = mixed.reduce((sum, value) => sum + value, 0);
    const mixedText = mixedCount > 0 ? ` — ${mixedCount} block(s) mix palettes (red)` : "";
    const blockText = `${blockSize}×${blockSize} attributes`;
    setStatus(`${image.width}×${image.height} px, ${tilesX}×${tilesY} tiles, ${blockText}${mixedText}`, false);
}

function assignBlock(block) {
    if (attributes[block] === activeRow && !mixed[block]) {
        return;
    }
    recordStroke();
    attributes[block] = activeRow;
    mixed[block] = 0;
    forEachBlockPixel(block, (pixel) => {
        image.indexes[pixel] = activeRow * columns + (image.indexes[pixel] % columns);
    });
    renderImage();
    drawCanvas();
    updateStatus();
}

// A stroke that starts on a priority tile clears priority, otherwise it sets it.
function assignPriority(tile) {
    if (!strokeRecorded) {
        priorityStrokeValue = priority[tile] ? 0 : 1;
    }
    if (priority[tile] === priorityStrokeValue) {
        return;
    }
    recordStroke();
    priority[tile] = priorityStrokeValue;
    drawCanvas();
    updatePriorityControls();
}

function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [
        (event.clientX - rect.left) * canvas.width / rect.width,
        (event.clientY - rect.top) * canvas.height / rect.height,
    ];
}

function paintAt(event) {
    if (attributes === null) {
        return;
    }
    const cell = tool === "priority" ? TILE_SIZE : blockSize;
    const [canvasX, canvasY] = canvasPoint(event);
    const x = Math.floor((canvasX - offsetX) / zoom / cell);
    const y = Math.floor((canvasY - offsetY) / zoom / cell);
    const cellsX = Math.ceil(image.width / cell);
    if (x < 0 || y < 0 || x >= cellsX || y >= Math.ceil(image.height / cell)) {
        return;
    }
    if (tool === "priority") {
        assignPriority(y * cellsX + x);
    }
    else {
        assignBlock(y * cellsX + x);
    }
}

// One click or drag = one undo step, snapshotted just before its first change.
function recordStroke() {
    if (strokeRecorded) {
        return;
    }
    pushHistory(undoStack);
    redoStack.length = 0;
    strokeRecorded = true;
    updateHistoryButtons();
}

function pushHistory(stack) {
    stack.push({ indexes: image.indexes.slice(), priority: priority.slice() });
    if (stack.length > HISTORY_LIMIT) {
        stack.shift();
    }
}

function stepHistory(from, to) {
    if (attributes === null || from.length === 0) {
        return;
    }
    pushHistory(to);
    ({ indexes: image.indexes, priority } = from.pop());
    applyLayout();
}

function updateHistoryButtons() {
    undoButton.disabled = attributes === null || undoStack.length === 0;
    redoButton.disabled = attributes === null || redoStack.length === 0;
}

undoButton.addEventListener("click", () => stepHistory(undoStack, redoStack));
redoButton.addEventListener("click", () => stepHistory(redoStack, undoStack));
document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) {
        return;
    }
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        stepHistory(undoStack, redoStack);
    }
    else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        stepHistory(redoStack, undoStack);
    }
});

// Left drag paints; middle drag or Space + left drag pans; the wheel zooms around the cursor.
canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
        event.preventDefault();
        pan = { x: event.clientX, y: event.clientY, offsetX, offsetY };
        canvas.classList.add("panning");
    }
    else if (event.button === 0) {
        strokeRecorded = false;
        paintAt(event);
    }
});
canvas.addEventListener("pointermove", (event) => {
    if (pan !== null) {
        offsetX = pan.offsetX + event.clientX - pan.x;
        offsetY = pan.offsetY + event.clientY - pan.y;
        fitMode = false;
        drawCanvas();
    }
    else if (event.buttons & 1) {
        paintAt(event);
    }
});
for (const type of ["pointerup", "pointercancel"]) {
    canvas.addEventListener(type, () => {
        pan = null;
        canvas.classList.remove("panning");
    });
}
// Stops the browser's middle-click autoscroll.
canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) {
        event.preventDefault();
    }
});
canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (attributes === null) {
        return;
    }
    const current = ZOOM_LEVELS.indexOf(zoom);
    const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, current + (event.deltaY < 0 ? 1 : -1)));
    if (next !== current) {
        zoomAt(ZOOM_LEVELS[next], ...canvasPoint(event));
    }
}, { passive: false });

function setSpaceHeld(event, held) {
    if (event.code !== "Space" || event.target.matches("input, select, textarea")) {
        return;
    }
    event.preventDefault();
    spaceHeld = held;
    canvas.classList.toggle("grab", held);
}
document.addEventListener("keydown", (event) => setSpaceHeld(event, true));
document.addEventListener("keyup", (event) => setSpaceHeld(event, false));

// A Tiled map (.tmx/.tmj) is selected together with its tileset (.tsx/.tsj) and image files; otherwise the first PNG is loaded.
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
            loaded = await decodeIndexedPng(await mainFile.arrayBuffer());
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
            loaded = flattenLayer(map, layer);
            if (map.layers.length > 1) {
                label += ` — ${layer.name}`;
                name += `_${layer.name.replace(/[^\w-]+/g, "_")}`;
            }
        }
    }
    catch (caught) {
        loaded = null;
        error = caught.message;
    }
    sourceName = name;
    sourceFilename.textContent = label;
    undoStack.length = 0;
    redoStack.length = 0;
    fitMode = true;
    image = loaded;
    priority = image === null ? null
        : new Uint8Array(Math.ceil(image.width / TILE_SIZE) * Math.ceil(image.height / TILE_SIZE));
    applyLayout();
    if (error !== null) {
        setStatus(error, true);
    }
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

document.getElementById("input_field").addEventListener("click", () => imageSelector.click());
imageSelector.addEventListener("change", () => {
    if (imageSelector.files !== null && imageSelector.files.length > 0) {
        void loadFiles(imageSelector.files);
    }
});
document.body.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = "copy";
    }
});
document.body.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null && event.dataTransfer.files.length > 0) {
        void loadFiles(event.dataTransfer.files);
    }
});

systemSelect.addEventListener("change", applyLayout);
fineAttributes.addEventListener("change", applyLayout);
zoomInput.addEventListener("change", () => {
    if (zoomInput.value === "fit") {
        fitMode = true;
        drawCanvas();
    }
    else if (attributes !== null) {
        zoomAt(Number(zoomInput.value), canvas.width / 2, canvas.height / 2);
    }
});
gridVisible.addEventListener("change", drawCanvas);
paletteTool.addEventListener("click", () => setTool("palette"));
priorityTool.addEventListener("click", () => setTool("priority"));
gridColor.addEventListener("input", drawCanvas);
gridOpacity.addEventListener("input", drawCanvas);
new ResizeObserver(drawCanvas).observe(editorView);

downloadButton.addEventListener("click", async () => {
    const total = columns * rows;
    const paletteData = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
        const [r, g, b] = storedColor(i);
        paletteData.set([b, g, r, 0], i * 4);
    }
    // Encoder expects bottom-up rows padded to four bytes.
    const rowStride = Math.ceil(image.width / 4) * 4;
    const colorIndexes = new Uint8Array(rowStride * image.height);
    for (let y = 0; y < image.height; y++) {
        const row = image.indexes.subarray(y * image.width, (y + 1) * image.width);
        colorIndexes.set(row, (image.height - 1 - y) * rowStride);
    }
    const encoded = await encodeIndexedPng({
        width: image.width,
        height: image.height,
        totalPaletteColors: total,
        colorsPerPalette: columns,
        transparentIndexZero: image.alpha !== null && image.alpha.length > 0 && image.alpha[0] === 0,
        paletteData,
        colorIndexes,
    });
    downloadBlob(new Blob([encoded], { type: "image/png" }), `${sourceName}_attr.png`);
});

function downloadBlob(blob, fileName) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

// value: [label, file suffix]. Mega Drive has no export (the palette lives in each tile's map word).
// NES with 8×8 Attributes exports MMC5 ExRAM bytes instead: the standard attribute table only has 16×16 areas.
const ATTRIBUTE_FORMATS = {
    nes: {
        bin: ["Binary", ".bin"],
        "asm-byte": ["ASM (.byte) — ca65", ".s"],
        "asm-db": ["ASM (.db) — asm6 / NESASM", ".asm"],
        c: ["C Source", ".c"],
        "c-rle": ["C + RLE (NESlib)", "_rle.c"],
    },
    "nes-mmc5": {
        bin: ["Binary — MMC5 ExRAM", "_mmc5.bin"],
        "asm-byte": ["ASM (.byte) — MMC5 ExRAM, ca65", "_mmc5.s"],
        "asm-db": ["ASM (.db) — MMC5 ExRAM, asm6 / NESASM", "_mmc5.asm"],
        c: ["C Source — MMC5 ExRAM", "_mmc5.c"],
    },
    gbc: {
        bin: ["Binary", ".bin"],
        c: ["C Source — GBDK", ".c"],
        "c-rle": ["C + RLE — GBDK", "_rle.c"],
        "c-gb": ["C + GB (GBTD) — GBDK", "_gb.c"],
        "c-zx0": ["C + ZX0 — GBDK", "_zx0.c"],
        "asm-gbdk": ["ASM (.db) — GBDK", ".s"],
        "asm-rgbds": ["ASM (db) — RGBDS", ".inc"],
    },
};

function exportKind() {
    return systemSelect.value === "nes" && blockSize === TILE_SIZE ? "nes-mmc5" : systemSelect.value;
}

function updateAttributeExport() {
    const kind = exportKind();
    const formats = ATTRIBUTE_FORMATS[kind];
    attributeFormat.hidden = !formats;
    attributeDownload.hidden = !formats;
    if (formats && attributeFormat.dataset.kind !== kind) {
        attributeFormat.dataset.kind = kind;
        attributeFormat.replaceChildren(...Object.entries(formats).map(([value, [label]]) => new Option(label, value)));
    }
    const reason = attributes === null ? "Load an image or map first." : "";
    attributeDownload.disabled = reason !== "";
    attributeDownload.title = reason;
}

attributeDownload.addEventListener("click", () => {
    const kind = exportKind();
    const format = attributeFormat.value;
    const fileName = `${sourceName}_attr${ATTRIBUTE_FORMATS[kind][format][1]}`;
    const label = nesAttributeLabel(sourceName);
    const source = sourceFilename.textContent;
    const blocksX = Math.ceil(image.width / blockSize);
    const blocksY = Math.ceil(image.height / blockSize);
    let data;
    if (kind === "gbc") {
        data = formatGbcAttributes(attributes, blocksX, format, label, source, priority);
    }
    else {
        const mmc5 = kind === "nes-mmc5";
        const table = mmc5 ? packMmc5Attributes(attributes, blocksX, blocksY) : packNesAttributes(attributes, blocksX, blocksY);
        data = format === "bin" ? table.bytes : formatNesAttributes(table, format, mmc5 ? `${label}_mmc5` : label, source);
    }
    const blob = new Blob([data], { type: typeof data === "string" ? "text/plain" : "application/octet-stream" });
    downloadBlob(blob, fileName);
    const mixedCount = mixed.reduce((sum, value) => sum + value, 0);
    if (mixedCount > 0) {
        setStatus(`Exported ${fileName} with ${mixedCount} mixed block(s) — they use their majority palette.`, true);
    }
});

applyLayout();
