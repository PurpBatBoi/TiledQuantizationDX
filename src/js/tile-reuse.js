"use strict";

const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const PASTEBOARD_COLOR = "#161616";

const reuseSelector = document.getElementById("reuse_selector");
const reuseInput = document.getElementById("reuse_input");
const reuseChoose = document.getElementById("reuse_choose");
const reuseFilename = document.getElementById("reuse_filename");
const reuseFlips = document.getElementById("reuse_flips");
const reuseTarget = document.getElementById("reuse_target");
const reuseTolerance = document.getElementById("reuse_tolerance");
const reuseToleranceValue = document.getElementById("reuse_tolerance_value");
const reuseStats = document.getElementById("reuse_stats");
const reuseDiagnostics = document.getElementById("reuse_diagnostics");
const reuseDownload = document.getElementById("reuse_download");
const reuseStatus = document.getElementById("reuse_status");
const sourceCanvas = document.getElementById("reuse_source_canvas");
const resultCanvas = document.getElementById("reuse_result_canvas");
const sourceEmpty = document.getElementById("reuse_source_empty");
const resultEmpty = document.getElementById("reuse_result_empty");
const zoomInput = document.getElementById("reuse_zoom");
const gridVisible = document.getElementById("reuse_grid");
const gridColor = document.getElementById("reuse_grid_color");
const gridOpacity = document.getElementById("reuse_grid_opacity");
const panTool = document.getElementById("reuse_tool_pan");
const keepTool = document.getElementById("reuse_tool_keep");
const clearKept = document.getElementById("reuse_clear_kept");
// Full-size images; the preview canvases draw them through the shared viewport.
const sourceImage = document.createElement("canvas");
const resultImage = document.createElement("canvas");
// Both previews share one viewport like the Attribute Editor's, so the source and the result stay aligned.
const view = { zoom: 1, offsetX: 0, offsetY: 0, fitMode: true, pan: null };

let sourceName = "image";
let input = null;
let result = null;
let worker = null;
let jobId = 0;
let loadId = 0;
let loadError = null;
// Keep brush: one flag per 8×8 cell of the source. Kept cells' tiles are retained first, so they stay exact.
let kept = null;
let keepStroke = null;
let tool = "pan";
let spaceHeld = false;

function announce(message) {
    reuseStatus.textContent = message;
}

function drawPixels(canvas, width, height, pixels) {
    canvas.width = width;
    canvas.height = height;
    if (width === 0 || height === 0) return;
    const image = new ImageData(width, height);
    image.data.set(pixels);
    canvas.getContext("2d").putImageData(image, 0, 0);
}

function fitView(canvas) {
    const scale = Math.min(canvas.clientWidth / sourceImage.width, canvas.clientHeight / sourceImage.height);
    view.zoom = ZOOM_LEVELS.filter((level) => level <= scale).pop() ?? ZOOM_LEVELS[0];
    view.offsetX = Math.round((canvas.clientWidth - sourceImage.width * view.zoom) / 2);
    view.offsetY = Math.round((canvas.clientHeight - sourceImage.height * view.zoom) / 2);
}

function zoomAt(level, anchorX, anchorY) {
    const imageX = (anchorX - view.offsetX) / view.zoom;
    const imageY = (anchorY - view.offsetY) / view.zoom;
    view.zoom = level;
    view.offsetX = Math.round(anchorX - imageX * level);
    view.offsetY = Math.round(anchorY - imageY * level);
    view.fitMode = false;
}

