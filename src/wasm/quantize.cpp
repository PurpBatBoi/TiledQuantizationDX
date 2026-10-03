// Palette quantizer for worker.js, compiled to src/js/quantize.wasm.
// Port of the original JS: every float result is produced by the same IEEE operations
// in the same order, and randomness comes from JS's Math.random, so output matches the
// old JS bit for bit. The speedups only skip or reorder work whose result can't change:
//  - palettes are stored as separate R/G/B arrays so SIMD scores 2 colors per instruction
//  - palette search tries each tile's previous winner first, so the rest stop summing early
//  - dither caches each palette color's reduced/linear/brightness values until it moves
//  - previews match each tile's unique colors once instead of every pixel
//
// Build (needs zig: `pip install ziglang`):
//   python -m ziglang c++ --target=wasm32-freestanding -O3 -msimd128 -mbulk-memory -nostdlib -fno-exceptions -fno-rtti -ffp-contract=off -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-all -o src/js/quantize.wasm src/wasm/quantize.cpp

#include <wasm_simd128.h>

#define IMPORT(name) extern "C" __attribute__((import_module("env"), import_name(#name)))
#define EXPORT extern "C" __attribute__((visibility("default")))

IMPORT(random) double jsRandom();
IMPORT(progress) void jsProgress(double progress);
IMPORT(palettes) void jsPalettes(const double* palettes, int numPalettes, int numColors, int doSorting);
IMPORT(image) void jsImage(const unsigned char* data, const unsigned char* colorIndexes, const unsigned char* paletteData);

// ---- memory ----
extern unsigned char __heap_base;
static unsigned long heapTop = (unsigned long)&__heap_base;
// bump allocator; each worker runs one job, so nothing is ever freed
EXPORT void* alloc(unsigned long size) {
    heapTop = (heapTop + 15) & ~15ul;
    void* result = (void*)heapTop;
    heapTop += size;
    unsigned long have = __builtin_wasm_memory_size(0) * 65536ul;
    if (heapTop > have) __builtin_wasm_memory_grow(0, (heapTop - have + 65535) / 65536);
    return result;
}
template <typename T> static T* allocArray(int n) { return (T*)alloc(sizeof(T) * (n > 0 ? n : 1)); }
template <typename T> static void fill(T* a, int n, T v) { for (int i = 0; i < n; i++) a[i] = v; }

static const double Inf = __builtin_inf();

// ---- options ----
enum { Unique, Shared, SpecificShared, TransparentFromTransparent, TransparentFromColor };
enum { DitherOff, DitherFast, DitherSlow };
enum { SpaceDefault, SpaceMegaDrive, SpaceNes };

static int tileWidth, tileHeight, targetPalettes, colorsPerPalette, bitsPerChannel;
static int colorZeroBehaviour, dither, colorSpace, ditherPixels;
static double fractionOfPixels, ditherWeight, colorZeroValue[3];
static int ditherPattern[2][2];
static const int ditherPatterns[6][2][2] = {
    {{0, 2}, {3, 1}}, {{0, 3}, {1, 2}}, {{0, 1}, {3, 2}},
    {{0, 1}, {1, 0}}, {{0, 1}, {0, 1}}, {{0, 0}, {1, 1}},
};

static bool usesSharedColor() { return colorZeroBehaviour == Shared || colorZeroBehaviour == SpecificShared; }
static bool hasTransparentIndex() {
    return colorZeroBehaviour == TransparentFromColor || colorZeroBehaviour == TransparentFromTransparent;
}

// ---- colors ----
static double jsRound(double x) {  // Math.round: ties toward +infinity
    double r = __builtin_floor(x);
    return x - r >= 0.5 ? r + 1 : r;
}
static unsigned char clampByte(double v) {  // Uint8ClampedArray store
    if (!(v > 0)) return 0;
    if (v > 255) return 255;
    return (unsigned char)__builtin_rint(v);  // ties to even
}
static void copyColor(double* d, const double* s) { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; }
static bool equalColor(const double* a, const double* b) { return a[0] == b[0] && a[1] == b[1] && a[2] == b[2]; }

// alpha = 255 / (2 ** n - 1)
static const double alphaValues[] = {0, 255, 85, 36.42857, 17, 8.22581, 4.04762, 2.00787, 1};
static double toNbit(double value) {
    double alpha = alphaValues[bitsPerChannel];
    double rounded = jsRound(jsRound(value / alpha) * alpha);
    if (colorSpace == SpaceMegaDrive) return jsRound(rounded / 255 * 7) * 0x22;
    return rounded;
}

// 2C02G NESdev wiki palette, from docs/2C02G_U_wiki_JASC.pal; same table as worker.js
static const int nesRgb[64] = {
    0x575757, 0x000C8E, 0x0800A6, 0x340096, 0x550061, 0x630015, 0x5A0000, 0x3C0E00,
    0x112800, 0x003B00, 0x004200, 0x003A05, 0x002652, 0x000000, 0x000000, 0x000000,
    0xA5A5A5, 0x0041D9, 0x2F1EFF, 0x6704F2, 0x9400B4, 0xAA0057, 0xA31800, 0x803900,
    0x4B5B00, 0x137600, 0x008100, 0x007923, 0x006288, 0x000000, 0x000000, 0x000000,
    0xFFFFFF, 0x4A9FFF, 0x797EFF, 0xAF63FF, 0xDD55FF, 0xF757C2, 0xF76A63, 0xDC8810,
    0xAEA900, 0x78C400, 0x4AD211, 0x2FCF64, 0x2FBDC4, 0x414141, 0x000000, 0x000000,
    0xFFFFFF, 0xB9DDFF, 0xCAD1FF, 0xDEC6FF, 0xF0C0FF, 0xFCC0EE, 0xFDC6CA, 0xF5D0AA,
    0xE4DD95, 0xD0E892, 0xBDEEA2, 0xB2EEC0, 0xB0E8E3, 0xB3B3B3, 0x000000, 0x000000,
};

// ---- palettes ----
// One palette is MaxColors reds, then greens, then blues.
const int MaxPalettes = 16, MaxColors = 256;
const int PaletteStride = 3 * MaxColors;
struct PaletteSet {
    double colors[MaxPalettes * PaletteStride];
    // dither cache per color: toNbitColor'd then squared (same layout), and brightness
    double reducedLinear[MaxPalettes * PaletteStride];
    double brightness[MaxPalettes * MaxColors];
    bool cached[MaxPalettes * MaxColors];
    double* pal(int p) { return colors + p * PaletteStride; }
    void get(int p, int c, double* out) {
        const double* b = pal(p);
        out[0] = b[c];
        out[1] = b[MaxColors + c];
        out[2] = b[2 * MaxColors + c];
    }
    void set(int p, int c, const double* in) {
        double* b = pal(p);
        b[c] = in[0];
        b[MaxColors + c] = in[1];
        b[2 * MaxColors + c] = in[2];
        cached[p * MaxColors + c] = false;
    }
    void invalidate() { fill(cached, MaxPalettes * MaxColors, false); }
};

