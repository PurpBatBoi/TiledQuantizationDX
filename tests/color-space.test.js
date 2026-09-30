const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const enumsSource = fs.readFileSync("src/js/enums.js", "utf8");
const context = vm.createContext({});
vm.runInContext(enumsSource, context);

test("Default uses the standard color space", () => {
    assert.equal(
        vm.runInContext('usesMegaDriveColorSpace("default")', context),
        false,
    );
});

test("Megadrive uses the Mega Drive color space", () => {
    assert.equal(
        vm.runInContext('usesMegaDriveColorSpace("megadrive")', context),
        true,
    );
});