function drawView(canvas, image) {
    const context = canvas.getContext("2d");
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    context.fillStyle = PASTEBOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (canvas.hidden || image.width === 0) return;
    const { zoom, offsetX, offsetY } = view;
    const width = image.width * zoom;
    const height = image.height * zoom;
    context.imageSmoothingEnabled = false;
    context.shadowColor = "#000";
    context.shadowBlur = 16;
    context.drawImage(image, offsetX, offsetY, width, height);
    context.shadowBlur = 0;
    if (gridVisible.checked && 8 * zoom >= 4) {
        // Half-pixel lines stay crisp; the outer ones are clamped inside the image.
        const snap = (value, max) => Math.min(Math.max(Math.floor(value) + 0.5, 0.5), max - 0.5);
        context.strokeStyle = gridColor.value;
        context.globalAlpha = Number(gridOpacity.value);
        context.lineWidth = 1;
        context.beginPath();
        for (let x = 0; x <= image.width; x += 8) {
            context.moveTo(offsetX + snap(x * zoom, width), offsetY);
            context.lineTo(offsetX + snap(x * zoom, width), offsetY + height);
        }
        for (let y = 0; y <= image.height; y += 8) {
            context.moveTo(offsetX, offsetY + snap(y * zoom, height));
            context.lineTo(offsetX + width, offsetY + snap(y * zoom, height));
        }
        context.stroke();
        context.globalAlpha = 1;
    }
    // Kept cells: a yellow corner flag, like the Attribute Editor's priority tiles.
    if (kept !== null) {
        const tilesX = Math.ceil(image.width / 8);
        const size = Math.max(4, 8 * zoom * 0.4);
        context.fillStyle = "#fd0";
        context.strokeStyle = "#000";
        context.lineWidth = 1;
        kept.forEach((flag, cell) => {
            if (!flag) return;
            const x = offsetX + (cell % tilesX) * 8 * zoom;
            const y = offsetY + Math.floor(cell / tilesX) * 8 * zoom;
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(x + size, y);
            context.lineTo(x, y + size);
            context.closePath();
            context.fill();
            context.stroke();
        });
    }
}

function drawViews() {
    if (view.fitMode && sourceImage.width > 0 && !sourceCanvas.hidden) fitView(sourceCanvas);
    drawView(sourceCanvas, sourceImage);
    drawView(resultCanvas, resultImage);
    zoomInput.value = view.fitMode ? "fit" : String(view.zoom);
}

function keptCount() {
    return kept === null ? 0 : kept.reduce((sum, flag) => sum + flag, 0);
}

function setTool(name) {
    tool = name;
    panTool.setAttribute("aria-pressed", String(name === "pan"));
    keepTool.setAttribute("aria-pressed", String(name === "keep"));
    for (const canvas of [sourceCanvas, resultCanvas]) canvas.classList.toggle("brush", name === "keep");
}

// A stroke that starts on a kept cell clears cells, otherwise it marks them.
function paintKept(event) {
    const tilesX = Math.ceil(sourceImage.width / 8);
    const x = Math.floor((event.offsetX - view.offsetX) / view.zoom / 8);
    const y = Math.floor((event.offsetY - view.offsetY) / view.zoom / 8);
    if (x < 0 || y < 0 || x >= tilesX || y >= Math.ceil(sourceImage.height / 8)) return;
    const cell = y * tilesX + x;
    keepStroke.value ??= kept[cell] ? 0 : 1;
    if (kept[cell] === keepStroke.value) return;
    kept[cell] = keepStroke.value;
    keepStroke.changed = true;
    clearKept.disabled = keptCount() === 0;
    drawViews();
}

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
    try {
        return indexedInput(await decodeIndexedPng(bytes));
    }
    catch {
        const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        bitmap.close();
        return { width: canvas.width, height: canvas.height, rgba: data, indexed: null };
    }
}

function render() {
    reuseDiagnostics.replaceChildren();
    reuseDownload.disabled = result?.ok !== true;
    resultCanvas.hidden = result?.ok !== true;
    resultEmpty.hidden = result?.ok === true;
    if (result?.ok) {
        drawPixels(resultImage, result.width, result.height, result.preview);
        drawViews();
        const error = Math.sqrt(result.meanSquaredError).toFixed(2);
        const tileChange = result.substitutions > 0 ? `${result.originalTileCount} -> ${result.tileCount}` : `${result.tileCount}`;
        const keptText = keptCount() > 0 ? `, ${keptCount()} kept cell(s) using ${result.markedTiles} tile(s)` : "";
        reuseStats.textContent = `${result.width}x${result.height} px, ${tileChange} unique tiles, `
            + `${result.substitutions} substitution(s), RGBA error ${error}${keptText}`;
        if (result.markedTiles > result.tileCount) {
            const item = document.createElement("li");
            item.textContent = `Kept cells use ${result.markedTiles} unique tiles but the target is ${result.tileCount}; `
                + "only the most-used of them stay exact. Raise the target or keep fewer cells.";
            reuseDiagnostics.append(item);
        }
        return;
    }
    if (input === null) {
        reuseStats.textContent = loadError ?? "No image loaded.";
        return;
    }
    if (result === null) {
        reuseStats.textContent = "Optimizing...";
        return;
    }
    reuseStats.textContent = "This image cannot be compressed until its dimensions are valid.";
    for (const diagnostic of result.diagnostics) {
        const item = document.createElement("li");
        item.textContent = `${diagnostic.message} ${diagnostic.hint}`;
        reuseDiagnostics.append(item);
    }
}