static int numPalettes, paletteColors;  // current palettes.length, palettes[0].length
static PaletteSet palettes, minPalettes, scratch, reduced;
static PaletteSet nesSet;  // the 64 NES colors as palette 0
static void copyPalettes(PaletteSet& dest, PaletteSet& src) {
    __builtin_memcpy(dest.colors, src.colors, sizeof(double) * numPalettes * PaletteStride);
    dest.invalidate();
}

// dists[i] = colorDistance(palette[i], color) for i < len; 2 colors per SIMD op
static double dists[MaxColors];
static void distances(const double* palette, int len, const double* color) {
    v128_t r = wasm_f64x2_splat(color[0]), g = wasm_f64x2_splat(color[1]), b = wasm_f64x2_splat(color[2]);
    v128_t two = wasm_f64x2_splat(2), four = wasm_f64x2_splat(4);
    int i = 0;
    for (; i + 1 < len; i += 2) {
        v128_t d0 = wasm_f64x2_sub(wasm_v128_load(palette + i), r);
        v128_t d1 = wasm_f64x2_sub(wasm_v128_load(palette + MaxColors + i), g);
        v128_t d2 = wasm_f64x2_sub(wasm_v128_load(palette + 2 * MaxColors + i), b);
        v128_t s = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(two, d0), d0),
                                                 wasm_f64x2_mul(wasm_f64x2_mul(four, d1), d1)),
                                  wasm_f64x2_mul(d2, d2));
        wasm_v128_store(dists + i, s);
    }
    for (; i < len; i++) {
        double d0 = palette[i] - color[0], d1 = palette[MaxColors + i] - color[1], d2 = palette[2 * MaxColors + i] - color[2];
        dists[i] = 2 * d0 * d0 + 4 * d1 * d1 + d2 * d2;
    }
}

// JS getClosestColor: scans from the end, strict <, so ties go to the highest index.
// skip: index to leave out (JS built a copy of the palette without it), or -1
static int closestFromDists(int len, int skip, double* outDist) {
    if (skip >= 0) dists[skip] = Inf;
    int minIndex = len - 1;
    double minDist = dists[minIndex];
    for (int i = len - 2; i >= 0; i--) {
        if (dists[i] < minDist) {
            minIndex = i;
            minDist = dists[i];
        }
    }
    *outDist = minDist;
    return minIndex;
}
// One SIMD pass keeping each lane's min and its index. Ascending with <= keeps the
// highest index among ties per lane, and lanes merge the same way: matches the JS scan.
static int getClosestColor(const double* palette, int len, const double* color, double* outDist, int skip = -1) {
    if (skip >= 0 || len < 2) {
        distances(palette, len, color);
        return closestFromDists(len, skip, outDist);
    }
    v128_t r = wasm_f64x2_splat(color[0]), g = wasm_f64x2_splat(color[1]), b = wasm_f64x2_splat(color[2]);
    v128_t two = wasm_f64x2_splat(2), four = wasm_f64x2_splat(4);
    v128_t best = wasm_f64x2_splat(Inf);
    v128_t bestIndex = wasm_i64x2_const(-1, -1), index = wasm_i64x2_const(0, 1), step = wasm_i64x2_splat(2);
    int i = 0;
    for (; i + 1 < len; i += 2) {
        v128_t d0 = wasm_f64x2_sub(wasm_v128_load(palette + i), r);
        v128_t d1 = wasm_f64x2_sub(wasm_v128_load(palette + MaxColors + i), g);
        v128_t d2 = wasm_f64x2_sub(wasm_v128_load(palette + 2 * MaxColors + i), b);
        v128_t s = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(two, d0), d0),
                                                 wasm_f64x2_mul(wasm_f64x2_mul(four, d1), d1)),
                                  wasm_f64x2_mul(d2, d2));
        v128_t take = wasm_f64x2_le(s, best);
        best = wasm_v128_bitselect(s, best, take);
        bestIndex = wasm_v128_bitselect(index, bestIndex, take);
        index = wasm_i64x2_add(index, step);
    }
    double minDist = wasm_f64x2_extract_lane(best, 1);
    int minIndex = (int)wasm_i64x2_extract_lane(bestIndex, 1);
    double d0 = wasm_f64x2_extract_lane(best, 0);
    int i0 = (int)wasm_i64x2_extract_lane(bestIndex, 0);
    if (d0 < minDist || (d0 == minDist && i0 > minIndex)) {
        minDist = d0;
        minIndex = i0;
    }
    if (i < len) {  // odd length: the last color has the highest index, so it wins ties
        double e0 = palette[i] - color[0], e1 = palette[MaxColors + i] - color[1], e2 = palette[2 * MaxColors + i] - color[2];
        double dist = 2 * e0 * e0 + 4 * e1 * e1 + e2 * e2;
        if (dist <= minDist) {
            minDist = dist;
            minIndex = i;
        }
    }
    *outDist = minDist;
    return minIndex;
}

// min distance only; min is order independent, so SIMD lanes can reduce freely
static double minColorDistance(const double* palette, int len, const double* color) {
    v128_t r = wasm_f64x2_splat(color[0]), g = wasm_f64x2_splat(color[1]), b = wasm_f64x2_splat(color[2]);
    v128_t two = wasm_f64x2_splat(2), four = wasm_f64x2_splat(4);
    v128_t best = wasm_f64x2_splat(Inf);
    int i = 0;
    for (; i + 1 < len; i += 2) {
        v128_t d0 = wasm_f64x2_sub(wasm_v128_load(palette + i), r);
        v128_t d1 = wasm_f64x2_sub(wasm_v128_load(palette + MaxColors + i), g);
        v128_t d2 = wasm_f64x2_sub(wasm_v128_load(palette + 2 * MaxColors + i), b);
        v128_t s = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(two, d0), d0),
                                                 wasm_f64x2_mul(wasm_f64x2_mul(four, d1), d1)),
                                  wasm_f64x2_mul(d2, d2));
        best = wasm_f64x2_pmin(best, s);
    }
    double b0 = wasm_f64x2_extract_lane(best, 0), b1 = wasm_f64x2_extract_lane(best, 1);
    double minDist = b1 < b0 ? b1 : b0;
    for (; i < len; i++) {
        double d0 = palette[i] - color[0], d1 = palette[MaxColors + i] - color[1], d2 = palette[2 * MaxColors + i] - color[2];
        double dist = 2 * d0 * d0 + 4 * d1 * d1 + d2 * d2;
        if (dist < minDist) minDist = dist;
    }
    return minDist;
}

