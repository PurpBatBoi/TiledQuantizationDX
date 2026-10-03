const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

async function runPartialFinish() {
    const messages = [];
    const context = vm.createContext({
        console,
        onmessage: null,
        performance,
        postMessage(message) {
            messages.push(message);
        },
        structuredClone,
        // worker fetches quantize.wasm relative to itself
        fetch: async () => ({ arrayBuffer: async () => fs.readFileSync("src/js/quantize.wasm") }),
        Uint8ClampedArray,
    });
    vm.runInContext(fs.readFileSync("src/js/worker.js", "utf8"), context);

    await context.onmessage({
        data: {
            action: 5,
            imageData: {
                width: 2,
                height: 2,
                data: new Uint8ClampedArray([
                    128, 128, 128, 255,
                    128, 128, 128, 255,
                    128, 128, 128, 255,
                    128, 128, 128, 255,
                ]),
            },
            palettes: [[[0, 0, 0], [255, 255, 255]]],
            quantizationOptions: {
                tileWidth: 2,
                tileHeight: 2,
                numPalettes: 1,
                colorsPerPalette: 2,
                bitsPerChannel: 8,
                fractionOfPixels: 0.1,
                colorZeroBehaviour: 0,
                colorZeroValue: [0, 0, 0],
                dither: 1,
                ditherWeight: 1,
                ditherPattern: 0,
                colorSpace: "default",
            },
        },
    });
    return messages;
}

test("finishing a canceled partial result applies the selected dithering", async () => {
    const messages = await runPartialFinish();
    const imageMessage = messages.find((message) => message.action === 2);

    assert.ok(imageMessage, "expected a rendered partial image");
    assert.deepEqual(
        Array.from(imageMessage.imageData.colorIndexes),
        [0, 0, 0, 0, 0, 1, 0, 0],
    );
    assert.equal(messages.at(-1).action, 4);
});