function finish(id, converted) {
    if (id !== jobId) return;
    result = converted;
    render();
    announce(result.ok
        ? `Optimization complete. ${result.substitutions} tile substitution(s).`
        : `Optimization failed. ${result.diagnostics.map((item) => item.message).join(" ")}`);
}

function optimize() {
    if (worker !== null) {
        worker.terminate();
        worker = null;
    }
    const id = ++jobId;
    result = null;
    render();
    if (input === null) return;
    // A blank target means no tile limit, leaving the tolerance alone to decide the count.
    const targetTiles = reuseTarget.value.trim() === "" ? Infinity
        : Math.min(65536, Math.max(1, Math.round(Number(reuseTarget.value)) || 256));
    if (targetTiles !== Infinity) reuseTarget.value = targetTiles;
    const message = {
        id,
        input,
        task: "compress",
        options: {
            targetTiles,
            tolerance: Number(reuseTolerance.value),
            flips: reuseFlips.checked === true,
            important: kept,
        },
    };
    try {
        const current = new Worker("js/graphics-worker.js");
        worker = current;
        current.onmessage = ({ data }) => {
            current.terminate();
            if (worker === current) worker = null;
            if (data.error) {
                if (id === jobId) {
                    result = { ok: false, diagnostics: [{ message: data.error, hint: "" }] };
                    render();
                    announce(data.error);
                }
                return;
            }
            finish(data.id, data.result);
        };
        current.onerror = () => {
            current.terminate();
            if (worker === current) worker = null;
            try {
                finish(id, compressTiles(input, message.options));
            }
            catch (error) {
                finish(id, { ok: false, diagnostics: [{ message: error.message, hint: "" }] });
            }
        };
        current.postMessage(message);
    }
    catch {
        finish(id, compressTiles(input, message.options));
    }
}

async function loadFile(file) {
    if (file === undefined || !/\.png$/i.test(file.name)) {
        announce("Choose a PNG file.");
        return;
    }
    const id = ++loadId;
    ++jobId;
    if (worker !== null) {
        worker.terminate();
        worker = null;
    }
    input = null;
    result = null;
    loadError = null;
    kept = null;
    clearKept.disabled = true;
    reuseFilename.textContent = file.name;
    sourceImage.width = 0;
    sourceImage.height = 0;
    sourceCanvas.hidden = true;
    sourceEmpty.hidden = false;
    render();
    try {
        const loaded = await readPng(file);
        if (id !== loadId) return;
        input = loaded;
        loadError = null;
        sourceName = file.name.replace(/\.[^.]+$/, "") || "image";
        drawPixels(sourceImage, input.width, input.height, input.rgba);
        kept = new Uint8Array(Math.ceil(input.width / 8) * Math.ceil(input.height / 8));
        sourceCanvas.hidden = false;
        sourceEmpty.hidden = true;
        view.fitMode = true;
        drawViews();
        optimize();
    }
    catch (error) {
        if (id !== loadId) return;
        input = null;
        result = null;
        loadError = error.message;
        announce(error.message);
        render();
    }
}

