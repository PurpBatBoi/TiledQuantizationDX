"use strict";

// Game Boy compression codecs for the GBC attribute export. Each takes and returns a Uint8Array.
//   GBDK-2020 gbcompress: "rle" and "gb" are ports of gbdk-support/gbcompress (rlecompress.c, gbcompress.c)
//     and give the same bytes as `gbcompress --alg=rle|gb`. "zx0" is a port of Einar Saukas's reference ZX0
//     compressor (v2 format, which GBDK's zx0_decompress reads). gbcompress uses salvador instead, so the
//     bytes can differ from it, but both are optimal ZX0 streams.
//   PB8 / PB16 by Damian Yerrick: ports of pb8.py and pb16.py, as bundled with ISSOtm's gb-starter-kit.
//     Made for 2bpp tile data, so the attribute export doesn't offer them; kept for a possible tile export.

// GBDK rle_decompress: control byte 1-127 = that many literal bytes follow; 0x81-0xFF = the next byte
// repeats (256 - control) times; 0 = end.
function compressGbdkRle(input) {
    const out = [];
    let queued = [];
    const commit = () => {
        if (queued.length > 0) {
            out.push(queued.length, ...queued);
            queued = [];
        }
    };
    const endRun = (length, value) => {
        if (length > 2) {  // RLE_CHANGE_COST: shorter runs are cheaper as literals
            commit();
            out.push((length ^ 0xff) + 1 & 0xff, value);
            return;
        }
        for (let i = 0; i < length; i++) {
            if (queued.length >= 127) {
                commit();
            }
            queued.push(value);
        }
    };
    let last = 0;
    let runLength = 0;
    for (const current of input) {
        if (current !== last) {
            endRun(runLength, last);
            runLength = 1;
            last = current;
        }
        else {
            if (runLength >= 127) {
                commit();
                out.push((runLength ^ 0xff) + 1 & 0xff, last);
                runLength = 0;
            }
            runLength++;
        }
    }
    endRun(runLength, last);
    commit();
    out.push(0);
    return Uint8Array.from(out);
}

// GBDK gb_decompress (the GBTD/GBMB format): token = type in bits 6-7, length-1 in bits 0-5.
// 0x00 byte run, 0x40 word run (big-endian word), 0x80 back-reference (16-bit little-endian negative
// offset), 0xC0 literal bytes; a 0x00 token ends the data.
// ponytail: the back-reference search is O(n²) like gbcompress's; fine for attribute maps, slow past ~64 KB.
function compressGbdkGb(input) {
    const size = input.length;
    const out = [];
    const word = (at) => (at + 2 < size ? input[at] << 8 | input[at + 1] : -1);  // gbcompress's strict < quirk
    let index = 0;
    let trash = 0;
    const flushTrash = () => {
        if (trash > 0) {
            out.push((trash - 1 & 0x3f) | 0xc0, ...input.subarray(index - trash, index));
            trash = 0;
        }
    };
    while (index < size) {
        let byteLength = 1;
        while (index + byteLength < size && input[index + byteLength] === input[index] && byteLength < 64) {
            byteLength++;
        }
        const wordMatch = word(index);
        let wordLength = 0;
        if (wordMatch >= 0) {
            wordLength = 1;
            while (word(index + wordLength * 2) === wordMatch && wordLength < 64) {
                wordLength++;
            }
        }
        let stringLength = 0;
        let stringOffset = 0;
        for (let start = Math.max(0, index - 0xffff); start < index; start++) {
            let length = 0;
            while (index + length < size && input[start + length] === input[index + length]
                && start + length < index && length < 64) {
                length++;
            }
            if (length > stringLength) {
                stringLength = length;
                stringOffset = index - start;
            }
        }
        if (byteLength > 2 && byteLength > wordLength && byteLength > stringLength) {
            flushTrash();
            out.push(byteLength - 1 & 0x3f, input[index]);
            index += byteLength;
        }
        else if (wordLength > 2 && wordLength * 2 > stringLength) {
            flushTrash();
            out.push((wordLength - 1 & 0x3f) | 0x40, wordMatch >> 8, wordMatch & 0xff);
            index += wordLength * 2;
        }
        else if (stringLength > 3) {
            flushTrash();
            const offset = (stringOffset ^ 0xffff) + 1 & 0xffff;
            out.push((stringLength - 1 & 0x3f) | 0x80, offset & 0xff, offset >> 8);
            index += stringLength;
        }
        else if (trash >= 64) {
            flushTrash();
        }
        else {
            trash++;
            index++;
        }
    }
    flushTrash();
    out.push(0);
    return Uint8Array.from(out);
}

