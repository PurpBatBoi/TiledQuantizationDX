"use strict";
// we can't import these enums from enums.js, because worker modules are not supported in Firefox
var Action;
(function (Action) {
    Action[Action["StartQuantization"] = 0] = "StartQuantization";
    Action[Action["UpdateProgress"] = 1] = "UpdateProgress";
    Action[Action["UpdateQuantizedImage"] = 2] = "UpdateQuantizedImage";
    Action[Action["UpdatePalettes"] = 3] = "UpdatePalettes";
    Action[Action["DoneQuantization"] = 4] = "DoneQuantization";
    Action[Action["FinishPartial"] = 5] = "FinishPartial";
})(Action || (Action = {}));
var ColorZeroBehaviour;
(function (ColorZeroBehaviour) {
    ColorZeroBehaviour[ColorZeroBehaviour["Unique"] = 0] = "Unique";
    ColorZeroBehaviour[ColorZeroBehaviour["Shared"] = 1] = "Shared";
    ColorZeroBehaviour[ColorZeroBehaviour["SpecificShared"] = 2] = "SpecificShared";
    ColorZeroBehaviour[ColorZeroBehaviour["TransparentFromTransparent"] = 3] = "TransparentFromTransparent";
    ColorZeroBehaviour[ColorZeroBehaviour["TransparentFromColor"] = 4] = "TransparentFromColor";
})(ColorZeroBehaviour || (ColorZeroBehaviour = {}));
function usesSharedColorBehaviour(colorZeroBehaviour) {
    return colorZeroBehaviour === ColorZeroBehaviour.Shared ||
        colorZeroBehaviour === ColorZeroBehaviour.SpecificShared;
}
var Dither;
(function (Dither) {
    Dither[Dither["Off"] = 0] = "Off";
    Dither[Dither["Fast"] = 1] = "Fast";
    Dither[Dither["Slow"] = 2] = "Slow";
})(Dither || (Dither = {}));
let quantizationOptions;
onmessage = async function (event) {
    updateProgress(0);
    const data = event.data;
    quantizationOptions = data.quantizationOptions;
    if (data.action === Action.FinishPartial) {
        await finishPartialImage(data.imageData, data.palettes);
    }
    else {
        await quantizeImage(data.imageData);
    }
    updateProgress(100);
    postMessage({ action: Action.DoneQuantization });
};
function updateProgress(progress) {
    postMessage({ action: Action.UpdateProgress, progress: progress });
}
function updateQuantizedImage(image) {
    postMessage({ action: Action.UpdateQuantizedImage, imageData: image });
}
function updatePalettes(palettes, doSorting) {
    let pal = structuredClone(palettes);
    const colorZeroBehaviour = quantizationOptions.colorZeroBehaviour;
    let startIndex = 0;
    if (colorZeroBehaviour === ColorZeroBehaviour.TransparentFromColor ||
        colorZeroBehaviour === ColorZeroBehaviour.TransparentFromTransparent) {
        startIndex = 1;
        for (const palette of pal) {
            palette.unshift(cloneColor(quantizationOptions.colorZeroValue));
        }
    }
    if (usesSharedColorBehaviour(colorZeroBehaviour)) {
        startIndex = 1;
    }
    if (doSorting) {
        pal = sortPalettes(pal, startIndex);
    }
    postMessage({
        action: Action.UpdatePalettes,
        palettes: pal,
        checkpointPalettes: palettes,
        numPalettes: quantizationOptions.numPalettes,
        numColors: quantizationOptions.colorsPerPalette,
    });
}
async function finishPartialImage(image, palettes) {
    if (quantizationOptions.colorZeroBehaviour === ColorZeroBehaviour.Shared) {
        quantizationOptions.colorZeroValue = sampleMostFrequentOpaqueColor(image);
    }
    const flat = palettes.flat(2);
    await runWasm(image, (wasm, imagePtr) => {
        const palettesPtr = wasm.alloc(flat.length * 8);
        new Float64Array(wasm.memory.buffer, palettesPtr, flat.length).set(flat);
        wasm.finishPartial(imagePtr, image.width, image.height, palettesPtr, palettes.length, palettes[0].length);
    });
}
async function quantizeImage(image) {
    console.log(quantizationOptions);
    const t0 = performance.now();
    if (quantizationOptions.colorZeroBehaviour === ColorZeroBehaviour.Shared) {
        quantizationOptions.colorZeroValue = sampleMostFrequentOpaqueColor(image);
    }
    const reducedImageData = {
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.data.length),
    };
    if (quantizationOptions.dither !== Dither.Off) {
        reducedImageData.data.set(image.data);
    }
    else {
        for (let i = 0; i < image.data.length; i++) {
            reducedImageData.data[i] = toNbit(image.data[i], quantizationOptions.bitsPerChannel, quantizationOptions.colorSpace);
        }
    }
    await runWasm(reducedImageData, (wasm, imagePtr) => wasm.quantize(imagePtr, image.width, image.height));
    console.log(`> Time: ${((performance.now() - t0) / 1000).toFixed(2)} sec`);
}
// Quantization runs in C++ (src/wasm/quantize.cpp); it calls back here for progress,
// palettes and rendered images. Each worker handles one job, so the module isn't reused.
const colorSpaceIds = { megadrive: 1, nes: 2 };
async function runWasm(image, start) {
    const { width, height } = image;
    const o = quantizationOptions;
    let memory;
    const bytes = (ptr, length) => new Uint8ClampedArray(memory.buffer, ptr, length).slice();
    const response = await fetch("quantize.wasm");
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {
        env: {
            random: Math.random,
            progress: updateProgress,
            palettes(ptr, numPalettes, numColors, doSorting) {
                const values = new Float64Array(memory.buffer, ptr, numPalettes * numColors * 3);
                const palettes = [];
                for (let p = 0; p < numPalettes; p++) {
                    const palette = [];
                    for (let c = 0; c < numColors; c++) {
                        const i = 3 * (p * numColors + c);
                        palette.push([values[i], values[i + 1], values[i + 2]]);
                    }
                    palettes.push(palette);
                }
                updatePalettes(palettes, doSorting === 1);
            },
            image(dataPtr, indexesPtr, paletteDataPtr) {
                const transparentIndexZero = o.colorZeroBehaviour === ColorZeroBehaviour.TransparentFromColor ||
                    o.colorZeroBehaviour === ColorZeroBehaviour.TransparentFromTransparent;
                updateQuantizedImage({
                    width,
                    height,
                    data: bytes(dataPtr, width * height * 4),
                    totalPaletteColors: o.numPalettes * o.colorsPerPalette,
                    colorsPerPalette: o.colorsPerPalette,
                    transparentIndexZero,
                    paletteData: bytes(paletteDataPtr, 1024),
                    colorIndexes: bytes(indexesPtr, Math.ceil(width / 4) * 4 * height),
                });
            },
        },
    });
    const wasm = instance.exports;
    memory = wasm.memory;
    wasm.configure(o.tileWidth, o.tileHeight, o.numPalettes, o.colorsPerPalette, o.bitsPerChannel, o.fractionOfPixels, o.colorZeroBehaviour, ...o.colorZeroValue, o.dither, o.ditherWeight, o.ditherPattern, colorSpaceIds[o.colorSpace] ?? 0);
    const imagePtr = wasm.alloc(image.data.length);
    new Uint8Array(memory.buffer, imagePtr, image.data.length).set(image.data);
    start(wasm, imagePtr);
}
function sortPalettes(palettes, startIndex) {
    const pairIterations = 2000;
    const tIterations = 10000;
    const paletteIterations = 100000;
    const upWeight = 2;
    const numPalettes = palettes.length;
    const numColors = palettes[0].length;
    if (numColors === 2 && startIndex === 1) {
        return palettes;
    }
    // paletteDist[i+1][j+1] stores distance between palette i and palette j
    const paletteDist = zeros2(numPalettes + 2, numPalettes + 2);
    // colorIndex[p1][p2][i] stores the index of the closest color in p2 from color index i in p1
    const colorIndex = zeros3(numPalettes, numPalettes, numColors);
    for (let i = 0; i < numPalettes; i++) {
        for (let j = 0; j < numPalettes; j++) {
            for (let k = 0; k < numColors; k++) {
                colorIndex[i][j][k] = k;
            }
        }
    }
    for (let p1 = 0; p1 < numPalettes - 1; p1++) {
        for (let p2 = p1 + 1; p2 < numPalettes; p2++) {
            const index = colorIndex[p1][p2];
            for (let iteration = 0; iteration < pairIterations; iteration++) {
                let i1 = startIndex +
                    Math.floor(Math.random() * (numColors - startIndex - 1));
                let i2 = i1 + 1 + Math.floor(Math.random() * (numColors - i1 - 1));
                if (Math.random() < 0.5) {
                    [i1, i2] = [i2, i1];
                }
                const p1i1 = palettes[p1][i1];
                const p1i2 = palettes[p1][i2];
                const p2i1 = palettes[p2][index[i1]];
                const p2i2 = palettes[p2][index[i2]];
                const straightDist = colorDistance(p1i1, p2i1) + colorDistance(p1i2, p2i2);
                const swappedDist = colorDistance(p1i1, p2i2) + colorDistance(p1i2, p2i1);
                if (swappedDist < straightDist) {
                    [index[i1], index[i2]] = [index[i2], index[i1]];
                }
            }
            let sum = 0;
            for (let i = 0; i < numColors; i++) {
                const p1i = palettes[p1][i];
                const p2i = palettes[p2][index[i]];
                sum += colorDistance(p1i, p2i);
            }
            paletteDist[p1 + 1][p2 + 1] = sum;
            paletteDist[p2 + 1][p1 + 1] = sum;
        }
    }
    for (let p1 = 1; p1 < numPalettes; p1++) {
        for (let p2 = 0; p2 < p1; p2++) {
            const index = colorIndex[p2][p1];
            const revIndex = colorIndex[p1][p2];
            for (let i = 0; i < numColors; i++) {
                revIndex[i] = index.indexOf(i);
            }
        }
    }
    const palIndex = [];
    for (let i = 0; i < numPalettes + 2; i++) {
        palIndex.push(i);
    }
    if (numPalettes > 2) {
        for (let iteration = 0; iteration < paletteIterations; iteration++) {
            const index1 = Math.max(1, Math.floor(Math.random() * numPalettes));
            const index2 = Math.min(numPalettes, index1 + 1 + Math.floor(Math.random() * numPalettes));
            const i1b = palIndex[index1 - 1];
            const i1 = palIndex[index1];
            const i2 = palIndex[index2];
            const i2b = palIndex[index2 + 1];
            const straightDist = paletteDist[i1b][i1] + paletteDist[i2][i2b];
            const swappedDist = paletteDist[i1b][i2] + paletteDist[i1][i2b];
            if (swappedDist < straightDist) {
                reverse(palIndex, index1, index2);
            }
        }
    }
    const pal1 = palettes[palIndex[1] - 1];
    const p1Index = [];
    for (let i = 0; i < numColors + 2; i++) {
        p1Index.push(i);
    }
    const p1Dist = zeros2(numColors + 2, numColors + 2);
    for (let i = 1; i <= numColors; i++) {
        for (let j = 1; j <= numColors; j++) {
            p1Dist[i][j] = colorDistance(pal1[i - 1], pal1[j - 1]);
        }
    }
    if (numColors > 2) {
        for (let iteration = 0; iteration < paletteIterations; iteration++) {
            const index1 = Math.max(1 + startIndex, Math.floor(Math.random() * numColors));
            const index2 = Math.min(numColors, index1 + 1 + Math.floor(Math.random() * numColors));
            const i1b = p1Index[index1 - 1];
            const i1 = p1Index[index1];
            const i2 = p1Index[index2];
            const i2b = p1Index[index2 + 1];
            const straightDist = p1Dist[i1b][i1] + p1Dist[i2][i2b];
            const swappedDist = p1Dist[i1b][i2] + p1Dist[i1][i2b];
            if (swappedDist < straightDist) {
                reverse(p1Index, index1, index2);
            }
        }
    }
    const pIndex = zeros2(numPalettes, numColors);
    for (let i = 0; i < numColors; i++) {
        pIndex[0][i] = p1Index[i + 1] - 1;
    }
    for (let i = 1; i < numPalettes; i++) {
        for (let j = 0; j < numColors; j++) {
            const p1 = palIndex[i] - 1;
            const p2 = palIndex[i + 1] - 1;
            pIndex[i][j] = colorIndex[p1][p2][pIndex[i - 1][j]];
        }
    }
    if (numColors >= 4)
        for (let i = 1; i < numPalettes; i++) {
            const p1 = palIndex[i] - 1;
            const p2 = palIndex[i + 1] - 1;
            let iteration = 0;
            while (iteration < tIterations) {
                const index1 = Math.max(startIndex, Math.floor(Math.random() * numColors));
                const index2 = Math.max(startIndex, Math.floor(Math.random() * numColors));
                if (index1 === index2)
                    continue;
                const up1 = pIndex[i - 1][index1];
                const i1 = pIndex[i][index1];
                const left1 = pIndex[i][index1 - 1];
                const right1 = pIndex[i][index1 + 1];
                const up2 = pIndex[i - 1][index2];
                const i2 = pIndex[i][index2];
                const left2 = pIndex[i][index2 - 1];
                const right2 = pIndex[i][index2 + 1];
                let straightDist = upWeight *
                    colorDistance(palettes[p2][i1], palettes[p1][up1]);
                if (left1 >= 0)
                    straightDist += colorDistance(palettes[p2][i1], palettes[p2][left1]);
                if (right1 < numColors)
                    straightDist += colorDistance(palettes[p2][i1], palettes[p2][right1]);
                straightDist +=
                    upWeight *
                        colorDistance(palettes[p2][i2], palettes[p1][up2]);
                if (left2 >= 0)
                    straightDist += colorDistance(palettes[p2][i2], palettes[p2][left2]);
                if (right2 < numColors)
                    straightDist += colorDistance(palettes[p2][i2], palettes[p2][right2]);
                let swappedDist = upWeight *
                    colorDistance(palettes[p2][i2], palettes[p1][up1]);
                if (left1 >= 0)
                    swappedDist += colorDistance(palettes[p2][i2], palettes[p2][left1]);
                if (right1 < numColors)
                    swappedDist += colorDistance(palettes[p2][i2], palettes[p2][right1]);
                swappedDist +=
                    upWeight *
                        colorDistance(palettes[p2][i1], palettes[p1][up2]);
                if (left2 >= 0)
                    swappedDist += colorDistance(palettes[p2][i1], palettes[p2][left2]);
                if (right2 < numColors)
                    swappedDist += colorDistance(palettes[p2][i1], palettes[p2][right2]);
                if (swappedDist < straightDist) {
                    [pIndex[i][index1], pIndex[i][index2]] = [
                        pIndex[i][index2],
                        pIndex[i][index1],
                    ];
                }
                iteration++;
            }
        }
    const pals = [];
    for (let i = 0; i < numPalettes; i++) {
        const p2 = palIndex[i + 1] - 1;
        const pal = [];
        for (let j = 0; j < numColors; j++) {
            pal.push(palettes[p2][pIndex[i][j]]);
        }
        pals.push(pal);
    }
    return pals;
}
function zeroArray(len) {
    const result = [];
    for (let i = 0; i < len; i++) {
        result.push(0);
    }
    return result;
}
function zeros2(len1, len2) {
    const result = [];
    for (let i = 0; i < len1; i++) {
        result.push(zeroArray(len2));
    }
    return result;
}
function zeros3(len1, len2, len3) {
    const result = [];
    for (let i = 0; i < len1; i++) {
        result.push(zeros2(len2, len3));
    }
    return result;
}
function reverse(a, left, right) {
    const middle = (left + right) / 2.0;
    while (left < middle) {
        [a[left], a[right]] = [a[right], a[left]];
        left++;
        right--;
    }
}
function getClosestColor(palette, color) {
    let minIndex = palette.length - 1;
    let minDist = colorDistance(palette[minIndex], color);
    for (let i = palette.length - 2; i >= 0; i--) {
        const dist = colorDistance(palette[i], color);
        if (dist < minDist) {
            minIndex = i;
            minDist = dist;
        }
    }
    return [minIndex, minDist];
}
// scratch buffers reused across calls: this runs per pixel per palette in the hot loop.
// comparedColor is one shared buffer (it always held the last iteration's color);
// callers must use the returned color before the next call.
function colorDistance(a, b) {
    const d0 = a[0] - b[0];
    const d1 = a[1] - b[1];
    const d2 = a[2] - b[2];
    return 2 * d0 * d0 + 4 * d1 * d1 + d2 * d2;
}
// stops summing once the total can no longer beat bound (callers only need the winner)
function cloneColor(color) {
    const result = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        result[i] = color[i];
    }
    return result;
}
function sampleMostFrequentOpaqueColor(image) {
    const counts = new Map();
    let mostFrequentColor = [0, 0, 0];
    let highestCount = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i + 3] !== 255) {
            continue;
        }
        const red = image.data[i];
        const green = image.data[i + 1];
        const blue = image.data[i + 2];
        const key = (red << 16) | (green << 8) | blue;
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count);
        if (count > highestCount) {
            mostFrequentColor = [red, green, blue];
            highestCount = count;
        }
    }
    return mostFrequentColor;
}
function copyColor(dest, source) {
    for (let i = 0; i < 3; i++) {
        dest[i] = source[i];
    }
}
// alpha = 255 / (2 ** n - 1)
const alphaValues = [0, 255, 85, 36.42857, 17, 8.22581, 4.04762, 2.00787, 1];
function toNbit(value, n, colorSpace) {
    const alpha = alphaValues[n];
    const rounded = Math.round(Math.round(value / alpha) * alpha);
    if (colorSpace === "megadrive") {
        return toMegaDriveChannel(rounded);
    }
    return rounded;
}
function toNbitColor(color, n, colorSpace) {
    if (colorSpace === "nes") {
        copyColor(color, closestNesColor(color));
        return;
    }
    for (let i = 0; i < 3; i++) {
        color[i] = toNbit(color[i], n, colorSpace);
    }
}
function toMegaDriveChannel(num) {
  // map 0–255 -> 0–7, then to 0x00..0xEE
  const level = Math.round(num / 255 * 7);
  return level * 0x22;
}
// NESdev wiki 2C02G palette ($00-$3F); $0D, $1D and $xE/$xF are all #000000
const nesPalette = [
    0x626262, 0x001C95, 0x1904AC, 0x42009D, 0x61006B, 0x6E0025, 0x650500, 0x491E00,
    0x223700, 0x004900, 0x004F00, 0x004816, 0x00355E, 0x000000, 0x000000, 0x000000,
    0xABABAB, 0x0C4EDB, 0x3D2EFF, 0x7115F3, 0x9B0BB9, 0xB01262, 0xA92704, 0x894600,
    0x576600, 0x237F00, 0x008900, 0x008332, 0x006D90, 0x000000, 0x000000, 0x000000,
    0xFFFFFF, 0x57A5FF, 0x8287FF, 0xB46DFF, 0xDF60FF, 0xF863C6, 0xF8746D, 0xDE9020,
    0xB3AE00, 0x81C800, 0x56D522, 0x3DD36F, 0x3EC1C8, 0x4E4E4E, 0x000000, 0x000000,
    0xFFFFFF, 0xBEE0FF, 0xCDD4FF, 0xE0CAFF, 0xF1C4FF, 0xFCC4EF, 0xFDCACE, 0xF5D4AF,
    0xE6DF9C, 0xD3E99A, 0xC2EFA8, 0xB7EFC4, 0xB6EAE5, 0xB8B8B8, 0x000000, 0x000000,
].map((rgb) => [rgb >> 16, (rgb >> 8) & 0xFF, rgb & 0xFF]);
// cached because Slow dither snaps colors inside its per-pixel loop
const nesColorCache = new Map();
function closestNesColor(color) {
    const key = (Math.round(color[0]) << 16) | (Math.round(color[1]) << 8) | Math.round(color[2]);
    let nesColor = nesColorCache.get(key);
    if (!nesColor) {
        nesColor = nesPalette[getClosestColor(nesPalette, color)[0]];
        nesColorCache.set(key, nesColor);
    }
    return nesColor;
}