function downloadBlob(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

reuseDownload.addEventListener("click", async () => {
    if (!result?.ok) return;
    const downloadedResult = result;
    const downloadedName = sourceName;
    reuseDownload.disabled = true;
    try {
        const blob = await new Promise((resolve) => resultImage.toBlob(resolve, "image/png"));
        if (result !== downloadedResult) return;
        if (blob === null) throw new Error("the browser could not encode the image");
        downloadBlob(blob, `${downloadedName}_compressed.png`);
    }
    catch (error) {
        announce(`PNG export failed: ${error.message}`);
    }
    finally {
        if (result === downloadedResult) reuseDownload.disabled = false;
    }
});
reuseSelector.addEventListener("change", () => loadFile(reuseSelector.files[0]));
reuseFlips.addEventListener("change", optimize);
reuseTarget.addEventListener("change", optimize);
reuseTolerance.addEventListener("input", () => { reuseToleranceValue.textContent = reuseTolerance.value; });
reuseTolerance.addEventListener("change", optimize);
reuseChoose.addEventListener("click", () => reuseSelector.click());
reuseInput.addEventListener("click", (event) => {
    if (event.target !== reuseChoose && event.target !== reuseSelector) reuseSelector.click();
});
reuseInput.addEventListener("dragover", (event) => event.preventDefault());
reuseInput.addEventListener("drop", (event) => {
    event.preventDefault();
    loadFile([...event.dataTransfer.files].find((file) => /\.png$/i.test(file.name)));
});

// On either preview: the Keep brush paints with the left button; otherwise left drag pans. Middle drag or
// Space + drag always pans, and the wheel zooms around the cursor.
for (const canvas of [sourceCanvas, resultCanvas]) {
    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 && event.button !== 1) return;
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        if (event.button === 0 && tool === "keep" && !spaceHeld && kept !== null) {
            keepStroke = { value: null, changed: false };
            paintKept(event);
            return;
        }
        view.pan = { x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
        canvas.classList.add("panning");
    });
    canvas.addEventListener("pointermove", (event) => {
        if (keepStroke !== null) {
            paintKept(event);
            return;
        }
        if (view.pan === null) return;
        view.offsetX = view.pan.offsetX + event.clientX - view.pan.x;
        view.offsetY = view.pan.offsetY + event.clientY - view.pan.y;
        view.fitMode = false;
        drawViews();
    });
    for (const type of ["pointerup", "pointercancel"]) {
        canvas.addEventListener(type, () => {
            view.pan = null;
            canvas.classList.remove("panning");
            // Recompress once per stroke, not per cell.
            if (keepStroke?.changed) optimize();
            keepStroke = null;
        });
    }
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        if (sourceImage.width === 0) return;
        const current = ZOOM_LEVELS.indexOf(view.zoom);
        const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, current + (event.deltaY < 0 ? 1 : -1)));
        if (next !== current) {
            zoomAt(ZOOM_LEVELS[next], event.offsetX, event.offsetY);
            drawViews();
        }
    }, { passive: false });
}
zoomInput.addEventListener("change", () => {
    if (zoomInput.value === "fit") view.fitMode = true;
    else if (sourceImage.width > 0) zoomAt(Number(zoomInput.value), sourceCanvas.clientWidth / 2, sourceCanvas.clientHeight / 2);
    drawViews();
});
gridVisible.addEventListener("change", drawViews);
panTool.addEventListener("click", () => setTool("pan"));
keepTool.addEventListener("click", () => setTool("keep"));
clearKept.addEventListener("click", () => {
    kept?.fill(0);
    clearKept.disabled = true;
    optimize();
});
function setSpaceHeld(event, held) {
    if (event.code !== "Space" || event.target.matches("input, select, textarea, button")) return;
    event.preventDefault();
    spaceHeld = held;
    for (const canvas of [sourceCanvas, resultCanvas]) canvas.classList.toggle("grab", held);
}
document.addEventListener("keydown", (event) => setSpaceHeld(event, true));
document.addEventListener("keyup", (event) => setSpaceHeld(event, false));
gridColor.addEventListener("input", drawViews);
gridOpacity.addEventListener("input", drawViews);
new ResizeObserver(drawViews).observe(document.getElementById("reuse_views"));

sourceCanvas.hidden = true;
resultCanvas.hidden = true;
render();