// minColorDistance for two colors at once, sharing each palette load
static void minColorDistance2(const double* palette, int len, const double* a, const double* b, double* outA, double* outB) {
    v128_t ar = wasm_f64x2_splat(a[0]), ag = wasm_f64x2_splat(a[1]), ab = wasm_f64x2_splat(a[2]);
    v128_t br = wasm_f64x2_splat(b[0]), bg = wasm_f64x2_splat(b[1]), bb = wasm_f64x2_splat(b[2]);
    v128_t two = wasm_f64x2_splat(2), four = wasm_f64x2_splat(4);
    v128_t bestA = wasm_f64x2_splat(Inf), bestB = bestA;
    int i = 0;
    for (; i + 1 < len; i += 2) {
        v128_t pr = wasm_v128_load(palette + i);
        v128_t pg = wasm_v128_load(palette + MaxColors + i);
        v128_t pb = wasm_v128_load(palette + 2 * MaxColors + i);
        v128_t d0 = wasm_f64x2_sub(pr, ar), d1 = wasm_f64x2_sub(pg, ag), d2 = wasm_f64x2_sub(pb, ab);
        v128_t e0 = wasm_f64x2_sub(pr, br), e1 = wasm_f64x2_sub(pg, bg), e2 = wasm_f64x2_sub(pb, bb);
        v128_t sa = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(two, d0), d0),
                                                  wasm_f64x2_mul(wasm_f64x2_mul(four, d1), d1)),
                                   wasm_f64x2_mul(d2, d2));
        v128_t sb = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_mul(two, e0), e0),
                                                  wasm_f64x2_mul(wasm_f64x2_mul(four, e1), e1)),
                                   wasm_f64x2_mul(e2, e2));
        bestA = wasm_f64x2_pmin(bestA, sa);
        bestB = wasm_f64x2_pmin(bestB, sb);
    }
    double minA = wasm_f64x2_extract_lane(bestA, 0), minB = wasm_f64x2_extract_lane(bestB, 0);
    double laneA = wasm_f64x2_extract_lane(bestA, 1), laneB = wasm_f64x2_extract_lane(bestB, 1);
    if (laneA < minA) minA = laneA;
    if (laneB < minB) minB = laneB;
    if (i < len) {
        double d0 = palette[i] - a[0], d1 = palette[MaxColors + i] - a[1], d2 = palette[2 * MaxColors + i] - a[2];
        double e0 = palette[i] - b[0], e1 = palette[MaxColors + i] - b[1], e2 = palette[2 * MaxColors + i] - b[2];
        double da = 2 * d0 * d0 + 4 * d1 * d1 + d2 * d2, db = 2 * e0 * e0 + 4 * e1 * e1 + e2 * e2;
        if (da < minA) minA = da;
        if (db < minB) minB = db;
    }
    *outA = minA;
    *outB = minB;
}

// like JS's nesColorCache, keyed by the rounded color: the first color seen for a
// key decides its NES color. Stores index + 1, 0 = empty.
static unsigned char* nesCache;
static int nesIndex(const double* color) {
    int key = ((int)jsRound(color[0]) << 16) | ((int)jsRound(color[1]) << 8) | (int)jsRound(color[2]);
    // ponytail: keys outside 24 bits skip the cache; only reachable with out-of-range colors
    bool cacheable = key >= 0 && key < (1 << 24);
    int index = cacheable ? nesCache[key] - 1 : -1;
    if (index < 0) {
        double dist;
        index = getClosestColor(nesSet.pal(0), 64, color, &dist);
        if (cacheable) nesCache[key] = (unsigned char)(index + 1);
    }
    return index;
}
// NES mode works in a perceptual space (see nesMetric in worker.js): pixel and palette
// colors are scaled OKLab coordinates, so colorDistance compares lightness first and
// hue softly. Colors only turn back into RGB on the way out.
static bool perceptual;
static const double* perceptualImage;   // 3 per image pixel
static double colorZeroPalette[3];      // colorZeroValue as a palette color
static int nearestNes(const double* color) {
    double dist;
    return getClosestColor(nesSet.pal(0), 64, color, &dist);
}
// palette color -> RGB bytes for output
static void outputRgb(const double* color, double* rgb) {
    if (!perceptual) {
        copyColor(rgb, color);
        return;
    }
    int i = nearestNes(color);
    rgb[0] = nesRgb[i] >> 16;
    rgb[1] = (nesRgb[i] >> 8) & 0xFF;
    rgb[2] = nesRgb[i] & 0xFF;
}

static void toNbitColor(double* color) {
    if (colorSpace == SpaceNes) {
        nesSet.get(0, perceptual ? nearestNes(color) : nesIndex(color), color);
        return;
    }
    for (int i = 0; i < 3; i++) color[i] = toNbit(color[i]);
}

// ---- tiles and pixels ----
static int imageWidth, imageHeight, numTiles, numPixels;
static int *tileColorStart, *tileColorCount, *tilePixelStart, *tilePixelCount;
static double* tileColors;  // 3 per entry
static double* tileCounts;
static double* pixelColor;  // 3 per pixel
static int *pixelX, *pixelY, *pixelTile;
static int* tileAt;        // tile grid position -> tile index, -1 if fully transparent
static int* colorAt;       // image pixel -> tileColors entry, -1 if transparent
static int* pixelAt;       // image pixel -> pixel index, -1 if transparent
static unsigned char* hint;  // per tile: palette that won last time, tried first

