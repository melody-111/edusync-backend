'use strict';

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * Compress stroke data using gzip
 * @param {Array} strokes
 * @returns {Buffer}
 */
const compressStrokes = async (strokes) => {
  const json = JSON.stringify(strokes);
  return gzip(Buffer.from(json, 'utf8'));
};

/**
 * Decompress stroke buffer
 * @param {Buffer} buffer
 * @returns {Array}
 */
const decompressStrokes = async (buffer) => {
  const decompressed = await gunzip(buffer);
  return JSON.parse(decompressed.toString('utf8'));
};

/**
 * Compress any JSON-serializable object
 */
const compressJSON = async (obj) => {
  const json = JSON.stringify(obj);
  return deflate(Buffer.from(json, 'utf8'));
};

/**
 * Decompress JSON buffer
 */
const decompressJSON = async (buffer) => {
  const decompressed = await inflate(buffer);
  return JSON.parse(decompressed.toString('utf8'));
};

/**
 * Simplify stroke array — remove redundant points using Douglas-Peucker algorithm
 * This reduces stroke count while preserving visual fidelity
 * @param {Array<{x,y}>} points
 * @param {number} epsilon - tolerance (default 1.5)
 */
const simplifyStrokes = (points, epsilon = 1.5) => {
  if (points.length <= 2) return points;

  const perpendicularDistance = (point, lineStart, lineEnd) => {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
    return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / mag;
  };

  let maxDist = 0;
  let maxIndex = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDist) { maxDist = dist; maxIndex = i; }
  }

  if (maxDist > epsilon) {
    const left = simplifyStrokes(points.slice(0, maxIndex + 1), epsilon);
    const right = simplifyStrokes(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[end]];
};

module.exports = { compressStrokes, decompressStrokes, compressJSON, decompressJSON, simplifyStrokes };
