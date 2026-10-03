const body = document.getElementById("body");
const imageSelector = document.getElementById("image_selector");
const tileWidthInput = document.getElementById("tile_width");
const tileHeightInput = document.getElementById("tile_height");
const numPalettesInput = document.getElementById("palette_num");
const colorsPerPaletteInput = document.getElementById("colors_per_palette");
const bitsPerChannelInput = document.getElementById("bits_per_channel");
const fractionOfPixelsInput = document.getElementById("fraction_of_pixels");
const colorSpaceInput = document.getElementById("color_space");
const colorFitInput = document.getElementById("color_fit");
const seedInput = document.getElementById("seed");
const lastSeedOutput = document.getElementById("last_seed");
const chromaWeightInput = document.getElementById("chroma_weight");
const chromaWeightValue = document.getElementById("chroma_weight_value");
const colorFitRow = document.getElementById("color_fit_row");
const chromaWeightRow = document.getElementById("chroma_weight_row");
const integerInputs = [
    [tileWidthInput, 8],
    [tileHeightInput, 8],
    [numPalettesInput, 1],
    [colorsPerPaletteInput, 16],
    [bitsPerChannelInput, 4],
];
function validateIntegerInput(numberInput) {
    const [inputElement, defaultValue] = numberInput;
    let num = parseInt(inputElement.value, radix);
    if (isNaN(num))
        num = defaultValue;
    const min = parseInt(inputElement.min, radix);
    const max = parseInt(inputElement.max, radix);
    if (num < min)
        num = min;
    if (num > max)
        num = max;
    inputElement.value = num.toString();
}
function validateFloatInput(numberInput) {
    const [inputElement, defaultValue] = numberInput;
    let num = parseFloat(inputElement.value);
    if (isNaN(num))
        num = defaultValue;
    const min = parseFloat(inputElement.min);
    const max = parseFloat(inputElement.max);
    if (num < min)
        num = min;
    if (num > max)
        num = max;
    inputElement.value = num.toFixed(2);
}
const uniqueInput = document.getElementById("unique");
const sharedInput = document.getElementById("shared");
const specificSharedInput = document.getElementById("specific_shared");
const transparentFromTransparentInput = document.getElementById("transparent_from_transparent");
const transparentFromColorInput = document.getElementById("transparent_from_color");
const indexZeroButtons = [
    uniqueInput,
    sharedInput,
    specificSharedInput,
    transparentFromTransparentInput,
    transparentFromColorInput,
];
const indexZeroValues = [
    ColorZeroBehaviour.Unique,
    ColorZeroBehaviour.Shared,
    ColorZeroBehaviour.SpecificShared,
    ColorZeroBehaviour.TransparentFromTransparent,
    ColorZeroBehaviour.TransparentFromColor,
];
const colorZeroAbbreviations = ["u", "s", "ss", "t", "tc"];
const sharedColorInput = document.getElementById("shared_color");
const transparentColorInput = document.getElementById("transparent_color");
const defaultColorInput = document.createElement("input");
defaultColorInput.value = "#000000";
const colorValues = [
    defaultColorInput,
    defaultColorInput,
    sharedColorInput,
    transparentColorInput,
    transparentColorInput,
];

const ditherOffInput = document.getElementById("dither_off");
const ditherFastInput = document.getElementById("dither_fast");
const ditherSlowInput = document.getElementById("dither_slow");
const ditherButtons = [ditherOffInput, ditherFastInput, ditherSlowInput];
const ditherValues = [Dither.Off, Dither.Fast, Dither.Slow];
const ditherWeightInput = document.getElementById("dither_weight");
const ditherDiagonal4Input = document.getElementById("dither_diagonal4");
const ditherHorizontal4Input = document.getElementById("dither_horizontal4");
const ditherVertical4Input = document.getElementById("dither_vertical4");
const ditherDiagonal2Input = document.getElementById("dither_diagonal2");
const ditherHorizontal2Input = document.getElementById("dither_horizontal2");
const ditherVertical2Input = document.getElementById("dither_vertical2");
const ditherPatternButtons = [
    ditherDiagonal4Input,
    ditherHorizontal4Input,
    ditherVertical4Input,
    ditherDiagonal2Input,
    ditherHorizontal2Input,
    ditherVertical2Input,
];
const ditherPatternValues = [
    DitherPattern.Diagonal4,
    DitherPattern.Horizontal4,
    DitherPattern.Vertical4,
    DitherPattern.Diagonal2,
    DitherPattern.Horizontal2,
    DitherPattern.Vertical2,
];

