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
      // Try progressively looser right-boundaries for different Malvern layouts
      let val = valueBetween(line, 'Hora de inicio', 'Estado');
      if (!val) val = valueBetween(line, 'Hora de inicio', 'ID de');
      if (!val) val = valueBetween(line, 'Hora de inicio', null);
      if (val !== null) meta.datetime = val;
    }

    // --- Comment ---
    if (line.includes('Comentario') && meta.comment === '') {
      const val = valueBetween(line, 'Comentario', null);
      if (val !== null) meta.comment = val;
    }

    // --- Obscuration ---
    if ((line.includes('Obscuración promedio') || line.includes('Obscuraci')) && isNaN(meta.obscuration)) {
      // Flexible: handles accent variants (ó/o) and different capitalisation
      const m = line.match(/Obscuraci[oó]n promedio\s+([\d]+(?:[.,][\d]+)?)\s*%/i);
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
// detectFormat
// ---------------------------------------------------------------------------
function detectFormat(lines) {
  for (const line of lines) {
    if (line.includes('CILAS') || line.includes('Valores acumulados característicos')) return 'cilas';
    if (line.includes('Anton Paar') || line.includes('PSA 1090')) return 'antonpaar';
    // English Malvern (v3.81 Analysis report) — must check before generic Malvern
    if (line.includes('Operator Name') || line.includes('Laser Obscuration') || line.includes('% Volume In')) return 'malvern_en';
    if (line.includes('Mastersizer') || line.includes('Tamaño inferior') ||
        line.includes('Distribución de tamaño de partícula por volumen')) return 'malvern';
  }
  for (const line of lines) {
    if (/^x\s+[\d.,]/.test(line.trim()) || /^Q3\s+[\d.,]/.test(line.trim())) return 'cilas';
  }
  return 'malvern';
}

// ---------------------------------------------------------------------------
// extractAntonPaarMetadata
// ---------------------------------------------------------------------------
function extractAntonPaarMetadata(lines) {
  const meta = { measurementName: '', user: '', datetime: '', comment: '', obscuration: NaN };

  function valueBetween(text, labelA, labelB) {
    const idxA = text.indexOf(labelA);
    if (idxA === -1) return null;
    const start = idxA + labelA.length;
    const idxB = labelB ? text.indexOf(labelB, start) : -1;
    const raw = (idxB === -1 ? text.slice(start) : text.slice(start, idxB)).trim();
    return raw === '-' || raw === '' ? '' : raw;
  }

  for (const line of lines) {
    if (line.includes('Nombre de la medición') && meta.measurementName === '') {
      // In Anton Paar layout, 'Usuario' is on the same visual line (right column)
      const val = valueBetween(line, 'Nombre de la medición', 'Usuario');
      if (val !== null) meta.measurementName = val;
    }
    if (line.includes('Usuario') && meta.user === '') {
      const val = valueBetween(line, 'Usuario', 'Hora de inicio');
      if (val !== null) meta.user = val;
    }
    if (line.includes('Hora de inicio') && meta.datetime === '') {
      const val = valueBetween(line, 'Hora de inicio', null);
      if (val !== null) meta.datetime = val;
    }
    if (line.includes('Comentario') && meta.comment === '') {
      const val = valueBetween(line, 'Comentario', null);
      if (val !== null) meta.comment = val;
    }
  }

  return meta;
}

// ---------------------------------------------------------------------------
// extractAntonPaarTableData
// ---------------------------------------------------------------------------
function extractAntonPaarTableData(lines) {
  const xVals = [], q3Vals = [], Q3Vals = [];
  let inTable = false;

  for (const line of lines) {
    if (line.includes('Distribución - Volumen Tamaño inferior')) { inTable = true; continue; }
    if (!inTable) continue;
    const t = line.trim();
    // Skip column headers and footers — data rows start with a digit and contain no letters
    if (!/^[\d.]/.test(t) || /[a-zA-Z]/.test(t)) continue;
    const nums = t.match(/[\d.]+/g)?.map(Number) ?? [];
    // Each group of 3 numbers: x, q3 (density), Q3 (cumulative)
    for (let i = 0; i + 2 < nums.length; i += 3) {
      if (!isNaN(nums[i]) && !isNaN(nums[i + 1]) && !isNaN(nums[i + 2])) {
        xVals.push(nums[i]);
        q3Vals.push(nums[i + 1]);
        Q3Vals.push(nums[i + 2]);
      }
    }
  }

  const Q3 = [], q3 = [];
  for (let i = 0; i < xVals.length; i++) {
    Q3.push({ x: xVals[i], y: Q3Vals[i] });
    q3.push({ x: xVals[i], y: q3Vals[i] });
  }
  const byX = (a, b) => a.x - b.x;
  Q3.sort(byX); q3.sort(byX);
  return { Q3, q3 };
}

// ---------------------------------------------------------------------------
// extractMalvernEnglishMetadata  (v3.81 Analysis report — English fields)
// ---------------------------------------------------------------------------
function extractMalvernEnglishMetadata(lines) {
  const meta = { measurementName:'', user:'', datetime:'', comment:'', obscuration:NaN };
  function vb(text, a, b) {
    const ia = text.indexOf(a); if (ia === -1) return null;
    const s = ia + a.length, ib = b ? text.indexOf(b, s) : -1;
    const raw = (ib === -1 ? text.slice(s) : text.slice(s, ib)).trim();
    return raw === '' ? null : raw;
  }
  for (const line of lines) {
    if (line.includes('Sample Name') && !meta.measurementName) {
      let v = vb(line, 'Sample Name', 'Measurement Date Time');
      if (!v) v = vb(line, 'Sample Name', 'SOP File Name');
      if (!v) v = vb(line, 'Sample Name', null);
      if (v) meta.measurementName = v;
    }
    if (line.includes('Operator Name') && !meta.user) {
      let v = vb(line, 'Operator Name', 'Analysis Date Time');
      if (!v) v = vb(line, 'Operator Name', null);
      if (v) meta.user = v;
    }
    if (!meta.datetime) {
      if (line.includes('Measurement Date Time')) { const v = vb(line, 'Measurement Date Time', null); if (v) meta.datetime = v; }
      else if (line.includes('Analysis Date Time')) { const v = vb(line, 'Analysis Date Time', null); if (v) meta.datetime = v; }
    }
    if (isNaN(meta.obscuration) && line.includes('Laser Obscuration')) {
      const mx = line.match(/Laser Obscuration\s+([\d.]+)\s*%/i);
      if (mx) meta.obscuration = parseFloat(mx[1]);
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// extractMalvernEnglishTableData  (% Volume In → q3; Q3 from authoritative anchors)
// ---------------------------------------------------------------------------
function extractMalvernEnglishTableData(lines) {
  const q3pts = [];
  let d10 = null, d50 = null, d90 = null, vBelow3 = null, vRange3_30 = null;
  let inTable = false;

  for (const line of lines) {
    let mx;
    if ((mx = line.match(/Dv\s*\(10\)\s+([\d.]+)\s*[µμ]m/i))) d10 = parseFloat(mx[1]);
    if ((mx = line.match(/Dv\s*\(50\)\s+([\d.]+)\s*[µμ]m/i))) d50 = parseFloat(mx[1]);
    if ((mx = line.match(/Dv\s*\(90\)\s+([\d.]+)\s*[µμ]m/i))) d90 = parseFloat(mx[1]);
    if ((mx = line.match(/Volume Below \(3\)\s*[µμ]m\s+([\d.]+)\s*%/i))) vBelow3 = parseFloat(mx[1]);
    if ((mx = line.match(/Volume In Range \(3[, ]*30\)\s*[µμ]m\s+([\d.]+)\s*%/i))) vRange3_30 = parseFloat(mx[1]);

    if (line.includes('% Volume In')) { inTable = true; continue; }
    if (!inTable) continue;
    if (q3pts.length > 2 && /[a-zA-Z]/.test(line)) break;
    const nums = line.match(/\d+(?:\.\d+)?/g)?.map(Number);
    if (!nums || nums.length < 2) continue;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i], y = nums[i + 1];
      if (x > 0 && x < 2000 && y >= 0 && y < 100) q3pts.push({ x, y });
    }
  }
  q3pts.sort((a, b) => a.x - b.x);

  // Build Q3 via piecewise rescaling between authoritative anchors
  const anchors = [];
  if (d10)  anchors.push({ x: d10 * 0.05, y: 0 }); else anchors.push({ x: 0.05, y: 0 });
  if (d10)  anchors.push({ x: d10, y: 10 });
  if (vBelow3 !== null) anchors.push({ x: 3.0, y: vBelow3 });
  if (d50)  anchors.push({ x: d50, y: 50 });
  if (vBelow3 !== null && vRange3_30 !== null) anchors.push({ x: 30.0, y: vBelow3 + vRange3_30 });
  if (d90)  anchors.push({ x: d90, y: 90 });
  anchors.push({ x: d90 ? d90 * 5 : 1000, y: 100 });

  const Q3 = anchors.map(a => ({ ...a }));

  for (let ai = 0; ai < anchors.length - 1; ai++) {
    const { x: x1, y: y1 } = anchors[ai], { x: x2, y: y2 } = anchors[ai + 1];
    const binsHere = q3pts.filter(p => p.x > x1 && p.x < x2);
    if (!binsHere.length) continue;
    let cum = 0;
    const cumBins = binsHere.map(p => { cum += p.y; return { x: p.x, c: cum }; });
    const total = cum; if (total <= 0) continue;
    const dY = y2 - y1;
    for (const { x, c } of cumBins) Q3.push({ x, y: y1 + c / total * dY });
  }

  Q3.sort((a, b) => a.x - b.x);
  const Q3f = Q3.filter((p, i) => i === 0 || Math.abs(p.x - Q3[i - 1].x) > 0.001);
  return { Q3: Q3f, q3: q3pts };
}

// ---------------------------------------------------------------------------
// extractCilasMetadata
// ---------------------------------------------------------------------------
function extractCilasMetadata(lines) {
  const meta = { measurementName:'', user:'', datetime:'', comment:'', obscuration:NaN };
  for (const line of lines) {
    if (!meta.measurementName && line.includes('Ref. de la muestra')) {
      const m = line.match(/Ref\.\s*de la muestra\s*:\s*(.+?)(?:\s{3,}|$)/);
      if (m) meta.measurementName = m[1].trim();
    }
    if (!meta.user && line.includes('Operador')) {
      const m = line.match(/Operador\s*:\s*(.+?)(?:\s{3,}|$)/);
      if (m) meta.user = m[1].trim();
    }
    if (!meta.datetime && line.includes('Fecha') && line.includes('Hora')) {
      const fecha = line.match(/Fecha\s*:\s*([\d\/]+)/);
      const hora  = line.match(/Hora\s*:\s*([\d:]+(?:\s*[AP]M)?)/i);
      if (fecha) meta.datetime = fecha[1] + (hora ? ' ' + hora[1].trim() : '');
    }
    if (!meta.comment && line.includes('Comentarios')) {
      const m = line.match(/Comentarios\s*:\s*(.+?)(?:\s{3,}|$)/);
      if (m) meta.comment = m[1].trim();
    }
    if (isNaN(meta.obscuration) && /Obscuration\s*:/i.test(line)) {
      const m = line.match(/Obscuration\s*:\s*([\d.]+)\s*%/i);
      if (m) meta.obscuration = parseFloat(m[1]);
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// extractCilasTableData  (handles row-based and triplet-based sub-formats)
// ---------------------------------------------------------------------------
function extractCilasTableData(lines) {
  const xVals = [], Q3Vals = [], q3Vals = [];
  let inTable = false, headerSeen = false;

  for (const line of lines) {
    if (line.includes('Valores acumulados característicos')) { inTable = true; continue; }
    if (!inTable) continue;
    const t = line.trim();

    // Sub-format B: rows starting with label "x", "Q3", "q3"
    if (/^x\s+[\d.,]/.test(t)) {
      t.slice(1).trim().match(/[\d.,]+/g)?.forEach(n => xVals.push(parseFloat(n.replace(',','.'))));
      continue;
    }
    if (/^Q3\s+[\d.,]/.test(t)) {
      t.slice(2).trim().match(/[\d.,]+/g)?.forEach(n => Q3Vals.push(parseFloat(n.replace(',','.'))));
      continue;
    }
    if (/^q3\s+[\d.,]/.test(t)) {
      t.slice(2).trim().match(/[\d.,]+/g)?.forEach(n => q3Vals.push(parseFloat(n.replace(',','.'))));
      continue;
    }
    // DQ3 = frecuencia relativa en CILAS 1064 (equivalente a q3)
    if (/^DQ3\s+[\d.,]/.test(t)) {
      t.slice(3).trim().match(/[\d.,]+/g)?.forEach(n => q3Vals.push(parseFloat(n.replace(',','.'))));
      continue;
    }
    // Sub-format A: header "x Q3 q3" or "x Q3 DQ3" then one triplet per row
    if (/^x\s+Q3\s+(?:q3|DQ3)/.test(t)) { headerSeen = true; continue; }
    if (headerSeen && /^[\d.,]/.test(t)) {
      const nums = t.match(/[\d.,]+/g);
      if (nums && nums.length >= 2) {
        xVals.push(parseFloat(nums[0].replace(',','.')));
        Q3Vals.push(parseFloat(nums[1].replace(',','.')));
        if (nums[2]) q3Vals.push(parseFloat(nums[2].replace(',','.')));
      }
    }
  }

  const Q3 = [], q3 = [];
  const n = Math.min(xVals.length, Q3Vals.length);
  for (let i = 0; i < n; i++) {
    if (!isNaN(xVals[i]) && !isNaN(Q3Vals[i])) Q3.push({ x: xVals[i], y: Q3Vals[i] });
    if (i < q3Vals.length && !isNaN(xVals[i]) && !isNaN(q3Vals[i])) q3.push({ x: xVals[i], y: q3Vals[i] });
  }
  const byX = (a, b) => a.x - b.x;
  Q3.sort(byX); q3.sort(byX);
  return { Q3, q3 };
}

// ---------------------------------------------------------------------------
// parsePDF  (main entry point — supports Malvern Mastersizer and CILAS 990)
// ---------------------------------------------------------------------------
async function parsePDF(file) {
  if (!file || !(file instanceof File)) {
    throw new TypeError('parsePDF: argument must be a File object.');
  }
  if (typeof pdfjsLib === 'undefined') {
    throw new ReferenceError('parsePDF: pdfjsLib is not defined. Make sure the PDF.js library is loaded.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const allItems = [];
  let cumulativeHeight = 0;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    for (const item of textContent.items) {
      const absoluteY = cumulativeHeight + (viewport.height - item.transform[5]);
      if (item.str && item.str.trim() !== '') {
        allItems.push({ str: item.str, x: item.transform[4], y: absoluteY });
      }
    }
    cumulativeHeight += viewport.height;
  }

  const lines = groupIntoLines(allItems);

  // Split into per-measurement segments (multi-measurement PDFs)
  const TITLE = 'DISTRIBUCION DEL TAMAÑO DE PARTICULAS';
  const segments = [];
  let current = [];
  for (const line of lines) {
    if (line.includes(TITLE) && current.length > 0) { segments.push(current); current = []; }
    current.push(line);
  }
  if (current.length > 0) segments.push(current);

  const results = [];
  for (const seg of segments) {
    const fmt = detectFormat(seg);
    // Skip CILAS simplified-table pages (only "Valores acumulados definidos por el usuario")
    if (fmt === 'cilas' && !seg.some(l => l.includes('Valores acumulados característicos'))) continue;
    const meta = fmt === 'cilas'       ? extractCilasMetadata(seg)
               : fmt === 'antonpaar'  ? extractAntonPaarMetadata(seg)
               : fmt === 'malvern_en' ? extractMalvernEnglishMetadata(seg)
               : extractMetadata(seg);
    const { Q3, q3 } = fmt === 'cilas'       ? extractCilasTableData(seg)
                     : fmt === 'antonpaar'  ? extractAntonPaarTableData(seg)
                     : fmt === 'malvern_en' ? extractMalvernEnglishTableData(seg)
                     : extractTableData(seg);
    if (Q3.length === 0 && q3.length === 0) continue;
    results.push({
      measurementName: meta.measurementName,
      user: meta.user,
      datetime: meta.datetime,
      comment: meta.comment,
      obscuration: meta.obscuration,
      filename: file.name,
      _format: fmt,
      Q3,
      q3,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePDF, detectFormat, groupIntoLines,
    extractMetadata, extractCilasMetadata, extractAntonPaarMetadata, extractMalvernEnglishMetadata,
    extractTableData, extractCilasTableData, extractAntonPaarTableData, extractMalvernEnglishTableData, extractPairs };
} else if (typeof window !== 'undefined') {
  window.granulometryParser = { parsePDF, detectFormat, groupIntoLines,
    extractMetadata, extractCilasMetadata, extractAntonPaarMetadata, extractMalvernEnglishMetadata,
    extractTableData, extractCilasTableData, extractAntonPaarTableData, extractMalvernEnglishTableData, extractPairs };
}


