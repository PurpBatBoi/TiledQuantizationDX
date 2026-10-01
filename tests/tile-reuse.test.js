const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
    constructor() {
        this.disabled = false;
        this.hidden = false;
        this.files = [];
        this.textContent = "";
        this.value = "nes";
        this.width = 0;
        this.height = 0;
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    replaceChildren(...children) {
        this.children = children;
    }

    append(child) {
        this.children ??= [];
        this.children.push(child);
    }

    click() {}

    getContext() {
        return { putImageData() {} };
    }
}

test("a failed newer PNG import cancels and invalidates the previous conversion", async () => {
    const elements = new Map([
        "reuse_selector", "reuse_input", "reuse_choose", "reuse_filename", "reuse_system", "reuse_stats",
        "reuse_diagnostics", "reuse_download", "reuse_status", "reuse_source_canvas", "reuse_result_canvas",
        "reuse_source_empty", "reuse_result_empty",
    ].map((id) => [id, new FakeElement()]));
    const workers = [];
    class FakeWorker {
        constructor() {
            this.terminated = false;
            workers.push(this);
        }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
    }
    const context = vm.createContext({
        Blob,
        ImageData: class { constructor(width, height) { this.data = new Uint8ClampedArray(width * height * 4); } },
        URL,
        Uint8Array,
        Uint8ClampedArray,
        Worker: FakeWorker,
        announce: undefined,
        convertBackgroundAsset() { throw new Error("unexpected inline conversion"); },
        createImageBitmap: async () => { throw new Error("Corrupt PNG"); },
        decodeIndexedPng: async (bytes) => {
            if (new Uint8Array(bytes)[0] !== 1) throw new Error("Not indexed");
            return {
                width: 8,
                height: 8,
                palette: Uint8Array.of(0, 0, 0),
                alpha: null,
                indexes: new Uint8Array(64),
            };
        },
        document: {
            getElementById: (id) => elements.get(id),
            createElement: () => new FakeElement(),
        },
        setTimeout,
    });
    vm.runInContext(fs.readFileSync("src/js/tile-reuse.js", "utf8"), context);

    context.validFile = { name: "valid.png", arrayBuffer: async () => Uint8Array.of(1).buffer };
    await vm.runInContext("loadFile(validFile)", context);
    assert.equal(workers.length, 1);
    const oldWorker = workers[0];

    context.corruptFile = { name: "corrupt.png", arrayBuffer: async () => Uint8Array.of(2).buffer };
    await vm.runInContext("loadFile(corruptFile)", context);
    oldWorker.onmessage({
        data: {
            id: oldWorker.message.id,
            result: {
                ok: true,
                width: 8,
                height: 8,
                preview: new Uint8ClampedArray(8 * 8 * 4),
                optimization: { applied: false, originalTileCount: 1, substitutions: 0, meanSquaredError: 0 },
            },
        },
    });

    const state = vm.runInContext("({ result, jobId, sourceHidden: sourceCanvas.hidden })", context);
    assert.equal(oldWorker.terminated, true);
    assert.equal(state.result, null);
    assert.equal(elements.get("reuse_download").disabled, true);
    assert.equal(state.sourceHidden, true);
});
