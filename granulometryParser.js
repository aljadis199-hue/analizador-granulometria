'use strict';

// ---------------------------------------------------------------------------
// Malvern Mastersizer granulometry PDF parser
// Requires pdfjsLib to be available globally with the worker already configured.
// ---------------------------------------------------------------------------

/**
 * Regex that matches one diameter–value pair such as:
 *   "0.100 µm 0.00 %"  or  "292 µm 86.9 %"
 * The µ character may be U+00B5 (µ) or U+03BC (μ).
 */
const PAIR_RE = /([\d]+(?:[.,][\d]+)?)\s*[µμ]m\s+([\d]+(?:[.,][\d]+)?)\s*%/g;

// ---------------------------------------------------------------------------
// extractPairs
// ---------------------------------------------------------------------------

/**
 * Extract all (diameter, value) pairs from a single text line.
 *
 * @param {string} lineText
 * @returns {{x: number, y: number}[]}  x = diameter µm, y = cumulative/density %
 */
function extractPairs(lineText) {
  const pairs = [];
  // Reset lastIndex in case the regex is reused (it is module-level with /g).
  PAIR_RE.lastIndex = 0;
  let match;
  while ((match = PAIR_RE.exec(lineText)) !== null) {
    const x = parseFloat(match[1].replace(',', '.'));
    const y = parseFloat(match[2].replace(',', '.'));
    if (!isNaN(x) && !isNaN(y)) {
      pairs.push({ x, y });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// groupIntoLines
// ---------------------------------------------------------------------------

/**
 * Group PDF.js text content items (from all pages) into sorted line strings.
 *
 * Strategy:
 *  - Each item carries an absolute Y coordinate (pageOffset + item.y).
 *  - Items whose absolute Y values are within `Y_TOLERANCE` px are considered
 *    to be on the same line.
 *  - Within a line, items are sorted by X coordinate so the resulting text
 *    reads left-to-right.
 *  - Lines are sorted top-to-bottom (ascending absolute Y).
 *
 * @param {{str: string, x: number, y: number}[]} items
 *   Flat array of text items with absolute coordinates already applied.
 * @param {number[]} _pageHeights  (reserved – kept in signature for API compatibility)
 * @returns {string[]}  One string per visual line, items joined by a single space.
 */
function groupIntoLines(items, _pageHeights) {
  const Y_TOLERANCE = 6; // pixels

  if (!items || items.length === 0) return [];

  // Sort all items by absolute Y (top-to-bottom), then X (left-to-right).
  const sorted = [...items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  const groups = []; // [{y: number, items: [...]}]

  for (const item of sorted) {
    if (item.str.trim() === '') continue;

    // Find an existing group whose representative Y is within tolerance.
    let placed = false;
    for (const group of groups) {
      if (Math.abs(group.y - item.y) <= Y_TOLERANCE) {
        group.items.push(item);
        // Update representative Y to the average so drift is handled gradually.
        group.y = group.items.reduce((sum, i) => sum + i.y, 0) / group.items.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ y: item.y, items: [item] });
    }
  }

  // Sort groups top-to-bottom and produce one string per group.
  groups.sort((a, b) => a.y - b.y);

  return groups.map(group => {
    // Sort items within the line by X.
    group.items.sort((a, b) => a.x - b.x);
    return group.items.map(i => i.str.trim()).filter(Boolean).join(' ');
  }).filter(line => line.length > 0);
}

// ---------------------------------------------------------------------------
// extractMetadata
// ---------------------------------------------------------------------------

/**
 * Parse measurement metadata from the array of line strings.
 *
 * The PDF renders metadata as label–value pairs on the same visual line,
 * sometimes two pairs per line, e.g.:
 *   "Nombre de la medición Harina Molinos de CR 1 Nombre del método -"
 *   "Usuario Chacon Pabon, Angi Tatiana Hora de inicio 10/16/2025 9:40:24 AM"
 *   "Lote Nr. - Comentario KFC 26.09.2025"
 *   "Obscuración promedio 14.61 %"
 *
 * @param {string[]} lines
 * @returns {{measurementName: string, user: string, datetime: string, comment: string, obscuration: number}}
 */
function extractMetadata(lines) {
  const meta = {
    measurementName: '',
    user: '',
    datetime: '',
    comment: '',
    obscuration: NaN,
  };

  // Helper: find the value that appears between labelA and labelB (or end of string).
  function valueBetween(text, labelA, labelB) {
    const idxA = text.indexOf(labelA);
    if (idxA === -1) return null;
    const start = idxA + labelA.length;
    const idxB = labelB ? text.indexOf(labelB, start) : -1;
    const raw = (idxB === -1 ? text.slice(start) : text.slice(start, idxB)).trim();
    return raw === '-' || raw === '' ? '' : raw;
  }

  for (const line of lines) {
    // --- Measurement name ---
    if (line.includes('Nombre de la medición') && meta.measurementName === '') {
      const val = valueBetween(line, 'Nombre de la medición', 'Nombre del método');
      if (val !== null) meta.measurementName = val;
    }

    // --- User + datetime (often on same line) ---
    if (line.includes('Usuario') && meta.user === '') {
      const val = valueBetween(line, 'Usuario', 'Hora de inicio');
      if (val !== null) meta.user = val;
    }
    if (line.includes('Hora de inicio') && meta.datetime === '') {
      const val = valueBetween(line, 'Hora de inicio', null);
      if (val !== null) meta.datetime = val;
    }

    // --- Comment ---
    if (line.includes('Comentario') && meta.comment === '') {
      const val = valueBetween(line, 'Comentario', null);
      if (val !== null) meta.comment = val;
    }

    // --- Obscuration ---
    if (line.includes('Obscuración promedio') && isNaN(meta.obscuration)) {
      // e.g. "Obscuración promedio 14.61 %"
      const m = line.match(/Obscuración promedio\s+([\d]+(?:[.,][\d]+)?)\s*%/);
      if (m) meta.obscuration = parseFloat(m[1].replace(',', '.'));
    }
  }

  return meta;
}

// ---------------------------------------------------------------------------
// extractTableData
// ---------------------------------------------------------------------------

/**
 * State-machine parser that extracts Q3 (cumulative) and q3 (density) data.
 *
 * States:
 *   INIT      → waiting for Q3 table header
 *   Q3_DATA   → collecting Q3 pairs
 *   Q3_DATA2  → collecting q3 pairs
 *
 * Transitions:
 *   INIT     → Q3_DATA   : line contains "Tamaño inferior" AND "Diámetro"
 *   Q3_DATA  → Q3_DATA2  : line contains "Distribución"  AND "Diámetro"
 *
 * Non-data lines (footers, section titles without pairs) are skipped silently.
 *
 * @param {string[]} lines
 * @returns {{Q3: {x: number, y: number}[], q3: {x: number, y: number}[]}}
 */
function extractTableData(lines) {
  const Q3 = [];
  const q3 = [];

  const STATE = { INIT: 0, Q3_DATA: 1, Q3_DATA2: 2 };
  let state = STATE.INIT;

  for (const line of lines) {
    switch (state) {
      case STATE.INIT:
        if (line.includes('Tamaño inferior') && line.includes('Diámetro')) {
          state = STATE.Q3_DATA;
        }
        break;

      case STATE.Q3_DATA:
        // Transition to q3 table when its header appears.
        if (line.includes('Distribución') && line.includes('Diámetro')) {
          state = STATE.Q3_DATA2;
          break;
        }
        // Skip repeated Q3 header lines.
        if (line.includes('Tamaño inferior')) break;
        {
          const pairs = extractPairs(line);
          for (const p of pairs) Q3.push(p);
        }
        break;

      case STATE.Q3_DATA2:
        // Skip repeated q3 header lines.
        if (line.includes('Distribución') && line.includes('Diámetro')) break;
        {
          const pairs = extractPairs(line);
          for (const p of pairs) q3.push(p);
        }
        break;
    }
  }

  // Sort both arrays by diameter ascending.
  const byX = (a, b) => a.x - b.x;
  Q3.sort(byX);
  q3.sort(byX);

  return { Q3, q3 };
}

// ---------------------------------------------------------------------------
// parsePDF  (main entry point)
// ---------------------------------------------------------------------------

/**
 * Parse a Malvern Mastersizer granulometry PDF report.
 *
 * @param {File} file  A browser File object (from <input type="file"> etc.)
 * @returns {Promise<{
 *   measurementName: string,
 *   user: string,
 *   datetime: string,
 *   comment: string,
 *   obscuration: number,
 *   filename: string,
 *   Q3: {x: number, y: number}[],
 *   q3: {x: number, y: number}[],
 * }>}
 */
async function parsePDF(file) {
  if (!file || !(file instanceof File)) {
    throw new TypeError('parsePDF: argument must be a File object.');
  }
  if (typeof pdfjsLib === 'undefined') {
    throw new ReferenceError('parsePDF: pdfjsLib is not defined. Make sure the PDF.js library is loaded.');
  }

  // ---- Load the PDF --------------------------------------------------------
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;

  // ---- Extract text items from every page ----------------------------------
  const allItems = []; // {str, x, y} with absolute Y coords across pages
  const pageHeights = [];
  let cumulativeHeight = 0;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    pageHeights.push(pageHeight);

    const textContent = await page.getTextContent();

    for (const item of textContent.items) {
      // item.transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
      // translateX is the X position; translateY is the Y measured from the
      // bottom of the page (PDF coordinate system).
      // We convert to top-down by: absoluteY = cumulativeHeight + (pageHeight - translateY)
      const tx = item.transform[4]; // X
      const ty = item.transform[5]; // Y from page bottom
      const absoluteY = cumulativeHeight + (pageHeight - ty);

      if (item.str && item.str.trim() !== '') {
        allItems.push({ str: item.str, x: tx, y: absoluteY });
      }
    }

    cumulativeHeight += pageHeight;
  }

  // ---- Group items into visual lines ---------------------------------------
  const lines = groupIntoLines(allItems, pageHeights);

  // ---- Parse metadata and table data ---------------------------------------
  const meta = extractMetadata(lines);
  const { Q3, q3 } = extractTableData(lines);

  return {
    measurementName: meta.measurementName,
    user: meta.user,
    datetime: meta.datetime,
    comment: meta.comment,
    obscuration: meta.obscuration,
    filename: file.name,
    Q3,
    q3,
  };
}

// ---------------------------------------------------------------------------
// Exports (works in both ES-module and CommonJS / browser-global contexts)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePDF, groupIntoLines, extractMetadata, extractTableData, extractPairs };
} else if (typeof window !== 'undefined') {
  window.granulometryParser = { parsePDF, groupIntoLines, extractMetadata, extractTableData, extractPairs };
}