let sourceImageName = "Saldana";
let sourceImagePreview = document.getElementById("source_img");
let sourceImageFilename = document.getElementById("source_filename");
sourceImagePreview.parentElement.onclick = () => imageSelector.click();

body.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer == null)
        return;
    event.dataTransfer.dropEffect = "move";
});

body.addEventListener("drop", (event) => {
    event.preventDefault();
    const dt = event.dataTransfer;
    if (dt == null)
        return;
    if (dt.files.length > 0) {
        const file = dt.files[0];
        if (file.type.substring(0, 6) === "image/") {
            sourceImageName = file.name.substring(0, file.name.lastIndexOf("."));
            sourceImagePreview.src = URL.createObjectURL(file);
        }
    }
});

// empty seed input = new random seed each run; shown so a good result can be repeated
function chooseSeed() {
    const typed = parseInt(seedInput.value, radix);
    const seed = Number.isNaN(typed) ? Math.floor(Math.random() * 2 ** 32) : typed >>> 0;
    lastSeedOutput.value = "used: " + seed;
    return seed;
}

// best-fit models only apply to NES; chroma weight only to the Lab models
function updateColorFitRows() {
    colorFitRow.hidden = colorSpaceInput.value !== "nes";
    chromaWeightRow.hidden = colorFitRow.hidden || !["cielab", "oklab"].includes(colorFitInput.value);
    chromaWeightValue.value = chromaWeightInput.value;
}
colorSpaceInput.addEventListener("change", updateColorFitRows);
colorFitInput.addEventListener("change", updateColorFitRows);
chromaWeightInput.addEventListener("input", updateColorFitRows);
updateColorFitRows();

imageSelector.addEventListener("change", () => {
    if (imageSelector.files == null)
        return;
    if (imageSelector.files.length > 0) {
        const file = imageSelector.files[0];
        sourceImageName = file.name.substring(0, file.name.lastIndexOf("."));
        const imgUrl = URL.createObjectURL(file);
        sourceImagePreview.src = imgUrl;
        sourceImageFilename.innerHTML = file.name;
    }
});

document.getElementById('dither_settings').addEventListener('change', el => {
    if (el.target.type === 'radio') {
      const isOff = document.getElementById("dither_off").checked;
      document.querySelectorAll("fieldset .disableable").forEach(fs => {
          if (isOff) {
            fs.setAttribute("disabled", "");   
          } else {
            fs.removeAttribute("disabled");
          }
      });
    }
});

let inProgress = false;
let quantizedImageDownload = document.createElement("a");
let palettesImageDownload = document.createElement("a");
let quantizedImage = document.createElement("canvas");
let palettesImage = document.createElement("canvas");
let currentResult = null;
let latestQuantizedImageData = null;
let latestPaletteCheckpoint = null;
let currentSourceImageData = null;
let currentQuantizationOptions = null;
let cancellationStatus = null;
let worker = null;
const quantizeButton = document.getElementById("quantizeButton");
const cancelButton = document.getElementById("cancelButton");
const quantizedImages = document.getElementById("quantized_images");
const progress = document.getElementById("progress");
const radix = 10;

function setProcessingState(processing) {
    inProgress = processing;
    quantizeButton.disabled = processing;
    cancelButton.disabled = !processing;
}

