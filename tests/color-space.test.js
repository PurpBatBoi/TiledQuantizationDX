const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/js/worker.js", "utf8"), context);

function reduce(color, colorSpace) {
    context.color = color;
    vm.runInContext(`toNbitColor(color, 4, "${colorSpace}")`, context);
    return Array.from(color);
}

test("Default rounds each channel to Bits Per Channel", () => {
    assert.deepEqual(reduce([255, 130, 0], "default"), [255, 136, 0]);
});

test("Megadrive maps each channel to 0x00 through 0xEE", () => {
    assert.deepEqual(reduce([255, 130, 0], "megadrive"), [0xEE, 0x88, 0]);
});

test("NES snaps to the nearest 2C02G palette color", () => {
    assert.deepEqual(reduce([0x50, 0xA0, 0xF8], "nes"), [0x57, 0xA5, 0xFF]); // $21
    assert.deepEqual(reduce([10, 5, 8], "nes"), [0, 0, 0]); // $0F
    assert.deepEqual(reduce([250, 250, 250], "nes"), [255, 255, 255]); // $20
});
