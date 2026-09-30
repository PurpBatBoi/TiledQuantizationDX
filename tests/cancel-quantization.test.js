const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function createElement(tagName = "div") {
    return {
        tagName,
        children: [],
        disabled: false,
        value: 0,
        addEventListener() {},
        appendChild(child) {
            this.children.push(child);
        },
        prepend(child) {
            this.children.unshift(child);
        },
        getContext() {
            return {};
        },
        removeAttribute() {},
        setAttribute() {},
        toDataURL() {
            this.toDataURLCalls = (this.toDataURLCalls || 0) + 1;
            return "data:image/png;base64,";
        },
    };
}

function loadPageScript() {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) {
            const element = createElement();
            element.id = id;
            element.parentElement = createElement();
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const context = vm.createContext({
        console,
        document: {
            createElement,
            getElementById: getElement,
            querySelectorAll() {
                return [];
            },
        },
        Image: function Image() {},
        URL,
        window: {},
    });
    vm.runInContext(fs.readFileSync("src/js/enums.js", "utf8"), context);
    vm.runInContext(fs.readFileSync("src/js/script.js", "utf8"), context);
    return { context, elements };
}

test("canceling dithered work finishes the latest palette and exports it once", () => {
    const { context, elements } = loadPageScript();
    const result = createElement();
    const activeWorker = {
        terminated: false,
        terminate() {
            this.terminated = true;
        },
    };
    const finishingWorkers = [];
    context.Worker = function Worker() {
        const finishingWorker = {
            messages: [],
            postMessage(message) {
                this.messages.push(message);
            },
            terminate() {},
        };
        finishingWorkers.push(finishingWorker);
        return finishingWorker;
    };
    context.testResult = result;
    context.testWorker = activeWorker;
    context.testSourceImageData = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([128, 128, 128, 255]),
    };
    context.testOptions = { dither: 1 };
    context.testPalettes = [[[0, 0, 0], [255, 255, 255]]];

    vm.runInContext(
        `currentResult = testResult;
         worker = testWorker;
         currentSourceImageData = testSourceImageData;
         currentQuantizationOptions = testOptions;
         latestPaletteCheckpoint = testPalettes;
         setProcessingState(true);
         cancelQuantization();`,
        context,
    );

    assert.equal(activeWorker.terminated, true);
    assert.equal(finishingWorkers.length, 1);
    assert.equal(finishingWorkers[0].messages[0].action, 5);
    assert.deepEqual(
        finishingWorkers[0].messages[0].palettes,
        context.testPalettes,
    );
    assert.equal(elements.get("quantizeButton").disabled, true);
    assert.equal(elements.get("cancelButton").disabled, true);
    assert.equal(
        result.children.at(-1).textContent,
        "Canceled — applying dithering to partial result…",
    );

    vm.runInContext(
        "latestQuantizedImageData = { totalPaletteColors: 257 }",
        context,
    );
    finishingWorkers[0].onmessage({ data: { action: 4 } });

    const resultCanvas = vm.runInContext("quantizedImage", context);
    assert.equal(resultCanvas.toDataURLCalls, 1);
    assert.equal(elements.get("quantizeButton").disabled, false);
    assert.equal(
        result.children.find((child) => child.className === "partial-result-status").textContent,
        "Canceled — partial result (dithered)",
    );
});

test("a failed dither finishing pass keeps the existing partial result usable", () => {
    const { context, elements } = loadPageScript();
    const result = createElement();
    const activeWorker = { terminate() {} };
    const finishingWorkers = [];
    context.Worker = function Worker() {
        const finishingWorker = {
            postMessage() {},
            terminate() {},
        };
        finishingWorkers.push(finishingWorker);
        return finishingWorker;
    };
    context.testResult = result;
    context.testWorker = activeWorker;
    context.testSourceImageData = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([128, 128, 128, 255]),
    };
    context.testOptions = { dither: 1 };
    context.testPalettes = [[[0, 0, 0], [255, 255, 255]]];

    vm.runInContext(
        `currentResult = testResult;
         worker = testWorker;
         currentSourceImageData = testSourceImageData;
         currentQuantizationOptions = testOptions;
         latestPaletteCheckpoint = testPalettes;
         latestQuantizedImageData = { totalPaletteColors: 257 };
         setProcessingState(true);
         cancelQuantization();`,
        context,
    );

    assert.equal(typeof finishingWorkers[0].onerror, "function");
    finishingWorkers[0].onerror();

    assert.equal(elements.get("quantizeButton").disabled, false);
    assert.equal(vm.runInContext("worker", context), null);
    assert.equal(
        result.children.find((child) => child.className === "partial-result-status").textContent,
        "Canceled — partial result (dithering failed)",
    );
});

test("canceling terminates work and leaves a labeled partial result", () => {
    const { context, elements } = loadPageScript();
    const result = createElement();
    const activeWorker = {
        terminated: false,
        terminate() {
            this.terminated = true;
        },
    };
    context.testResult = result;
    context.testWorker = activeWorker;
    vm.runInContext(
        "currentResult = testResult; worker = testWorker; setProcessingState(true); progress.value = 47; cancelQuantization();",
        context,
    );

    assert.equal(activeWorker.terminated, true);
    assert.equal(elements.get("quantizeButton").disabled, false);
    assert.equal(elements.get("cancelButton").disabled, true);
    assert.equal(elements.get("progress").value, 47);
    assert.equal(result.children.at(-1).textContent, "Canceled — partial result");
    assert.equal(vm.runInContext("worker", context), null);
    assert.equal(vm.runInContext("inProgress", context), false);
});

test("more than 256 entries falls back to RGB with a visible warning", async () => {
    const { context } = loadPageScript();
    const target = createElement("a");
    const canvas = createElement("canvas");
    const result = createElement();
    context.testTarget = target;
    context.testCanvas = canvas;
    context.testImage = { totalPaletteColors: 257 };
    context.testResult = result;

    await vm.runInContext(
        "finalizeQuantizedDownload(testTarget, testCanvas, testImage, testResult)",
        context,
    );

    assert.equal(target.href, "data:image/png;base64,");
    assert.equal(
        result.children.at(-1).textContent,
        "Indexed PNG supports at most 256 palette entries; this download uses RGB.",
    );
});