function cancelQuantization() {
    if (!inProgress || worker === null)
        return;
    worker.terminate();
    worker = null;
    if (currentQuantizationOptions !== null &&
        currentQuantizationOptions.dither !== Dither.Off &&
        latestPaletteCheckpoint !== null &&
        currentSourceImageData !== null) {
        cancellationStatus = appendResultStatus(
            currentResult,
            "Canceled — applying dithering to partial result…",
            "partial-result-status",
        );
        const finishingWorker = new Worker("./js/worker.js");
        worker = finishingWorker;
        setWorkerMessageHandler(finishingWorker, true);
        cancelButton.disabled = true;
        finishingWorker.postMessage({
            action: Action.FinishPartial,
            imageData: currentSourceImageData,
            palettes: latestPaletteCheckpoint,
            quantizationOptions: currentQuantizationOptions,
        });
        return;
    }
    finishCanceledResult("Canceled — partial result");
}

function finishCanceledResult(statusText) {
    setProcessingState(false);
    void finalizeQuantizedDownload(
        quantizedImageDownload,
        quantizedImage,
        latestQuantizedImageData,
        currentResult,
    );
    if (cancellationStatus === null) {
        cancellationStatus = appendResultStatus(
            currentResult,
            statusText,
            "partial-result-status",
        );
    }
    else {
        cancellationStatus.textContent = statusText;
    }
}

async function finalizeQuantizedDownload(target, canvas, imageData, result) {
    if (imageData === null)
        return;
    if (imageData.totalPaletteColors > 256) {
        target.href = canvas.toDataURL();
        appendResultStatus(
            result,
            "Indexed PNG supports at most 256 palette entries; this download uses RGB.",
            "result-warning",
        );
        return;
    }
    try {
        const encoded = await encodeIndexedPng(imageData);
        const url = URL.createObjectURL(new Blob([encoded], { type: "image/png" }));
        if (target.indexedPngObjectUrl) {
            URL.revokeObjectURL(target.indexedPngObjectUrl);
        }
        target.indexedPngObjectUrl = url;
        target.href = url;
    }
    catch (error) {
        console.error("Indexed PNG export failed", error);
        target.href = canvas.toDataURL();
        appendResultStatus(
            result,
            "Indexed PNG export failed; this download uses RGB.",
            "result-warning",
        );
    }
}

function appendResultStatus(result, text, className) {
    if (result === null)
        return null;
    for (const child of result.children) {
        if (child.textContent === text)
            return child;
    }
    const status = document.createElement("div");
    status.className = className;
    status.textContent = text;
    result.appendChild(status);
    return status;
}

let sourceImageReal = new Image();
quantizeButton.addEventListener("click", () => {
    // Dereference image loading to avoid quirks with client-side width/height adjustments
    sourceImageReal.onload = () => {
        quantizeSourceImage(sourceImageReal);
    };
    sourceImageReal.src = document.getElementById("source_img").src;
});
cancelButton.addEventListener("click", cancelQuantization);