static void extractTiles(const unsigned char* image, int width, int height) {
    imageWidth = width;
    imageHeight = height;
    int tilesX = (width + tileWidth - 1) / tileWidth, tilesY = (height + tileHeight - 1) / tileHeight;
    int maxTiles = tilesX * tilesY, maxPixels = width * height;
    tileColorStart = allocArray<int>(maxTiles);
    tileColorCount = allocArray<int>(maxTiles);
    tilePixelStart = allocArray<int>(maxTiles);
    tilePixelCount = allocArray<int>(maxTiles);
    tileAt = allocArray<int>(maxTiles);
    hint = allocArray<unsigned char>(maxTiles);
    fill(hint, maxTiles, (unsigned char)0);
    tileColors = allocArray<double>(3 * maxPixels);
    tileCounts = allocArray<double>(maxPixels);
    pixelColor = allocArray<double>(3 * maxPixels);
    pixelX = allocArray<int>(maxPixels);
    pixelY = allocArray<int>(maxPixels);
    pixelTile = allocArray<int>(maxPixels);
    colorAt = allocArray<int>(maxPixels);
    fill(colorAt, maxPixels, -1);
    pixelAt = allocArray<int>(maxPixels);
    fill(pixelAt, maxPixels, -1);
    numTiles = 0;
    numPixels = 0;
    int numColors = 0;
    for (int startY = 0, pos = 0; startY < height; startY += tileHeight) {
        for (int startX = 0; startX < width; startX += tileWidth, pos++) {
            int t = numTiles;
            int colorStart = numColors, pixelStart = numPixels;
            int endX = startX + tileWidth < width ? startX + tileWidth : width;
            int endY = startY + tileHeight < height ? startY + tileHeight : height;
            for (int y = startY; y < endY; y++) {
                for (int x = startX; x < endX; x++) {
                    const unsigned char* p = image + 4 * (x + width * y);
                    double color[3] = {(double)p[0], (double)p[1], (double)p[2]};
                    if (colorZeroBehaviour == TransparentFromColor && equalColor(color, colorZeroValue)) continue;
                    if (colorZeroBehaviour == TransparentFromTransparent && p[3] < 255) continue;
                    if (perceptual) copyColor(color, perceptualImage + 3 * (x + width * y));
                    copyColor(pixelColor + 3 * numPixels, color);
                    pixelX[numPixels] = x;
                    pixelY[numPixels] = y;
                    pixelTile[numPixels] = t;
                    pixelAt[x + width * y] = numPixels;
                    numPixels++;
                    int found = -1;
                    for (int i = colorStart; i < numColors && found < 0; i++)
                        if (equalColor(tileColors + 3 * i, color)) found = i;
                    if (found >= 0) {
                        tileCounts[found]++;
                    } else {
                        found = numColors++;
                        copyColor(tileColors + 3 * found, color);
                        tileCounts[found] = 1;
                    }
                    colorAt[x + width * y] = found;
                }
            }
            tileAt[pos] = -1;
            if (numColors == colorStart) continue;  // fully transparent tile
            tileAt[pos] = t;
            tileColorStart[t] = colorStart;
            tileColorCount[t] = numColors - colorStart;
            tilePixelStart[t] = pixelStart;
            tilePixelCount[t] = numPixels - pixelStart;
            numTiles++;
        }
    }
}

// ---- dither ----
static const double brightnessScale[3] = {0.299, 0.587, 0.114};
static double comparedColor[3];  // the dithered color the last pixel was matched against

static void cacheDither(PaletteSet& set, int p, int c) {
    int k = p * MaxColors + c;
    if (set.cached[k]) return;
    double color[3];
    set.get(p, c, color);
    double brightness = 0;
    if (perceptual) brightness = color[0];  // scaled OKLab lightness
    else for (int i = 0; i < 3; i++) brightness += brightnessScale[i] * (color[i] * color[i]);
    set.brightness[k] = brightness;
    toNbitColor(color);
    double* rl = set.reducedLinear + p * PaletteStride;
    for (int i = 0; i < 3; i++) rl[i * MaxColors + c] = perceptual ? color[i] : color[i] * color[i];
    set.cached[k] = true;
}

struct Candidate {
    int colorIndex;
    double colorDistance, brightness;
};
static int getClosestColorDither(PaletteSet& set, int p, int len, const double* color, int x, int y,
                                 double* outDist, int skip = -1) {
    const double* palette = set.pal(p);
    const double* rl = set.reducedLinear + p * PaletteStride;
    double error[3] = {0, 0, 0}, linearPixel[3];
    // error diffuses in linear light; OKLab is already close to linear, so it diffuses as is
    for (int i = 0; i < 3; i++) linearPixel[i] = perceptual ? color[i] : color[i] * color[i];
    Candidate candidates[4];
    double* c = comparedColor;
    for (int i = 0; i < ditherPixels; i++) {
        for (int k = 0; k < 3; k++) {
            c[k] = linearPixel[k] + error[k] * ditherWeight;
            if (perceptual) continue;
            if (c[k] < 0) c[k] = 0;
            else if (c[k] > 255 * 255) c[k] = 255 * 255;
            c[k] = __builtin_sqrt(c[k]);
        }
        double minDist;
        int minIndex = getClosestColor(palette, len, c, &minDist, skip);
        cacheDither(set, p, minIndex);
        candidates[i] = {minIndex, minDist, set.brightness[p * MaxColors + minIndex]};
        for (int k = 0; k < 3; k++) {
            error[k] += linearPixel[k];
            error[k] -= rl[k * MaxColors + minIndex];
        }
    }
    for (int i = 0; i < ditherPixels - 1; i++) {
        for (int j = i + 1; j < ditherPixels; j++) {
            if (candidates[i].brightness > candidates[j].brightness) {
                Candidate tmp = candidates[i];
                candidates[i] = candidates[j];
                candidates[j] = tmp;
            }
        }
    }
    const Candidate& chosen = candidates[ditherPattern[x & 1][y & 1]];
    *outDist = chosen.colorDistance;
    return chosen.colorIndex;
}

// ---- palette search ----
// Sums keep going while sum < bound (or <= when inclusive) and return the partial sum
// once it can't win. Terms are never negative, so a cut sum never wins either.
static bool underBound(double sum, double bound, bool inclusive) { return sum < bound || (inclusive && sum == bound); }
static double paletteDistance(PaletteSet& set, int p, int tile, double bound, bool inclusive) {
    const double* palette = set.pal(p);
    double sum = 0;
    int start = tileColorStart[tile], end = start + tileColorCount[tile];
    int i = start;
    // pairs of colors per palette pass; still added one at a time, in order
    for (; i + 1 < end && underBound(sum, bound, inclusive); i += 2) {
        double da, db;
        minColorDistance2(palette, paletteColors, tileColors + 3 * i, tileColors + 3 * (i + 1), &da, &db);
        sum += tileCounts[i] * da;
        if (!underBound(sum, bound, inclusive)) return sum;
        sum += tileCounts[i + 1] * db;
    }
    if (i < end && underBound(sum, bound, inclusive))
        sum += tileCounts[i] * minColorDistance(palette, paletteColors, tileColors + 3 * i);
    return sum;
}
// While recording, dither searches keep each pixel's answer per palette, so callers
// can reuse the winning palette's answers (it is always summed in full).
const int MaxTilePixels = 32 * 32;
static bool recording;
static int recordIndex[MaxPalettes * MaxTilePixels];
static double recordDist[MaxPalettes * MaxTilePixels];
static int* pixelChoice;  // per pixel: winning palette's dither answer
static double* pixelChoiceDist;
static void keepRecord(int tile, int p) {
    int start = tilePixelStart[tile];
    for (int k = 0; k < tilePixelCount[tile]; k++) {
        pixelChoice[start + k] = recordIndex[p * MaxTilePixels + k];
        pixelChoiceDist[start + k] = recordDist[p * MaxTilePixels + k];
    }
}

