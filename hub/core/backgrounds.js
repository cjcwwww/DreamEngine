const fs = require("node:fs");
const path = require("node:path");

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isPngFile(file) {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(8);
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return head.equals(PNG_SIGNATURE);
  } catch {
    return false;
  }
}

function uniquePngPath(targetDir, source) {
  const ext = path.extname(source);
  const base = path.basename(source, ext) || "background";
  let target = path.join(targetDir, `${base}.png`);
  if (samePath(target, source) || !fs.existsSync(target)) return target;
  let n = 1;
  do {
    target = path.join(targetDir, `${base}_${n}.png`);
    n++;
  } while (fs.existsSync(target));
  return target;
}

function importImageAsPng({ source, targetDir, nativeImage }) {
  try {
    const image = nativeImage.createFromPath(source);
    if (!image || image.isEmpty()) {
      return { ok: false, reason: "decode_failed", source };
    }
    const png = image.toPNG();
    if (!Buffer.isBuffer(png) || png.length === 0) {
      return { ok: false, reason: "encode_failed", source };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const target = uniquePngPath(targetDir, source);
    const temp = `${target}.converting-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, png);
    fs.renameSync(temp, target);
    return { ok: true, path: target, source };
  } catch (error) {
    return {
      ok: false,
      reason: "convert_failed",
      source,
      detail: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * Convert imported backgrounds to real PNG files by content, not extension.
 * Existing JPEG/WebP files with a misleading .png suffix are replaced in place.
 */
function normalizeBackgroundDirectory({ dir, nativeImage }) {
  const converted = [];
  const invalid = [];
  if (!fs.existsSync(dir)) {
    return { converted, invalid };
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !IMAGE_RE.test(entry.name)) continue;
    const source = path.join(dir, entry.name);
    if (entry.name.toLowerCase().endsWith(".png") && isPngFile(source)) continue;

    const result = importImageAsPng({ source, targetDir: dir, nativeImage });
    if (!result.ok) {
      invalid.push(source);
      continue;
    }
    converted.push(result.path);
    if (!samePath(result.path, source)) {
      try {
        fs.unlinkSync(source);
      } catch {
        // Conversion already succeeded. Keeping one stale source is safer than
        // deleting a newly written PNG when the source is temporarily locked.
      }
    }
  }
  return { converted, invalid };
}

module.exports = {
  IMAGE_RE,
  isPngFile,
  importImageAsPng,
  normalizeBackgroundDirectory,
};