// ZX0 v2 (Einar Saukas): optimal parse over every offset, then Elias-gamma coded literals/matches.
// ponytail: O(n × 32640) like the reference optimizer; fine for attribute maps, slow for large files.
function compressZx0(input) {
    const size = input.length;
    if (size === 0) {
        throw new Error("ZX0 can't compress empty data");
    }
    const maxOffsetLimit = 32640;
    const eliasGammaBits = (value) => {
        let bits = 1;
        while ((value >>= 1)) {
            bits += 2;
        }
        return bits;
    };
    const block = (bits, index, offset, chain) => ({ bits, index, offset, chain });
    let maxOffset = Math.min(Math.max(size - 1, 1), maxOffsetLimit);
    const lastLiteral = new Array(maxOffset + 1).fill(null);
    const lastMatch = new Array(maxOffset + 1).fill(null);
    const optimal = new Array(size).fill(null);
    const matchLength = new Int32Array(maxOffset + 1);
    const bestLength = new Int32Array(Math.max(size, 3));
    if (size > 2) {
        bestLength[2] = 2;
    }
    lastMatch[1] = block(-1, -1, 1, null);
    for (let index = 0; index < size; index++) {
        let bestLengthSize = 2;
        maxOffset = Math.min(Math.max(index, 1), maxOffsetLimit);
        for (let offset = 1; offset <= maxOffset; offset++) {
            if (index !== 0 && index >= offset && input[index] === input[index - offset]) {
                if (lastLiteral[offset]) {  // copy from last offset
                    const length = index - lastLiteral[offset].index;
                    const bits = lastLiteral[offset].bits + 1 + eliasGammaBits(length);
                    lastMatch[offset] = block(bits, index, offset, lastLiteral[offset]);
                    if (!optimal[index] || optimal[index].bits > bits) {
                        optimal[index] = lastMatch[offset];
                    }
                }
                if (++matchLength[offset] > 1) {  // copy from new offset
                    if (bestLengthSize < matchLength[offset]) {
                        let bits = optimal[index - bestLength[bestLengthSize]].bits + eliasGammaBits(bestLength[bestLengthSize] - 1);
                        do {
                            bestLengthSize++;
                            const bits2 = optimal[index - bestLengthSize].bits + eliasGammaBits(bestLengthSize - 1);
                            if (bits2 <= bits) {
                                bestLength[bestLengthSize] = bestLengthSize;
                                bits = bits2;
                            }
                            else {
                                bestLength[bestLengthSize] = bestLength[bestLengthSize - 1];
                            }
                        } while (bestLengthSize < matchLength[offset]);
                    }
                    const length = bestLength[matchLength[offset]];
                    const bits = optimal[index - length].bits + 8 + eliasGammaBits(Math.floor((offset - 1) / 128) + 1)
                        + eliasGammaBits(length - 1);
                    if (!lastMatch[offset] || lastMatch[offset].index !== index || lastMatch[offset].bits > bits) {
                        lastMatch[offset] = block(bits, index, offset, optimal[index - length]);
                        if (!optimal[index] || optimal[index].bits > bits) {
                            optimal[index] = lastMatch[offset];
                        }
                    }
                }
            }
            else {  // copy literals
                matchLength[offset] = 0;
                if (lastMatch[offset]) {
                    const length = index - lastMatch[offset].index;
                    const bits = lastMatch[offset].bits + 1 + eliasGammaBits(length) + length * 8;
                    lastLiteral[offset] = block(bits, index, 0, lastMatch[offset]);
                    if (!optimal[index] || optimal[index].bits > bits) {
                        optimal[index] = lastLiteral[offset];
                    }
                }
            }
        }
    }

    // Walk the chain from the start.
    const steps = [];
    for (let step = optimal[size - 1]; step; step = step.chain) {
        steps.unshift(step);
    }
    const out = [];
    let bitMask = 0;
    let bitIndex = 0;
    let backtrack = true;
    const writeBit = (value) => {
        if (backtrack) {
            if (value) {
                out[out.length - 1] |= 1;
            }
            backtrack = false;
            return;
        }
        if (!bitMask) {
            bitMask = 128;
            bitIndex = out.length;
            out.push(0);
        }
        if (value) {
            out[bitIndex] |= bitMask;
        }
        bitMask >>= 1;
    };
    const writeGamma = (value, invert) => {
        let i = 2;
        while (i <= value) {
            i <<= 1;
        }
        i >>= 1;
        while ((i >>= 1)) {
            writeBit(0);
            writeBit(invert ? !(value & i) : value & i);
        }
        writeBit(1);
    };
    let lastOffset = 1;
    let position = 0;
    for (let i = 1; i < steps.length; i++) {
        const step = steps[i];
        const length = step.index - steps[i - 1].index;
        if (!step.offset) {
            writeBit(0);
            writeGamma(length, false);
            out.push(...input.subarray(position, position + length));
        }
        else if (step.offset === lastOffset) {
            writeBit(0);
            writeGamma(length, false);
        }
        else {
            writeBit(1);
            writeGamma(Math.floor((step.offset - 1) / 128) + 1, true);
            out.push((127 - (step.offset - 1) % 128) << 1);
            backtrack = true;
            writeGamma(length - 1, false);
            lastOffset = step.offset;
        }
        position += length;
    }
    writeBit(1);  // end marker
    writeGamma(256, true);
    return Uint8Array.from(out);
}

// PB8 / PB16: packets of a control byte plus up to 8 literals. Control bit 7-i set = byte i repeats the byte
// 1 (PB8) or 2 (PB16) positions back instead of being a literal. The input is padded to 8 bytes per packet.
function compressPb(input, distance) {
    const out = [];
    const previous = new Array(distance).fill(0);
    for (let start = 0; start < input.length; start += 8) {
        const packet = Array.from(input.subarray(start, start + 8));
        if (packet.length < 8) {
            if (distance === 2) {  // pb16.py pads to a multiple of 2, then repeats the last pair
                if (packet.length === 1) {
                    packet.push(previous[1]);
                }
                else if (packet.length % 2) {
                    packet.push(packet[packet.length - 2]);
                }
                const pair = packet.slice(-2);
                while (packet.length < 8) {
                    packet.push(...pair);
                }
            }
            else {
                while (packet.length < 8) {
                    packet.push(packet[packet.length - 1]);
                }
            }
        }
        const control = out.push(0) - 1;
        packet.forEach((value, i) => {
            if (value === previous[i % distance]) {
                out[control] |= 0x80 >> i;
            }
            else {
                out.push(value);
                previous[i % distance] = value;
            }
        });
    }
    return Uint8Array.from(out);
}

const compressPb8 = (input) => compressPb(input, 1);
const compressPb16 = (input) => compressPb(input, 2);
