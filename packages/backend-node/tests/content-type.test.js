// The screenshot media type, sniffed from the bytes.
//
// Kept apart from router.test.js because this is the pure model-layer
// function: no Express, no store, no HTTP. The mirror of these cases lives in
// packages/backend-python/tests/test_content_type.py — the two implementations
// are meant to agree byte for byte.

import test from "node:test";
import assert from "node:assert/strict";

import { screenshotContentType } from "../src/models.js";

const PNG = Buffer.concat([Buffer.from("89504E470D0A1A0A", "hex"), Buffer.from("rest of the file")]);
const JPEG = Buffer.concat([Buffer.from("FFD8FFE0", "hex"), Buffer.from("rest of the file")]);
const GIF87 = Buffer.from("GIF87arest of the file");
const GIF89 = Buffer.from("GIF89arest of the file");
const WEBP = (() => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(1234);
  return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBPVP8 rest")]);
})();

test("recognised formats", () => {
  assert.equal(screenshotContentType(PNG), "image/png");
  assert.equal(screenshotContentType(JPEG), "image/jpeg");
  assert.equal(screenshotContentType(GIF87), "image/gif");
  assert.equal(screenshotContentType(GIF89), "image/gif");
  assert.equal(screenshotContentType(WEBP), "image/webp");
});

test("unrecognised bytes keep the historical default", () => {
  // image/png, not octet-stream. Every deployment before this returned
  // image/png for everything, so anything unrecognised must keep doing what it
  // did — the fix is for the formats we can positively identify, not a licence
  // to start refusing bytes that used to render.
  const riffNotWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
  for (const data of [Buffer.alloc(0), Buffer.from("not an image at all"),
                      Buffer.from("89504E47", "hex"), riffNotWebp]) {
    assert.equal(screenshotContentType(data), "image/png");
  }
});

test("a JPEG one byte short of its magic is not a JPEG", () => {
  assert.equal(screenshotContentType(Buffer.from("FFD8", "hex")), "image/png");
});

test("accepts a plain Uint8Array, not just a Buffer", () => {
  // Stores are pluggable: one backed by fetch() hands back a Uint8Array.
  assert.equal(screenshotContentType(new Uint8Array(JPEG)), "image/jpeg");
});
