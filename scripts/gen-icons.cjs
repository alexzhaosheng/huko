const fs = require("fs");
const path = require("path");

// Generate minimal valid PNG files for extension icons
// A 1-pixel grey PNG, valid for Chrome extension icons
// PNG format: signature + IHDR + IDAT + IEND

function makePNG(r, g, b) {
  // Minimal PNG: 1x1 pixel, single color
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: width=1, height=1, bit=8, color=2 (RGB)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  const ihdr = makeChunk("IHDR", ihdrData);

  // IDAT: raw pixel (RGB) + zlib
  const raw = Buffer.from([r, g, b]);
  const zlib = require("zlib");
  const compressed = zlib.deflateSync(raw);
  const idat = makeChunk("IDAT", compressed);

  // IEND
  const iend = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return crc ^ 0xffffffff;
}

const dir = path.join(__dirname, "..", "extensions", "chrome");
const green = [0x9a, 0xff, 0xbc]; // huko accent color
for (const size of [16, 48, 128]) {
  const png = makePNG(...green);
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), png);
  console.log(`Generated icon-${size}.png (${png.length} bytes)`);
}