static double paletteDistanceDither(PaletteSet& set, int p, int tile, double bound, bool inclusive) {
    double sum = 0, dist;
    int start = tilePixelStart[tile], end = start + tilePixelCount[tile];
    for (int i = start; i < end && underBound(sum, bound, inclusive); i++) {
        int c = getClosestColorDither(set, p, paletteColors, pixelColor + 3 * i, pixelX[i], pixelY[i], &dist);
        if (recording) {
            recordIndex[p * MaxTilePixels + i - start] = c;
            recordDist[p * MaxTilePixels + i - start] = dist;
        }
        sum += dist;
    }
    return sum;
}
static double tileDistance(PaletteSet& set, int p, int tile, bool useDither, double bound, bool inclusive) {
    return useDither ? paletteDistanceDither(set, p, tile, bound, inclusive)
                     : paletteDistance(set, p, tile, bound, inclusive);
}

// Same answer as JS (lowest index with the smallest total), but starts from the
// tile's last winner so the other palettes usually stop after a few colors.
static int closestPalette(PaletteSet& set, int tile, bool useDither, double* outDist = nullptr) {
    if (numPalettes == 1) {
        if (outDist || recording) {
            double dist = tileDistance(set, 0, tile, useDither, Inf, false);
            if (outDist) *outDist = dist;
        }
        return 0;
    }
    int best = hint[tile] < numPalettes ? hint[tile] : 0;
    double bestDist = tileDistance(set, best, tile, useDither, Inf, false);
    int first = best;
    for (int p = 0; p < numPalettes; p++) {
        if (p == first) continue;
        bool winsTies = p < best;
        double dist = tileDistance(set, p, tile, useDither, bestDist, winsTies);
        if (dist < bestDist || (winsTies && dist == bestDist)) {
            best = p;
            bestDist = dist;
        }
    }
    hint[tile] = (unsigned char)best;
    if (outDist) *outDist = bestDist;
    return best;
}

static int maxIndex(const double* values, int n) {
    int m = 0;
    for (int i = 1; i < n; i++) if (values[i] > values[m]) m = i;
    return m;
}
static int minIndex(const double* values, int n) {
    int m = 0;
    for (int i = 1; i < n; i++) if (values[i] < values[m]) m = i;
    return m;
}

// ---- training ----
static int* shuffleValues;
static int shuffleIndex;
static int nextPixel() {
    if (++shuffleIndex >= numPixels) {
        for (int i = 0; i < numPixels; i++) {
            int index = i + (int)__builtin_floor(jsRandom() * (numPixels - i));
            int tmp = shuffleValues[i];
            shuffleValues[i] = shuffleValues[index];
            shuffleValues[index] = tmp;
        }
        shuffleIndex = 0;
    }
    return shuffleValues[shuffleIndex];
}

// tilePaletteCache (or null): tile -> palette index, -1 = not cached; reset once per training pass
static void movePalettesCloser(int pixel, double alpha, int* tilePaletteCache) {
    int sharedColorIndex = usesSharedColor() ? 0 : -1;
    int tile = pixelTile[pixel];
    const double* color = pixelColor + 3 * pixel;
    int p, c;
    const double* target;
    double dist;
    if (dither == DitherSlow) {
        p = tilePaletteCache && tilePaletteCache[tile] >= 0 ? tilePaletteCache[tile] : closestPalette(palettes, tile, true);
        if (tilePaletteCache) tilePaletteCache[tile] = p;
        c = getClosestColorDither(palettes, p, paletteColors, color, pixelX[pixel], pixelY[pixel], &dist);
        target = comparedColor;
    } else {
        p = closestPalette(palettes, tile, false);
        c = getClosestColor(palettes.pal(p), paletteColors, color, &dist);
        target = color;
    }
    if (c == sharedColorIndex) return;
    double moved[3];
    palettes.get(p, c, moved);
    for (int i = 0; i < 3; i++) moved[i] = (1 - alpha) * moved[i] + alpha * target[i];
    palettes.set(p, c, moved);
}

static double iterations() {
    double result = fractionOfPixels * numPixels;
    return dither == DitherSlow ? result / 5 : result;
}
static double trainingAlpha() { return dither == DitherSlow ? 0.1 : 0.3; }

static void colorQuantize1Color() {
    double iters = iterations(), alpha = trainingAlpha();
    double avgColor[3] = {0, 0, 0};
    for (int i = 0; i < numPixels; i++)
        for (int k = 0; k < 3; k++) avgColor[k] += pixelColor[3 * i + k];
    for (int k = 0; k < 3; k++) avgColor[k] *= 1.0 / numPixels;
    numPalettes = 1;
    paletteColors = 1;
    palettes.set(0, 0, avgColor);
    if (usesSharedColor()) {
        paletteColors = 2;
        palettes.set(0, 1, avgColor);
        palettes.set(0, 0, colorZeroPalette);
    }
    int splitIndex = 0;
    double distances[MaxPalettes];
    for (int n = 2; n <= targetPalettes; n++) {
        __builtin_memcpy(palettes.pal(numPalettes), palettes.pal(splitIndex), sizeof(double) * PaletteStride);
        numPalettes++;
        palettes.invalidate();
        for (int i = 0; i < iters; i++) movePalettesCloser(nextPixel(), alpha, nullptr);
        fill(distances, n, 0.0);
        for (int t = 0; t < numTiles; t++) {
            double dist;
            int index = closestPalette(palettes, t, false, &dist);
            distances[index] += dist;
        }
        splitIndex = maxIndex(distances, n);
    }
}

