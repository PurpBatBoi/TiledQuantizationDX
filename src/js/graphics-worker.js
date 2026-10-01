"use strict";

// Runs one conversion off the main thread; the page terminates the worker when the image or target changes.
importScripts("nes-attributes.js", "graphics-conversion.js");

onmessage = ({ data }) => {
    try {
        const convert = data.task === "compress" ? compressTiles : convertBackgroundAsset;
        postMessage({ id: data.id, result: convert(data.input, data.options) });
    }
    catch (error) {
        postMessage({ id: data.id, error: error.message });
    }
};
