import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Deterministic PRNG (Park-Miller LCG)
class SeededRandom {
  private seed: number;
  constructor(seed: number = 42) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }
  next(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

// CRC32 implementation
const crcTable = (() => {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(width: number, height: number, rgbaPixels: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = createChunk('IHDR', ihdr);

  const scanlineSize = width * 4 + 1;
  const rawData = Buffer.alloc(height * scanlineSize);
  for (let y = 0; y < height; y++) {
    const offset = y * scanlineSize;
    rawData[offset] = 0; // filter 0
    rgbaPixels.copy(rawData, offset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = deflateSync(rawData, { level: 6 });
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Art generation
function renderArt(): Buffer {
  const width = 1024;
  const height = 1024;
  const pixels = Buffer.alloc(width * height * 4);
  const rng = new SeededRandom(1337);

  // Pre-generate stars
  const stars: { x: number; y: number; r: number; brightness: number; colorType: number }[] = [];
  for (let i = 0; i < 400; i++) {
    stars.push({
      x: rng.range(0, width),
      y: rng.range(0, height),
      r: rng.range(0.5, 2.2),
      brightness: rng.range(0.3, 1.0),
      colorType: rng.int(0, 3)
    });
  }

  // Pre-generate nebula clouds (centers)
  const nebulas = [
    { x: 512, y: 450, r: 400, rColor: 120, gColor: 40, bColor: 180, alpha: 0.15 },
    { x: 350, y: 350, r: 300, rColor: 30, gColor: 120, bColor: 220, alpha: 0.12 },
    { x: 674, y: 600, r: 350, rColor: 240, gColor: 90, bColor: 40, alpha: 0.12 },
    { x: 512, y: 512, r: 250, rColor: 255, gColor: 200, bColor: 80, alpha: 0.2 }
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // 1. Deep cosmic gradient background
      const nx = x / width;
      const ny = y / height;
      
      // Base space color (deep void navy / indigo / dark violet)
      let r = 8 + 15 * ny + 10 * Math.sin(nx * Math.PI);
      let g = 4 + 8 * ny + 5 * Math.cos(ny * Math.PI);
      let b = 18 + 30 * ny + 20 * (1 - nx);

      // 2. Nebula blending
      for (const neb of nebulas) {
        const dx = x - neb.x;
        const dy = y - neb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < neb.r) {
          const factor = Math.pow(1 - dist / neb.r, 2) * neb.alpha;
          r += neb.rColor * factor;
          g += neb.gColor * factor;
          b += neb.bColor * factor;
        }
      }

      // 3. Central Celestial Sun / Phoenix Core
      const cx = 512;
      const cy = 440;
      const dSun = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      
      if (dSun < 280) {
        const t = dSun / 280;
        // Radial gradient for sun corona & core
        const sunFactor = Math.pow(1 - t, 1.8);
        const coreGlow = Math.max(0, 1 - dSun / 60);
        
        r += (255 * sunFactor + 255 * coreGlow);
        g += (180 * sunFactor + 220 * coreGlow);
        b += (60 * sunFactor + 120 * coreGlow);
      }

      // 3.5 Celestial Orbital Rings (elliptical glowing arcs around the sun)
      const ringDx = x - cx;
      const ringDy = (y - cy) * 2.8; // tilt ellipse
      const ringDist = Math.sqrt(ringDx * ringDx + ringDy * ringDy);
      if (ringDist > 190 && ringDist < 210) {
        const ringIntensity = (1 - Math.abs(ringDist - 200) / 10) * 0.7;
        r += 100 * ringIntensity;
        g += 200 * ringIntensity;
        b += 255 * ringIntensity;
      }
      if (ringDist > 250 && ringDist < 268) {
        const ringIntensity = (1 - Math.abs(ringDist - 259) / 9) * 0.5;
        r += 255 * ringIntensity;
        g += 150 * ringIntensity;
        b += 50 * ringIntensity;
      }

      // 4. Phoenix Wings (parametric radiant arcs sweeping upwards and outwards)
      // Left wing and right wing symmetrical curves
      const relX = x - cx;
      const relY = y - cy;
      
      // Wing shape equation check
      const wingDistLeft = Math.abs(relX + Math.sin(relY * 0.01 + 1.5) * 120);
      const wingDistRight = Math.abs(relX - Math.sin(relY * 0.01 + 1.5) * 120);
      
      if (relY > -180 && relY < 220) {
        const heightFade = 1 - (relY + 180) / 400;
        // Left wing feather span
        if (relX < 0 && relX > -320) {
          const spanT = Math.abs(relX) / 320;
          const curveYOffset = Math.sin(spanT * Math.PI * 2.5 + relY * 0.02) * 30;
          const distToWingCurve = Math.abs(relY - (-80 - spanT * 120 + curveYOffset));
          if (distToWingCurve < 22) {
            const featherInten = (1 - distToWingCurve / 22) * heightFade * 0.8;
            r += 255 * featherInten;
            g += 140 * featherInten;
            b += 30 * featherInten;
          }
        }
        // Right wing feather span
        if (relX > 0 && relX < 320) {
          const spanT = relX / 320;
          const curveYOffset = Math.sin(spanT * Math.PI * 2.5 + relY * 0.02) * 30;
          const distToWingCurve = Math.abs(relY - (-80 - spanT * 120 + curveYOffset));
          if (distToWingCurve < 22) {
            const featherInten = (1 - distToWingCurve / 22) * heightFade * 0.8;
            r += 255 * featherInten;
            g += 140 * featherInten;
            b += 30 * featherInten;
          }
        }
      }

      // 5. Ground horizon / glowing reflection at bottom
      if (y > 850) {
        const groundT = (y - 850) / 174;
        r += 120 * groundT * (1 - Math.abs(x - 512) / 512);
        g += 50 * groundT;
        b += 160 * groundT;
      }

      // Clamp RGB
      pixels[idx] = Math.min(255, Math.max(0, Math.floor(r)));
      pixels[idx + 1] = Math.min(255, Math.max(0, Math.floor(g)));
      pixels[idx + 2] = Math.min(255, Math.max(0, Math.floor(b)));
      pixels[idx + 3] = 255; // Alpha
    }
  }

  // Draw Stars over pixels
  for (const s of stars) {
    const sx = Math.floor(s.x);
    const sy = Math.floor(s.y);
    if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
      const idx = (sy * width + sx) * 4;
      const bInt = s.brightness * 255;
      pixels[idx] = Math.min(255, pixels[idx] + bInt);
      pixels[idx + 1] = Math.min(255, pixels[idx + 1] + bInt);
      pixels[idx + 2] = Math.min(255, pixels[idx + 2] + bInt);

      // Add cross spike for bright stars
      if (s.r > 1.8) {
        for (let d = -2; d <= 2; d++) {
          if (d === 0) continue;
          if (sx + d >= 0 && sx + d < width) {
            const hIdx = (sy * width + (sx + d)) * 4;
            pixels[hIdx] = Math.min(255, pixels[hIdx] + bInt * 0.4);
            pixels[hIdx + 1] = Math.min(255, pixels[hIdx + 1] + bInt * 0.4);
            pixels[hIdx + 2] = Math.min(255, pixels[hIdx + 2] + bInt * 0.4);
          }
          if (sy + d >= 0 && sy + d < height) {
            const vIdx = ((sy + d) * width + sx) * 4;
            pixels[vIdx] = Math.min(255, pixels[vIdx] + bInt * 0.4);
            pixels[vIdx + 1] = Math.min(255, pixels[vIdx + 1] + bInt * 0.4);
            pixels[vIdx + 2] = Math.min(255, pixels[vIdx + 2] + bInt * 0.4);
          }
        }
      }
    }
  }

  // Draw Shooting Star / Comet Trail across upper left
  for (let t = 0; t < 150; t++) {
    const cx_comet = 150 + t * 3;
    const cy_comet = 100 + t * 1.5;
    const px = Math.floor(cx_comet);
    const py = Math.floor(cy_comet);
    if (px >= 0 && px < width && py >= 0 && py < height) {
      const idx = (py * width + px) * 4;
      const intensity = (1 - t / 150) * 255;
      pixels[idx] = Math.min(255, pixels[idx] + intensity);
      pixels[idx + 1] = Math.min(255, pixels[idx + 1] + intensity * 0.9);
      pixels[idx + 2] = Math.min(255, pixels[idx + 2] + intensity);
    }
  }

  return encodePNG(width, height, pixels);
}

// Execution
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outputDir, { recursive: true });
const pngBuffer = renderArt();
writeFileSync(join(outputDir, 'entry.png'), pngBuffer);
console.log(`Successfully generated entry.png (${pngBuffer.length} bytes) in ${outputDir}`);