static void expandPalettesByOneColor() {
    double iters = iterations(), alpha = trainingAlpha();
    int numColors = paletteColors + 1;
    int splitIndexes[MaxPalettes] = {};
    if (numColors > 2) {
        static double totals[MaxPalettes * (MaxColors + 1)];
        fill(totals, numPalettes * numColors, 0.0);
        for (int t = 0; t < numTiles; t++) {
            int p = closestPalette(palettes, t, false);
            int start = tileColorStart[t], end = start + tileColorCount[t];
            for (int i = start; i < end; i++) {
                double dist;
                int index = getClosestColor(palettes.pal(p), paletteColors, tileColors + 3 * i, &dist);
                totals[p * numColors + index] += tileCounts[i] * dist;
            }
        }
        for (int p = 0; p < numPalettes; p++) splitIndexes[p] = maxIndex(totals + p * numColors, numColors);
    }
    for (int p = 0; p < numPalettes; p++) {
        double color[3];
        palettes.get(p, splitIndexes[p], color);
        palettes.set(p, paletteColors, color);
    }
    paletteColors++;
    for (int i = 0; i < iters; i++) movePalettesCloser(nextPixel(), alpha, nullptr);
}

static double meanSquareError() {
    double total = 0, count = 0;
    for (int t = 0; t < numTiles; t++) {
        int p = closestPalette(palettes, t, false);
        int start = tileColorStart[t], end = start + tileColorCount[t];
        for (int i = start; i < end; i++) {
            total += minColorDistance(palettes.pal(p), paletteColors, tileColors + 3 * i) * tileCounts[i];
            count += tileCounts[i];
        }
    }
    return total / count;
}

static int* tileScratch;  // per-tile palette index for replaceWeakestColors

static void replaceWeakestColors(double minColorFactor, double minPaletteFactor) {
    bool useSlowDither = dither == DitherSlow;
    int* closestPaletteIndex = tileScratch;
    double totalPaletteMse[MaxPalettes] = {}, removedPaletteMse[MaxPalettes] = {};
    int maxPaletteIndex = 0, minPaletteIndex = 0;
    fill(closestPaletteIndex, numTiles, 0);
    recording = useSlowDither;
    if (numPalettes > 1) {
        for (int t = 0; t < numTiles; t++) {
            // needs the best and second-best totals; any palette whose partial sum passes
            // the current second best can be neither, so it stops early
            double distances[MaxPalettes];
            int start = hint[t] < numPalettes ? hint[t] : 0;
            double best = Inf, second = Inf;
            for (int n = 0; n < numPalettes; n++) {
                int p = (start + n) % numPalettes;
                double dist = tileDistance(palettes, p, t, useSlowDither, second, true);
                distances[p] = dist;
                if (dist < best) {
                    second = best;
                    best = dist;
                } else if (dist < second) {
                    second = dist;
                }
            }
            int index = minIndex(distances, numPalettes);  // cut sums exceed best, so this matches JS
            totalPaletteMse[index] += distances[index];
            closestPaletteIndex[t] = index;
            hint[t] = (unsigned char)index;
            if (useSlowDither) keepRecord(t, index);
            double secondDistance = Inf;
            for (int p = 0; p < numPalettes; p++)
                if (p != index && distances[p] < secondDistance) secondDistance = distances[p];
            removedPaletteMse[index] += secondDistance;
        }
        maxPaletteIndex = maxIndex(totalPaletteMse, numPalettes);
        minPaletteIndex = minIndex(removedPaletteMse, numPalettes);
    }
    recording = false;
    copyPalettes(scratch, palettes);
    if (paletteColors > 1) {
        static double totalColorMse[MaxPalettes * MaxColors], secondColorMse[MaxPalettes * MaxColors];
        fill(totalColorMse, numPalettes * MaxColors, 0.0);
        fill(secondColorMse, numPalettes * MaxColors, 0.0);
        for (int t = 0; t < numTiles; t++) {
            int p = closestPaletteIndex[t];
            double* total = totalColorMse + p * MaxColors;
            double* second = secondColorMse + p * MaxColors;
            if (useSlowDither) {
                int start = tilePixelStart[t], end = start + tilePixelCount[t];
                for (int i = start; i < end; i++) {
                    double minDist, secondDist;
                    const double* color = pixelColor + 3 * i;
                    int index;
                    if (numPalettes > 1) {
                        index = pixelChoice[i];
                        minDist = pixelChoiceDist[i];
                    } else {
                        index = getClosestColorDither(palettes, p, paletteColors, color, pixelX[i], pixelY[i], &minDist);
                    }
                    total[index] += minDist;
                    getClosestColorDither(palettes, p, paletteColors, color, pixelX[i], pixelY[i], &secondDist, index);
                    second[index] += secondDist;
                }
            } else {
                int start = tileColorStart[t], end = start + tileColorCount[t];
                for (int i = start; i < end; i++) {
                    double minDist;
                    distances(palettes.pal(p), paletteColors, tileColors + 3 * i);
                    int index = closestFromDists(paletteColors, -1, &minDist);
                    total[index] += minDist * tileCounts[i];
                    double secondDist = Inf;
                    for (int k = 0; k < paletteColors; k++)
                        if (k != index && dists[k] < secondDist) secondDist = dists[k];
                    second[index] += secondDist * tileCounts[i];
                }
            }
        }
        int sharedColorIndex = usesSharedColor() ? 0 : -1;
        for (int p = 0; p < numPalettes; p++) {
            const double* total = totalColorMse + p * MaxColors;
            const double* second = secondColorMse + p * MaxColors;
            int maxColorIndex = maxIndex(total, paletteColors);
            int minColorIndex = minIndex(second, paletteColors);
            if (minColorIndex != maxColorIndex && minColorIndex != sharedColorIndex &&
                second[minColorIndex] < minColorFactor * total[maxColorIndex]) {
                double color[3];
                palettes.get(p, maxColorIndex, color);
                scratch.set(p, minColorIndex, color);
            }
        }
    }
    if (minPaletteIndex != maxPaletteIndex &&
        removedPaletteMse[minPaletteIndex] < minPaletteFactor * totalPaletteMse[maxPaletteIndex])
        __builtin_memcpy(scratch.pal(minPaletteIndex), scratch.pal(maxPaletteIndex), sizeof(double) * PaletteStride);
    copyPalettes(palettes, scratch);
}

