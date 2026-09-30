const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadCodecs() {
    const context = vm.createContext({ Uint8Array, Int32Array });
    vm.runInContext(`${fs.readFileSync("src/js/gb-compression.js", "utf8")}
        this.codecs = { compressGbdkRle, compressGbdkGb, compressZx0, compressPb8, compressPb16 };`, context);
    return context.codecs;
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (...parts) => Uint8Array.from(parts.flat());
const repeat = (value, count) => new Array(count).fill(value);

// Expected bytes come from the real tools: GBDK-2020's `gbcompress --alg=rle|gb` and the gb-starter-kit's
// pb8.py / pb16.py. Odd lengths exercise PB8/PB16's padding.
const small = bytes([4, 4, 0, 1, 2, 3, 3, 3, 6, 6, 6, 6, 1]);
const runs = bytes(repeat(0, 300), repeat(5, 130), [1, 2, 3], repeat(7, 127), [9, 9, 0]);

test("GBDK rle matches gbcompress --alg=rle", () => {
    const { compressGbdkRle } = loadCodecs();
    assert.equal(hex(compressGbdkRle(small)), "050404000102fd03fc06010100");
    assert.equal(hex(compressGbdkRle(runs)), "81008100d2008105fd050301020381070309090000");
});

test("GBDK gb matches gbcompress --alg=gb", () => {
    const { compressGbdkGb } = loadCodecs();
    assert.equal(hex(compressGbdkGb(small)), "c4040400010202030306c00100");
    assert.equal(hex(compressGbdkGb(runs)), "7f00007f0000ab00ff7f0505c405050102033f07bec0ffc209090000");
});

test("PB8 and PB16 match pb8.py and pb16.py, padding included", () => {
    const { compressPb8, compressPb16 } = loadCodecs();
    assert.equal(hex(compressPb8(small)), "430400010203770601");
    assert.equal(hex(compressPb16(small)), "010404000102030337060601");
});

// ZX0 v2 decoder, after Einar Saukas's dzx0.c (forward, inverted offset MSB).
function unzx0(input) {
    const out = [];
    let index = 0;
    let bitMask = 0;
    let bitValue = 0;
    let backtrack = false;
    const readBit = () => {
        if (backtrack) {
            backtrack = false;
            return input[index - 1] & 1;
        }
        bitMask >>= 1;
        if (!bitMask) {
            bitMask = 128;
            bitValue = input[index++];
        }
        return bitValue & bitMask ? 1 : 0;
    };
    const readGamma = (inverted) => {
        let value = 1;
        while (!readBit()) {
            value = value << 1 | (readBit() ^ inverted);
        }
        return value;
    };
    const copy = (offset, length) => {
        for (let i = 0; i < length; i++) {
            out.push(out[out.length - offset]);
        }
    };
    let lastOffset = 1;
    let state = "literals";
    for (;;) {
        if (state === "literals") {
            const length = readGamma(0);
            out.push(...input.subarray(index, index + length));
            index += length;
            state = readBit() ? "new" : "last";
        }
        else if (state === "last") {
            copy(lastOffset, readGamma(0));
            state = readBit() ? "new" : "literals";
        }
        else {
            const msb = readGamma(1);
            if (msb === 256) {
                return Uint8Array.from(out);
            }
            lastOffset = msb * 128 - (input[index++] >> 1);
            backtrack = true;
            copy(lastOffset, readGamma(0) + 1);
            state = readBit() ? "new" : "literals";
        }
    }
}

test("ZX0 round-trips, and packs runs far below their size", () => {
    const { compressZx0 } = loadCodecs();
    let seed = 1;
    const noise = Uint8Array.from({ length: 700 }, () => (seed = seed * 1103515245 + 12345 & 0x7fffffff) >> 16 & 0xff);
    for (const input of [small, runs, noise, bytes([3]), bytes(repeat(0, 1920))]) {
        assert.equal(hex(unzx0(compressZx0(input))), hex(input));
    }
    assert.ok(compressZx0(runs).length < 25);
});