function quantizeSourceImage(sourceImage) {
    if (inProgress)
        return;
    setProcessingState(true);

    quantizedImage = document.createElement("canvas");
    quantizedImage.width = sourceImage.width;
    quantizedImage.height = sourceImage.height;
    quantizedImage.title = "Click to download quantized image";
    quantizedImageDownload = document.createElement("a");
    quantizedImageDownload.appendChild(quantizedImage);

    palettesImage = document.createElement("canvas");
    palettesImage.width = 16;
    palettesImage.height = sourceImage.height;
    palettesImage.title = "Click to download palette image";
    palettesImageDownload = document.createElement("a");
    palettesImageDownload.appendChild(palettesImage);

    currentResult = document.createElement("div");
    currentResult.appendChild(quantizedImageDownload);
    currentResult.appendChild(palettesImageDownload);
    quantizedImages.prepend(currentResult);
    latestQuantizedImageData = null;
    latestPaletteCheckpoint = null;
    cancellationStatus = null;
    
    integerInputs.forEach(validateIntegerInput);
    validateFloatInput([fractionOfPixelsInput, 0.1]);
    validateFloatInput([ditherWeightInput, 0.5]);
    const colorZeroBehaviour = selectedValue(indexZeroButtons, indexZeroValues);
    const colorInput = selectedValue(indexZeroButtons, colorValues);
    const colorZeroValue = hexToColor(colorInput.value);
    const ditherMethod = selectedValue(ditherButtons, ditherValues);
    const ditherPattern = selectedValue(ditherPatternButtons, ditherPatternValues);
    const colorZeroAbbreviation = selectedValue(indexZeroButtons, colorZeroAbbreviations);
    const colorSpace = colorSpaceInput.value;
    const settingsStr = `${{ megadrive: "-MD", nes: "-NES" }[colorSpace] ?? ""}-${tileWidthInput.value}x${tileHeightInput.value}-${numPalettesInput.value}p${colorsPerPaletteInput.value}c-${colorZeroAbbreviation}`;
    const totalPaletteColors = parseInt(numPalettesInput.value, radix) *
        parseInt(colorsPerPaletteInput.value, radix);
    if (totalPaletteColors > 256) {
        appendResultStatus(
            currentResult,
            "Indexed PNG supports at most 256 palette entries; this download uses RGB.",
            "result-warning",
        );
    }
    
    /*
    if (totalPaletteColors > 256) {
        quantizedImageDownload.download =
            sourceImageName + settingsStr + ".png";
    }
    else {
        quantizedImageDownload.download =
            sourceImageName + settingsStr + ".bmp";
    }
    */
    quantizedImageDownload.download = sourceImageName + settingsStr + ".png";
    
    palettesImageDownload.download =
        sourceImageName + settingsStr + "-palette.png";
    currentSourceImageData = imageDataFrom(sourceImage);
    currentQuantizationOptions = {
        tileWidth: parseInt(tileWidthInput.value, radix),
        tileHeight: parseInt(tileHeightInput.value, radix),
        numPalettes: parseInt(numPalettesInput.value, radix),
        colorsPerPalette: parseInt(colorsPerPaletteInput.value, radix),
        bitsPerChannel: parseInt(bitsPerChannelInput.value, radix),
        fractionOfPixels: parseFloat(fractionOfPixelsInput.value),
        colorZeroBehaviour: colorZeroBehaviour,
        colorZeroValue: colorZeroValue,
        dither: ditherMethod,
        ditherWeight: parseFloat(ditherWeightInput.value),
        ditherPattern: ditherPattern,
        colorSpace: colorSpace,
        colorFit: colorFitInput.value,
        seed: chooseSeed(),
        chromaWeight: parseFloat(chromaWeightInput.value),
    };
    if (worker)
        worker.terminate();
    const quantizationWorker = new Worker("./js/worker.js");
    worker = quantizationWorker;
    setWorkerMessageHandler(quantizationWorker, false);
    quantizationWorker.postMessage({
        action: Action.StartQuantization,
        imageData: currentSourceImageData,
        quantizationOptions: currentQuantizationOptions,
    });
}

function setWorkerMessageHandler(activeWorker, completingCanceledResult) {
    if (completingCanceledResult) {
        activeWorker.onerror = function (error) {
            if (worker !== activeWorker)
                return;
            if (error)
                console.error("Partial-result dithering failed", error);
            activeWorker.terminate();
            worker = null;
            finishCanceledResult("Canceled — partial result (dithering failed)");
        };
    }
    activeWorker.onmessage = function (event) {
        if (worker !== activeWorker)
            return;
        const data = event.data;
        if (data.action === Action.UpdateProgress) {
            progress.value = data.progress;
        }
        else if (data.action === Action.DoneQuantization) {
            activeWorker.terminate();
            worker = null;
            if (completingCanceledResult) {
                finishCanceledResult("Canceled — partial result (dithered)");
            }
            else {
                void finalizeQuantizedDownload(
                    quantizedImageDownload,
                    quantizedImage,
                    latestQuantizedImageData,
                    currentResult,
                );
                setProcessingState(false);
            }
        }
        else if (data.action === Action.UpdateQuantizedImage) {
            const imageData = data.imageData;
            latestQuantizedImageData = imageData;
            const quantizedImageData = new window.ImageData(imageData.width, imageData.height);
            for (let i = 0; i < imageData.data.length; i++) {
                quantizedImageData.data[i] = imageData.data[i];
            }
            quantizedImage.width = imageData.width;
            quantizedImage.height = imageData.height;
            const ctx = quantizedImage.getContext("2d");
            ctx.putImageData(quantizedImageData, 0, 0);
            
            /*
            if (imageData.totalPaletteColors > 256) {
                quantizedImageDownload.href = quantizedImage.toDataURL();
            }
            else {
                quantizedImageDownload.href = bmpToDataURL(imageData.width, imageData.height, imageData.paletteData, imageData.colorIndexes);
            }
            */
        }
        else if (data.action === Action.UpdatePalettes) {
            latestPaletteCheckpoint = data.checkpointPalettes;
            const palettes = data.palettes;
            const paletteDisplayHeight = 8;
            const paletteDisplayWidth = Math.min(8, Math.ceil(512 / data.numColors));
            palettesImage.width = data.numColors * paletteDisplayWidth;
            palettesImage.height = data.numPalettes * paletteDisplayHeight;
            const palCtx = palettesImage.getContext("2d");
            for (let j = 0; j < palettes.length; j += 1) {
                for (let i = 0; i < palettes[j].length; i += 1) {
                    palCtx.fillStyle = `rgb(
                        ${Math.round(palettes[j][i][0])},
                        ${Math.round(palettes[j][i][1])},
                        ${Math.round(palettes[j][i][2])})`;
                    palCtx.fillRect(i * paletteDisplayWidth, j * paletteDisplayHeight, paletteDisplayWidth, paletteDisplayHeight);
                }
            }
            palettesImageDownload.href = palettesImage.toDataURL();
        }
    };
}