static void kMeans() {
    static double counts[MaxPalettes * MaxColors];
    static double sums[MaxPalettes * PaletteStride];  // same layout as a palette
    fill(counts, numPalettes * MaxColors, 0.0);
    fill(sums, numPalettes * PaletteStride, 0.0);
    for (int t = 0; t < numTiles; t++) {
        if (dither == DitherSlow) {
            int p = closestPalette(palettes, t, true);
            int start = tilePixelStart[t], end = start + tilePixelCount[t];
            for (int i = start; i < end; i++) {
                double dist;
                int c = getClosestColorDither(palettes, p, paletteColors, pixelColor + 3 * i, pixelX[i], pixelY[i], &dist);
                counts[p * MaxColors + c] += 1;
                for (int k = 0; k < 3; k++) sums[p * PaletteStride + k * MaxColors + c] += pixelColor[3 * i + k];
            }
        } else {
            int p = closestPalette(palettes, t, false);
            int start = tileColorStart[t], end = start + tileColorCount[t];
            for (int i = start; i < end; i++) {
                double dist;
                int c = getClosestColor(palettes.pal(p), paletteColors, tileColors + 3 * i, &dist);
                counts[p * MaxColors + c] += tileCounts[i];
                for (int k = 0; k < 3; k++) sums[p * PaletteStride + k * MaxColors + c] += tileColors[3 * i + k] * tileCounts[i];
            }
        }
    }
    int sharedColorIndex = usesSharedColor() ? 0 : -1;
    for (int p = 0; p < numPalettes; p++) {
        for (int c = 0; c < paletteColors; c++) {
            double count = counts[p * MaxColors + c];
            if (count == 0 || c == sharedColorIndex) continue;  // keeps the palette color
            double color[3];
            for (int k = 0; k < 3; k++) color[k] = sums[p * PaletteStride + k * MaxColors + c] * (1.0 / count);
            palettes.set(p, c, color);
        }
    }
    palettes.invalidate();
}

static void reducePalettes(PaletteSet& set) {
    for (int p = 0; p < numPalettes; p++) {
        for (int c = 0; c < paletteColors; c++) {
            double color[3];
            set.get(p, c, color);
            toNbitColor(color);
            set.set(p, c, color);
        }
    }
    set.invalidate();
}

// palettes go to JS as packed [r, g, b] triples
static double* packed;
static void emitPalettes(int doSorting) {
    for (int p = 0; p < numPalettes; p++)
        for (int c = 0; c < paletteColors; c++) {
            double color[3];
            palettes.get(p, c, color);
            outputRgb(color, packed + 3 * (p * paletteColors + c));  // NES mode shows the snapped colors
        }
    jsPalettes(packed, numPalettes, paletteColors, doSorting);
}

// ---- rendering (JS quantizeTiles) ----
static const unsigned char* renderSource;
static unsigned char *outData, *outIndexes, *outPalette;
static int* colorChoice;  // per tileColors entry, reused per tile

static void render(PaletteSet& src, bool useDither) {
    int width = imageWidth, height = imageHeight;
    int adjustedIndex = hasTransparentIndex() ? 1 : 0;
    __builtin_memcpy(reduced.colors, src.colors, sizeof(double) * numPalettes * PaletteStride);
    reducePalettes(reduced);
    double transparentColor[3], colorZero[3];  // RGB
    if (perceptual) {
        double snapped[3];
        copyColor(snapped, colorZeroPalette);
        toNbitColor(snapped);
        outputRgb(snapped, colorZero);
        copyColor(transparentColor, dither != DitherOff ? colorZero : colorZeroValue);
    } else {
        copyColor(transparentColor, colorZeroValue);
        if (dither != DitherOff) toNbitColor(transparentColor);
        copyColor(colorZero, colorZeroValue);
        toNbitColor(colorZero);
    }
    int bmpWidth = (width + 3) / 4 * 4;
    fill(outIndexes, bmpWidth * height, (unsigned char)0);
    fill(outPalette, 1024, (unsigned char)0);
    if (targetPalettes * colorsPerPalette <= 256) {
        int i = 0;
        for (int p = 0; p < numPalettes; p++) {
            if (adjustedIndex) {
                for (int k = 0; k < 3; k++) outPalette[i + k] = clampByte(colorZero[2 - k]);
                i += 4;
            }
            for (int c = 0; c < paletteColors; c++) {
                double color[3], rgb[3];
                reduced.get(p, c, color);
                outputRgb(color, rgb);
                for (int k = 0; k < 3; k++) outPalette[i + k] = clampByte(rgb[2 - k]);
                i += 4;
            }
        }
    }
    for (int startY = 0, pos = 0; startY < height; startY += tileHeight) {
        for (int startX = 0; startX < width; startX += tileWidth, pos++) {
            int t = tileAt[pos];
            recording = useDither;
            int p = t >= 0 ? closestPalette(reduced, t, useDither) : 0;
            recording = false;
            if (t >= 0 && useDither) keepRecord(t, p);
            const double* palette = reduced.pal(p);
            if (t >= 0 && !useDither) {
                int start = tileColorStart[t], end = start + tileColorCount[t];
                for (int i = start; i < end; i++) {
                    double dist;
                    colorChoice[i] = getClosestColor(palette, paletteColors, tileColors + 3 * i, &dist);
                }
            }
            int endX = startX + tileWidth < width ? startX + tileWidth : width;
            int endY = startY + tileHeight < height ? startY + tileHeight : height;
            for (int y = startY; y < endY; y++) {
                for (int x = startX; x < endX; x++) {
                    int index = 4 * (x + width * y);
                    int bmpIndex = x + bmpWidth * (height - 1 - y);
                    const unsigned char* px = renderSource + index;
                    double color[3] = {(double)px[0], (double)px[1], (double)px[2]};
                    if ((colorZeroBehaviour == TransparentFromTransparent && px[3] < 255) ||
                        (colorZeroBehaviour == TransparentFromColor && equalColor(color, transparentColor))) {
                        for (int k = 0; k < 4; k++) outData[index + k] = px[k];
                        outIndexes[bmpIndex] = clampByte(p * colorsPerPalette);
                        continue;
                    }
                    if (perceptual) copyColor(color, perceptualImage + 3 * (x + width * y));
                    int c;
                    double dist;
                    if (useDither && pixelAt[x + width * y] >= 0) c = pixelChoice[pixelAt[x + width * y]];
                    else if (useDither) c = getClosestColorDither(reduced, p, paletteColors, color, x, y, &dist);
                    else if (colorAt[x + width * y] >= 0) c = colorChoice[colorAt[x + width * y]];
                    else c = getClosestColor(palette, paletteColors, color, &dist);
                    double out[3], rgb[3];
                    reduced.get(p, c, out);
                    outputRgb(out, rgb);
                    for (int k = 0; k < 3; k++) outData[index + k] = clampByte(rgb[k]);
                    outData[index + 3] = 255;
                    outIndexes[bmpIndex] = clampByte(p * colorsPerPalette + c + adjustedIndex);
                }
            }
        }
    }
    jsImage(outData, outIndexes, outPalette);
}

