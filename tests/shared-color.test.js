const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const workerSource = fs.readFileSync("src/js/worker.js", "utf8");
const context = vm.createContext({
    console,
    onmessage: null,
    performance,
    postMessage() {},
    structuredClone,
    Uint8ClampedArray,
});
vm.runInContext(workerSource, context);

function sampleColor(data) {
    context.testImage = {
        width: data.length / 4,
        height: 1,
        data: new Uint8ClampedArray(data),
    };
    return vm.runInContext("sampleMostFrequentOpaqueColor(testImage)", context);
}

test("samples the most frequent fully opaque source color", () => {
    const result = sampleColor([
        12, 34, 56, 255,
        90, 80, 70, 120,
        12, 34, 56, 255,
        90, 80, 70, 120,
        90, 80, 70, 120,
        200, 100, 50, 255,
    ]);

    assert.deepEqual(Array.from(result), [12, 34, 56]);
});

test("uses black when the source has no fully opaque pixels", () => {
    const result = sampleColor([
        12, 34, 56, 0,
        90, 80, 70, 254,
    ]);

    assert.deepEqual(Array.from(result), [0, 0, 0]);
});

test("both shared modes reserve color index zero", () => {
    assert.equal(
        vm.runInContext(
            "usesSharedColorBehaviour(ColorZeroBehaviour.Shared)",
            context,
        ),
        true,
    );
    assert.equal(
        vm.runInContext(
            "usesSharedColorBehaviour(ColorZeroBehaviour.SpecificShared)",
            context,
        ),
        true,
    );
    assert.equal(
        vm.runInContext(
            "usesSharedColorBehaviour(ColorZeroBehaviour.Unique)",
            context,
        ),
        false,
    );
});
