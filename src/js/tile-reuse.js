"use strict";

const reuseSelector = document.getElementById("reuse_selector");
const reuseInput = document.getElementById("reuse_input");
const reuseChoose = document.getElementById("reuse_choose");
const reuseFilename = document.getElementById("reuse_filename");
const reuseSystem = document.getElementById("reuse_system");
const reuseStats = document.getElementById("reuse_stats");
const reuseDiagnostics = document.getElementById("reuse_diagnostics");
const reuseDownload = document.getElementById("reuse_download");
const reuseStatus = document.getElementById("reuse_status");
const sourceCanvas = document.getElementById("reuse_source_canvas");
const resultCanvas = document.getElementById("reuse_result_canvas");
const sourceEmpty = document.getElementById("reuse_source_empty");
const resultEmpty = document.getElementById("reuse_result_empty");

let sourceName = "image";
let input = null;
let result = null;
let worker = null;
let jobId = 0;
let loadId = 0;
let loadError = null;

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
        drawPixels(resultCanvas, result.width, result.height, result.preview);
        const details = result.optimization;
        const error = Math.sqrt(details.meanSquaredError).toFixed(2);
        const tileChange = details.applied ? `${details.originalTileCount} -> ${result.tileCount}` : `${result.tileCount}`;
        reuseStats.textContent = `${result.width}x${result.height} px, ${tileChange} unique tiles, `
            + `${details.substitutions} substitution(s), RGB error ${error}`;
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
    reuseStats.textContent = "This image cannot be optimized until its palette or dimensions are valid.";
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
        ? `Optimization complete. ${result.optimization.substitutions} tile substitution(s).`
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
    const message = {
        id,
        input,
        options: { system: reuseSystem.value, autoShades: true, optimizeTiles: true },
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
                finish(id, convertBackgroundAsset(input, message.options));
            }
            catch (error) {
                finish(id, { ok: false, diagnostics: [{ message: error.message, hint: "" }] });
            }
        };
        current.postMessage(message);
    }
    catch {
        finish(id, convertBackgroundAsset(input, message.options));
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
    reuseFilename.textContent = file.name;
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
    sourceCanvas.hidden = true;
    sourceEmpty.hidden = false;
    render();
    try {
        const loaded = await readPng(file);
        if (id !== loadId) return;
        input = loaded;
        loadError = null;
        sourceName = file.name.replace(/\.[^.]+$/, "") || "image";
        drawPixels(sourceCanvas, input.width, input.height, input.rgba);
        sourceCanvas.hidden = false;
        sourceEmpty.hidden = true;
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
        const encoded = await encodeIndexedPng(optimizedPngImage(downloadedResult));
        if (result !== downloadedResult) return;
        downloadBlob(new Blob([encoded], { type: "image/png" }), `${downloadedName}_optimized.png`);
    }
    catch (error) {
        announce(`PNG export failed: ${error.message}`);
    }
    finally {
        if (result === downloadedResult) reuseDownload.disabled = false;
    }
});
reuseSelector.addEventListener("change", () => loadFile(reuseSelector.files[0]));
reuseSystem.addEventListener("change", optimize);
reuseChoose.addEventListener("click", () => reuseSelector.click());
reuseInput.addEventListener("click", (event) => {
    if (event.target !== reuseChoose && event.target !== reuseSelector) reuseSelector.click();
});
reuseInput.addEventListener("dragover", (event) => event.preventDefault());
reuseInput.addEventListener("drop", (event) => {
    event.preventDefault();
    loadFile([...event.dataTransfer.files].find((file) => /\.png$/i.test(file.name)));
});

sourceCanvas.hidden = true;
resultCanvas.hidden = true;
render();