// ---- entry points ----
EXPORT void configure(int tileW, int tileH, int numPals, int colorsPerPal, int bits, double fraction,
                      int czb, double cz0, double cz1, double cz2, int ditherMode, double weight,
                      int pattern, int space) {
    tileWidth = tileW;
    tileHeight = tileH;
    targetPalettes = numPals;
    colorsPerPalette = colorsPerPal;
    bitsPerChannel = bits;
    fractionOfPixels = fraction;
    colorZeroBehaviour = czb;
    colorZeroValue[0] = cz0;
    colorZeroValue[1] = cz1;
    colorZeroValue[2] = cz2;
    dither = ditherMode;
    ditherWeight = weight;
    for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++) ditherPattern[i][j] = ditherPatterns[pattern][i][j];
    ditherPixels = pattern >= 3 ? 2 : 4;
    colorSpace = space;
    for (int i = 0; i < 64; i++) {
        double color[3] = {(double)(nesRgb[i] >> 16), (double)((nesRgb[i] >> 8) & 0xFF), (double)(nesRgb[i] & 0xFF)};
        nesSet.set(0, i, color);
    }
    if (colorSpace == SpaceNes && !nesCache) nesCache = allocArray<unsigned char>(1 << 24);  // fresh pages are zeroed
    copyColor(colorZeroPalette, colorZeroValue);
}

// NES best-fit model: JS converted every image pixel, the 64 NES colors and color zero
// into the model's space, scaled so colorDistance is the model's distance
EXPORT void usePerceptual(const double* image, const double* nesColors, double cz0, double cz1, double cz2) {
    perceptual = true;
    perceptualImage = image;
    for (int i = 0; i < 64; i++) nesSet.set(0, i, nesColors + 3 * i);
    colorZeroPalette[0] = cz0;
    colorZeroPalette[1] = cz1;
    colorZeroPalette[2] = cz2;
}

static void load(const unsigned char* image, int width, int height) {
    extractTiles(image, width, height);
    renderSource = image;
    outData = allocArray<unsigned char>(4 * width * height);
    outIndexes = allocArray<unsigned char>((width + 3) / 4 * 4 * height);
    outPalette = allocArray<unsigned char>(1024);
    colorChoice = allocArray<int>(width * height);
    pixelChoice = allocArray<int>(numPixels);
    pixelChoiceDist = allocArray<double>(numPixels);
    packed = allocArray<double>(MaxPalettes * PaletteStride);
}

// image: RGBA bytes already reduced by JS
EXPORT void quantize(const unsigned char* image, int width, int height) {
    load(image, width, height);
    shuffleValues = allocArray<int>(numPixels);
    for (int i = 0; i < numPixels; i++) shuffleValues[i] = i;
    shuffleIndex = numPixels - 1;
    int* tilePaletteCache = allocArray<int>(numTiles);
    tileScratch = allocArray<int>(numTiles);

    bool useDither = dither != DitherOff;
    double iters = iterations();
    double alpha = 0.3, finalAlpha = 0.05;
    if (dither == DitherSlow) {
        alpha = 0.1;
        finalAlpha = 0.02;
    }
    const int replaceIterations = 10;
    double prog[4] = {25, 65, 90, useDither ? 94.0 : 100.0};

    colorQuantize1Color();
    int startIndex = usesSharedColor() ? 3 : 2;
    int endIndex = colorsPerPalette - (hasTransparentIndex() ? 1 : 0);
    jsProgress(prog[0] / targetPalettes);
    emitPalettes(0);
    render(palettes, false);
    for (int numColors = startIndex; numColors <= endIndex; numColors++) {
        expandPalettesByOneColor();
        jsProgress(prog[0] * numColors / colorsPerPalette);
        emitPalettes(0);
        render(palettes, false);
    }

    double minMse = meanSquareError();
    copyPalettes(minPalettes, palettes);
    for (int i = 0; i < replaceIterations; i++) {
        replaceWeakestColors(0.5, 0.5);
        fill(tilePaletteCache, numTiles, -1);
        for (int iteration = 0; iteration < iters; iteration++) movePalettesCloser(nextPixel(), alpha, tilePaletteCache);
        double mse = meanSquareError();
        if (mse < minMse) {
            minMse = mse;
            copyPalettes(minPalettes, palettes);
        }
        jsProgress(prog[0] + (prog[1] - prog[0]) * (i + 1) / replaceIterations);
        emitPalettes(0);
        render(i == replaceIterations - 1 ? minPalettes : palettes, false);
    }
    copyPalettes(palettes, minPalettes);
    if (!useDither) reducePalettes(palettes);

    double finalIterations = iters * 10;
    double nextUpdate = iters;
    fill(tilePaletteCache, numTiles, -1);
    for (int iteration = 0; iteration < finalIterations; iteration++) {
        movePalettesCloser(nextPixel(), finalAlpha, tilePaletteCache);
        if (iteration >= nextUpdate) {
            nextUpdate += iters;
            fill(tilePaletteCache, numTiles, -1);
            jsProgress(prog[1] + (prog[2] - prog[1]) * iteration / finalIterations);
            emitPalettes(0);
        }
    }
    jsProgress(prog[2]);
    emitPalettes(0);
    if (!useDither) {
        reducePalettes(palettes);
        for (int i = 0; i < 3; i++) {
            kMeans();
            jsProgress(prog[2] + (prog[3] - prog[2]) * (i + 1) / 3);
            emitPalettes(0);
        }
    }
    reducePalettes(palettes);
    emitPalettes(1);
    render(palettes, useDither);
}

// Render a canceled run's checkpoint palettes (packed [r, g, b] triples) with dithering.
EXPORT void finishPartial(const unsigned char* image, int width, int height, const double* input, int numPals, int numColors) {
    load(image, width, height);
    numPalettes = numPals;
    paletteColors = numColors;
    for (int p = 0; p < numPalettes; p++)
        for (int c = 0; c < paletteColors; c++) palettes.set(p, c, input + 3 * (p * paletteColors + c));
    reducePalettes(palettes);
    emitPalettes(1);
    render(palettes, true);
}