function hexToColor(colorStr) {
    return [
        parseInt(colorStr.slice(1, 3), 16),
        parseInt(colorStr.slice(3, 5), 16),
        parseInt(colorStr.slice(5, 7), 16),
    ];
}

function selectedValue(radioInputs, values) {
    for (let i = 0; i < radioInputs.length; i++) {
        if (radioInputs[i].checked) {
            return values[i];
        }
    }
    throw "No radio inputs selected";
}

function imageDataFrom(img) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = img.width;
    canvas.height = img.height;
    context.drawImage(img, 0, 0);
    return context.getImageData(0, 0, img.width, img.height);
}

function bmpToDataURL(width, height, paletteData, colorIndexes) {
    const bmpFileSize = 54 + paletteData.length + colorIndexes.length;
    const bmpData = new Uint8ClampedArray(bmpFileSize);
    bmpData[0] = 66;
    bmpData[1] = 77;
    write32Le(bmpData, 2, bmpFileSize);
    write32Le(bmpData, 6, 0);
    write32Le(bmpData, 0xa, 54 + paletteData.length);
    write32Le(bmpData, 0xe, 40);
    write32Le(bmpData, 0x12, width);
    write32Le(bmpData, 0x16, height);
    write16Le(bmpData, 0x1a, 1);
    write16Le(bmpData, 0x1c, 8);
    write32Le(bmpData, 0x1e, 0);
    write32Le(bmpData, 0x22, colorIndexes.length);
    write32Le(bmpData, 0x26, 2835);
    write32Le(bmpData, 0x2a, 2835);
    write32Le(bmpData, 0x2e, 256);
    write32Le(bmpData, 0x32, 0);
    for (let i = 0; i < paletteData.length; i++) {
        bmpData[i + 54] = paletteData[i];
    }
    const imageDataAddress = 54 + paletteData.length;
    for (let i = 0; i < colorIndexes.length; i++) {
        bmpData[i + imageDataAddress] = colorIndexes[i];
    }
    return "data:image/bmp;base64," + uint8ToBase64(bmpData);
}

function uint8ToBase64(arr) {
    return btoa(Array(arr.length)
        .fill("")
        .map((_, i) => String.fromCharCode(arr[i]))
        .join(""));
}

function write32Le(bmpData, index, value) {
    bmpData[index] = value % 256;
    value = Math.floor(value / 256);
    bmpData[index + 1] = value % 256;
    value = Math.floor(value / 256);
    bmpData[index + 2] = value % 256;
    value = Math.floor(value / 256);
    bmpData[index + 3] = value % 256;
}

function write16Le(bmpData, index, value) {
    bmpData[index] = value % 256;
    value = Math.floor(value / 256);
    bmpData[index + 1] = value % 256;
}
