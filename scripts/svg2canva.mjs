// Rebuilds SVG slides as native, editable Canva elements on pages of the design open in the Canva
// editor, through canva-mcp's edit-page tool (the bridge app must be connected; see the README).
// Made for ppt-master's svg_output, but takes any SVG drawn with rect, circle, ellipse, line,
// polyline, polygon, path and text.
//
//   node scripts/svg2canva.mjs <svg folder or file> [mapping ...] [options]
//
// Slides are the folder's .svg files in name order. Mapping (default: every slide onto pages 1..n):
//   3        slide 3 onto page 3            3:7      slide 3 onto page 7
//   2-5      slides 2..5 onto pages 2..5    2-5:10   slides 2..5 onto pages 10..13
// The target pages must exist (add them in Canva first). Everything on them is replaced.
//
// Options:
//   --replace          allow clearing target pages that already have content (refused otherwise)
//   --check            only validate: dry-run every batch in Canva, change nothing
//   --dry              only convert, without Canva; prints what each slide becomes
//   --out <dir>        also save each slide's operations as JSON
//   --page-size WxH    page size for --dry (default 1920x1080; otherwise each page's size in Canva)
//   --font-scale <n>   text size factor (default 0.94: Canva's default font is ~7% wider than Segoe UI)
//   --ascent <n>       first baseline below the top of a Canva text box, in em (default 0.95)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absoluteSubpaths } from '../dist/canva/shape-path.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Canva limits (see PathOpts in @canva/design): shapes take 30 paths, 2 KB of path data, 6 fill colors.
const MAX_PATHS = 30;
const MAX_PATH_BYTES = 2048;
const BATCH = 100;
const GRADIENT_BANDS = 30;
const K = 0.5523; // cubic approximation of a quarter circle

// --- XML ------------------------------------------------------------------------------------------

const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );

function parseXml(src) {
  src = src.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) => t.replace(/</g, '&lt;')).replace(/<![^>]*>/g, '');
  const top = { tag: '#root', attrs: {}, children: [] };
  const stack = [top];
  const re = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of src.matchAll(re)) {
    if (m[5] !== undefined) {
      if (stack.length > 1) stack.at(-1).children.push({ text: decode(m[5]) });
    } else if (m[1]) {
      stack.pop();
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      // Inline style wins over presentation attributes.
      for (const decl of (attrs.style ?? '').split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) attrs[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
      }
      const node = { tag: m[2].replace(/^svg:/, ''), attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  const svg = top.children.find((c) => c.tag === 'svg');
  if (!svg) throw new Error('No <svg> element found.');
  return svg;
}

const elementsOf = (node) => (node.children ?? []).filter((c) => c.tag);

// --- Values ---------------------------------------------------------------------------------------

const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const f = (n) => String(r2(n));
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500', silver: '#c0c0c0' };
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (a) => `#${a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (fg, bg, a) => hexOf(rgbOf(fg).map((v, i) => v * a + rgbOf(bg)[i] * (1 - a)));

// --- Geometry -------------------------------------------------------------------------------------

// Shapes are drawn in the SVG's own coordinates, so these take the top-left corner (ox, oy).
function roundRectPath(w, h, r, ox, oy) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = K * r;
  const P = (x, y) => `${f(ox + x)} ${f(oy + y)}`;
  if (!r) return `M${P(0, 0)} L${P(w, 0)} L${P(w, h)} L${P(0, h)} Z`;
  return (
    `M${P(r, 0)} L${P(w - r, 0)} C${P(w - r + k, 0)} ${P(w, r - k)} ${P(w, r)} L${P(w, h - r)} ` +
    `C${P(w, h - r + k)} ${P(w - r + k, h)} ${P(w - r, h)} L${P(r, h)} C${P(r - k, h)} ${P(0, h - r + k)} ${P(0, h - r)} ` +
    `L${P(0, r)} C${P(0, r - k)} ${P(r - k, 0)} ${P(r, 0)} Z`
  );
}

function ellipsePath(rx, ry, ox, oy) {
  const kx = K * rx;
  const ky = K * ry;
  const P = (x, y) => `${f(ox + x)} ${f(oy + y)}`;
  return (
    `M${P(2 * rx, ry)} C${P(2 * rx, ry + ky)} ${P(rx + kx, 2 * ry)} ${P(rx, 2 * ry)} C${P(rx - kx, 2 * ry)} ${P(0, ry + ky)} ${P(0, ry)} ` +
    `C${P(0, ry - ky)} ${P(rx - kx, 0)} ${P(rx, 0)} C${P(rx + kx, 0)} ${P(2 * rx, ry - ky)} ${P(2 * rx, ry)} Z`
  );
}

/** Outline polygon of a stroked polyline: miter joins, ends extended by half the width. */
function strokeOutline(pts, w) {
  const h = w / 2;
  const unit = (dx, dy) => {
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const dirs = pts.slice(1).map((p, i) => unit(p[0] - pts[i][0], p[1] - pts[i][1]));
  const p = pts.map((q) => [...q]);
  p[0] = [p[0][0] - dirs[0][0] * h, p[0][1] - dirs[0][1] * h];
  const last = dirs.at(-1);
  p[p.length - 1] = [p.at(-1)[0] + last[0] * h, p.at(-1)[1] + last[1] * h];
  const left = [];
  const right = [];
  p.forEach((q, i) => {
    const n1 = [-dirs[Math.max(0, i - 1)][1], dirs[Math.max(0, i - 1)][0]];
    const n2 = [-dirs[Math.min(dirs.length - 1, i)][1], dirs[Math.min(dirs.length - 1, i)][0]];
    const n = unit(n1[0] + n2[0], n1[1] + n2[1]);
    const len = h / Math.max(n[0] * n1[0] + n[1] * n1[1], 0.25);
    left.push([q[0] + n[0] * len, q[1] + n[1] * len]);
    right.push([q[0] - n[0] * len, q[1] - n[1] * len]);
  });
  return [...left, ...right.reverse()];
}

const bboxOf = (pts) => {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const polygonPath = (pts) => `M${pts.map((q) => `${f(q[0])} ${f(q[1])}`).join(' L')} Z`;

/** The part of a convex polygon where `value(point) >= min` (Sutherland–Hodgman against one line). */
function clipPolygon(poly, value, min) {
  const out = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const fa = value(a) - min;
    const fb = value(b) - min;
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  });
  return out;
}

// --- Text -----------------------------------------------------------------------------------------

const WEIGHT = (w) => (w === undefined || w === 'normal' || (w !== 'bold' && w !== 'bolder' && num(w, 400) < 550) ? 'normal' : num(w, 700) < 650 ? 'semibold' : 'bold');

/** Rough width of a line of text in Segoe UI-like fonts, in the SVG's units. */
function textWidth(str, fs, bold, ls) {
  let w = 0;
  for (const ch of str) {
    if (ch === ' ') w += 0.28;
    else if (/[.,:;'|!ilíìịỉĩ()/]/.test(ch)) w += 0.3;
    else if (/[mwMW—–]/.test(ch)) w += 0.88;
    else if (/\d/.test(ch)) w += 0.56;
    else if (ch !== ch.toLowerCase()) w += 0.68;
    else w += 0.55;
  }
  return w * fs * (bold ? 1.07 : 1) + ls * [...str].length;
}

// --- Conversion -----------------------------------------------------------------------------------

const INHERITED = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing'];
const SKIPPED = new Set(['defs', 'title', 'desc', 'metadata', 'style', 'script', 'clipPath', 'mask', 'filter', 'pattern', 'marker', 'symbol', 'linearGradient', 'radialGradient']);

/**
 * Converts one SVG into edit-page operations for a page of the given size (the SVG is scaled to fit
 * and centered). Returns the operations in drawing order, the text formatting that has to be applied
 * after insertion (`formats`, addressed by insertion index among the non-background operations),
 * and warnings about what couldn't be reproduced.
 */
export function convertSvg(source, { pageWidth = 1920, pageHeight = 1080, fontScale = 0.94, ascent = 0.95 } = {}) {
  const svg = parseXml(source);
  const warnings = new Set();
  const warn = (msg) => warnings.add(msg);

  const vb = (svg.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, num(svg.attrs.width, pageWidth), num(svg.attrs.height, pageHeight)];
  const S = Math.min(pageWidth / vw, pageHeight / vh);
  const ox = (pageWidth - vw * S) / 2 - vx * S;
  const oy = (pageHeight - vh * S) / 2 - vy * S;
  if (Math.abs(vw / vh - pageWidth / pageHeight) > 0.01) warn(`The SVG (${vw}x${vh}) and the page (${pageWidth}x${pageHeight}) differ in shape; the slide is scaled to fit and centered.`);

  const colorOf = (v) => {
    if (v === undefined || v === 'none' || v === 'transparent') return undefined;
    const s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`;
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) return hexOf([m[1], m[2], m[3]].map(Number));
    if (NAMED[s]) return NAMED[s];
    warn(`Unknown color "${v}" was drawn black.`);
    return '#000000';
  };

  // Gradients, anywhere in the document, by id.
  const gradients = new Map();
  const collect = (n) => {
    for (const c of elementsOf(n)) {
      if (c.tag === 'linearGradient' || c.tag === 'radialGradient') {
        const stops = elementsOf(c)
          .filter((s) => s.tag === 'stop')
          .map((s) => ({ offset: clamp01(String(s.attrs.offset ?? '0').endsWith('%') ? num(s.attrs.offset) / 100 : num(s.attrs.offset)), color: colorOf(s.attrs['stop-color'] ?? '#000000') ?? '#000000' }));
        gradients.set(c.attrs.id, { tag: c.tag, attrs: c.attrs, stops, href: (c.attrs.href ?? c.attrs['xlink:href'])?.replace(/^#/, '') });
      }
      collect(c);
    }
  };
  collect(svg);
  for (const g of gradients.values()) if (!g.stops.length && g.href && gradients.get(g.href)) g.stops = gradients.get(g.href).stops;
  const gradientColor = (g, t) => {
    const stops = g.stops.length ? g.stops : [{ offset: 0, color: '#000000' }];
    t = clamp01(t);
    if (t <= stops[0].offset) return stops[0].color;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (t <= b.offset) return mix(b.color, a.color, (t - a.offset) / (b.offset - a.offset || 1));
    }
    return stops.at(-1).color;
  };
  const gradientOf = (v) => {
    const id = v?.match(/^url\(\s*#([^)\s]+)\s*\)/)?.[1];
    return id ? gradients.get(id) : undefined;
  };
  /** A fill or stroke as one color; gradients outside rectangles become their middle color. */
  const paintOf = (v) => {
    if (!v?.startsWith('url(')) return colorOf(v);
    const g = gradientOf(v);
    if (!g) {
      warn(`The paint ${v} doesn't exist and was left out.`);
      return undefined;
    }
    warn('Gradients on shapes other than rectangles are drawn in their middle color.');
    return gradientColor(g, 0.5);
  };
  /** Position along a linear gradient (0 at its start, 1 at its end) of a point, for a shape's box. */
  const gradientT = (g, box) => {
    const a = g.attrs;
    const user = a.gradientUnits === 'userSpaceOnUse';
    const coord = (v, d, size) => (String(v ?? d).endsWith('%') ? (num(v) / 100) * size : num(v, d));
    const [x1, y1, x2, y2] = user ? [coord(a.x1, 0, vw), coord(a.y1, 0, vh), coord(a.x2, vw, vw), coord(a.y2, 0, vh)] : [coord(a.x1, 0, 1), coord(a.y1, 0, 1), coord(a.x2, 1, 1), coord(a.y2, 0, 1)];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    return ([px, py]) => {
      const [u, v] = user ? [px, py] : [(px - box.x) / (box.w || 1), (py - box.y) / (box.h || 1)];
      return ((u - x1) * dx + (v - y1) * dy) / len2;
    };
  };

  const X = (x) => ox + x * S;
  const Y = (y) => oy + y * S;
  const transparency = (o) => (o < 1 ? { transparency: r2(1 - o) } : {});

  // What lies behind text, for blending runs that are more transparent than the rest of their text.
  let background = { color: '#ffffff' };
  const backgroundAt = (x, y) => (background.gradient ? gradientColor(background.gradient, background.t([x, y])) : background.color);

  const ops = [];
  const formats = [];
  let inserted = 0;
  const push = (...list) => {
    for (const op of list) {
      ops.push(op);
      if (op.op !== 'set_background') inserted++;
    }
  };

  /** One shape from paths drawn in SVG units inside `box`, with fill and/or outline. */
  const shapeOps = (box, ds, a) => {
    const fill = paintOf(a.fill ?? '#000000');
    const stroke = paintOf(a.stroke);
    const sw = num(a['stroke-width'], 1);
    const fo = num(a['fill-opacity'], 1) * a.opacity;
    const so = num(a['stroke-opacity'], 1) * a.opacity;
    if (stroke && a['stroke-dasharray'] && a['stroke-dasharray'] !== 'none') warn('Dashed outlines are drawn solid (Canva apps can\'t set a dash style).');
    const pad = stroke ? sw / 2 : 0;
    const place = (p) => ({ top: r1(Y(box.y - p)), left: r1(X(box.x - p)), width: r1((box.w + 2 * p) * S), height: r1((box.h + 2 * p) * S), viewBox: { top: box.y - p, left: box.x - p, width: box.w + 2 * p, height: box.h + 2 * p } });
    const groups = (paths) => {
      const out = [];
      let cur = [];
      let bytes = 0;
      for (const p of paths) {
        const size = Buffer.byteLength(p.d);
        if (size > MAX_PATH_BYTES) {
          warn(`A path with ${size} bytes of data was left out: Canva takes at most ${MAX_PATH_BYTES} per shape.`);
          continue;
        }
        if (cur.length === MAX_PATHS || bytes + size > MAX_PATH_BYTES) {
          out.push(cur);
          cur = [];
          bytes = 0;
        }
        cur.push(p);
        bytes += size;
      }
      if (cur.length) out.push(cur);
      return out;
    };
    const shapes = (paths, p, o) => groups(paths).map((group) => ({ op: 'insert_shape', ...place(p), paths: group, ...transparency(o) }));
    if (fill && stroke && Math.abs(fo - so) < 0.01) return shapes(ds.map((d) => ({ d, color: fill, strokeColor: stroke, strokeWeight: r1(sw * S) })), pad, fo);
    return [
      ...(fill && fo > 0 ? shapes(ds.map((d) => ({ d, color: fill })), 0, fo) : []),
      ...(stroke && so > 0 ? shapes(ds.map((d) => ({ d, strokeColor: stroke, strokeWeight: r1(sw * S) })), pad, so) : []),
    ];
  };

  /** A linear gradient fill as bands of solid color (later bands drawn over earlier ones). */
  const gradientOps = (box, g, a) => {
    const t = gradientT(g, box);
    const poly = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
    const ts = poly.map(t);
    const [lo, hi] = [Math.min(...ts), Math.max(...ts)];
    const o = num(a['fill-opacity'], 1) * a.opacity;
    const step = (hi - lo) / GRADIENT_BANDS;
    const paths = [];
    for (let i = 0; i < GRADIENT_BANDS && step > 1e-9; i++) {
      // Opaque bands overlap (no seams between them); translucent ones can't, or they would add up.
      let band = clipPolygon(poly, t, lo + i * step);
      if (o < 1) band = clipPolygon(band, (p) => -t(p), -(lo + (i + 1) * step));
      if (band.length >= 3) paths.push({ d: polygonPath(band), color: gradientColor(g, lo + (i + 0.5) * step) });
    }
    if (!paths.length) paths.push({ d: polygonPath(poly), color: gradientColor(g, lo) });
    const place = { top: r1(Y(box.y)), left: r1(X(box.x)), width: r1(box.w * S), height: r1(box.h * S), viewBox: { top: box.y, left: box.x, width: box.w, height: box.h } };
    return chunks(paths, 6).map((group) => ({ op: 'insert_shape', ...place, paths: group, ...transparency(o) }));
  };

  const rectOps = (a, isBackground) => {
    const box = { x: num(a.x), y: num(a.y), w: num(a.width), h: num(a.height) };
    if (box.w <= 0 || box.h <= 0) return [];
    const rx = num(a.rx ?? a.ry);
    const gradient = gradientOf(a.fill);
    const fo = num(a['fill-opacity'], 1) * a.opacity;
    if (gradient) {
      if (gradient.tag !== 'linearGradient') {
        warn('Radial gradients are drawn in their middle color.');
        return rectOps({ ...a, fill: gradientColor(gradient, 0.5) }, isBackground);
      }
      if (rx) warn('A rounded rectangle with a gradient was drawn with square corners.');
      if (isBackground) {
        background = { gradient, t: gradientT(gradient, box) };
        return [{ op: 'set_background', color: gradientColor(gradient, 0.5) }, ...gradientOps(box, gradient, a)];
      }
      return gradientOps(box, gradient, a);
    }
    const fill = paintOf(a.fill ?? '#000000');
    const stroke = paintOf(a.stroke);
    if (isBackground && fill && !stroke) {
      background = { color: fo < 1 ? mix(fill, '#ffffff', fo) : fill };
      return [{ op: 'set_background', color: background.color }];
    }
    if (!rx && fill && !stroke) return fo > 0 ? [{ op: 'insert_rect', top: r1(Y(box.y)), left: r1(X(box.x)), width: r1(box.w * S), height: r1(box.h * S), color: fill, ...transparency(fo) }] : [];
    return shapeOps(box, [roundRectPath(box.w, box.h, rx, box.x, box.y)], a);
  };

  const lineOps = (a) => {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => num(a[k]));
    const color = paintOf(a.stroke);
    if (!color) return [];
    if (a['stroke-dasharray'] && a['stroke-dasharray'] !== 'none') warn('Dashed lines are drawn solid (Canva apps can\'t set a dash style).');
    const th = Math.max(num(a['stroke-width'], 1) * S, 1);
    const t = transparency(num(a['stroke-opacity'], 1) * a.opacity);
    if (y1 === y2) return [{ op: 'insert_rect', top: r1(Y(y1) - th / 2), left: r1(X(Math.min(x1, x2))), width: r1(Math.abs(x2 - x1) * S), height: r1(th), color, ...t }];
    if (x1 === x2) return [{ op: 'insert_rect', top: r1(Y(Math.min(y1, y2))), left: r1(X(x1) - th / 2), width: r1(th), height: r1(Math.abs(y2 - y1) * S), color, ...t }];
    const len = Math.hypot(x2 - x1, y2 - y1) * S;
    const cx = X((x1 + x2) / 2);
    const cy = Y((y1 + y2) / 2);
    return [{ op: 'insert_rect', top: r1(cy - th / 2), left: r1(cx - len / 2), width: r1(len), height: r1(th), rotation: r1((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI), color, ...t }];
  };

  /** Any path data: filled subpaths become shape paths, stroked straight lines become outlines. */
  const pathOps = (d, a) => {
    let parsed;
    try {
      parsed = absoluteSubpaths(d);
    } catch (err) {
      warn(`A path was left out: ${err.message}`);
      return [];
    }
    const { subpaths } = parsed;
    if (!subpaths.length) return [];
    const box = { x: parsed.bounds.x, y: parsed.bounds.y, w: parsed.bounds.width, h: parsed.bounds.height };
    const fill = paintOf(a.fill ?? '#000000');
    const stroke = paintOf(a.stroke);
    const allClosed = subpaths.every((s) => s.closed);
    const out = [];
    if (fill) {
      if (subpaths.length > 1) warn('A path with several outlines is drawn as separate filled shapes, so holes in it are filled.');
      // SVG fills open subpaths as if closed. Outline them here too only if every subpath is closed;
      // open ones are outlined below without the closing edge.
      out.push(...shapeOps(box, subpaths.map((s) => (s.closed ? s.d : `${s.d} Z`)), { ...a, stroke: allClosed ? a.stroke : 'none' }));
      if (allClosed || !stroke) return out;
    } else if (stroke) {
      const closed = subpaths.filter((s) => s.closed).map((s) => s.d);
      if (closed.length) out.push(...shapeOps(box, closed, { ...a, fill: 'none' }));
    }
    for (const s of subpaths) {
      if (s.closed) continue;
      if (s.straight && s.points.length >= 2) {
        const outline = strokeOutline(s.points.map((p) => [p.x, p.y]), num(a['stroke-width'], 1));
        const b = bboxOf(outline);
        out.push(...shapeOps(b, [polygonPath(outline)], { fill: a.stroke, 'fill-opacity': a['stroke-opacity'], opacity: a.opacity }));
      } else {
        warn('An open, curved outline was left out: Canva only draws closed paths.');
      }
    }
    return out;
  };

  const textOps = (node, a) => {
    const base = {
      fs: num(a['font-size'], 16),
      weight: WEIGHT(a['font-weight']),
      style: a['font-style'] === 'italic' ? 'italic' : 'normal',
      fill: paintOf(a.fill ?? '#000000') ?? '#000000',
      op: num(a['fill-opacity'], 1) * a.opacity,
    };
    const x = num(a.x);
    const y = num(a.y);
    const anchor = a['text-anchor'] ?? 'start';
    const ls = num(a['letter-spacing']);
    const lines = [{ dy: 0, runs: [] }];
    // Baseline of the current line in the text's own (untranslated) coordinates.
    let lineY = num(node.attrs.y);
    const add = (text, st) => {
      const t = text.replace(/\s+/g, ' ');
      if (t) lines.at(-1).runs.push({ text: t, ...st });
    };
    const walkText = (n, st) => {
      for (const c of n.children) {
        if (c.text !== undefined) add(c.text, st);
        else if (c.tag === 'tspan') {
          const ta = c.attrs;
          const next = {
            fs: num(ta['font-size'], st.fs),
            weight: ta['font-weight'] ? WEIGHT(ta['font-weight']) : st.weight,
            style: ta['font-style'] ? (ta['font-style'] === 'italic' ? 'italic' : 'normal') : st.style,
            fill: paintOf(ta.fill) ?? st.fill,
            op: ta['fill-opacity'] !== undefined ? num(ta['fill-opacity']) * a.opacity : st.op,
          };
          // A tspan that moves the baseline starts a new line (ppt-master writes x and dy together).
          if (ta.dy !== undefined || ta.y !== undefined) {
            const nextY = ta.y !== undefined ? num(ta.y) : lineY + num(ta.dy);
            lines.push({ dy: nextY - lineY, runs: [] });
            lineY = nextY;
          }
          walkText(c, next);
        }
      }
    };
    walkText(node, base);
    const used = lines.filter((l) => l.runs.length);
    for (const l of used) {
      l.runs[0].text = l.runs[0].text.replace(/^ /, '');
      l.runs.at(-1).text = l.runs.at(-1).text.replace(/ $/, '');
      l.runs = l.runs.filter((r) => r.text);
      l.fs = l.runs[0]?.fs ?? base.fs;
      l.text = l.runs.map((r) => r.text).join('');
    }
    const kept = used.filter((l) => l.text);
    if (!kept.length) return { ops: [], post: [] };
    if (kept.some((l) => l.runs.some((r) => Math.abs(r.fs - l.fs) > 0.01))) warn('Text with two sizes on one line is drawn in one size (Canva sizes whole paragraphs); split it into separate texts to match.');

    const first = kept[0].runs[0];
    // Canva sets transparency per element: blend runs that differ from the rest into the background.
    const sameOpacity = kept.every((l) => l.runs.every((r) => Math.abs(r.op - first.op) < 0.01));
    const behind = backgroundAt(x, y);
    const runColor = (r) => (sameOpacity ? r.fill : mix(r.fill, behind, r.op));
    const fs1 = kept[0].fs;
    const lh = kept.length > 1 ? kept[1].dy / (kept[1].fs * fontScale) : 1.2;
    const widest = Math.max(...kept.map((l) => textWidth(l.text, l.fs, l.runs[0].weight !== 'normal', ls)));
    // Generous width: SVG text never wraps, so a box that is too narrow would add line breaks.
    let width = widest * S * 1.35 + 16;
    let left;
    if (anchor === 'middle') {
      width = Math.min(width, 2 * Math.min(X(x), pageWidth - X(x)));
      left = X(x) - width / 2;
    } else if (anchor === 'end') {
      width = Math.min(width, X(x));
      left = X(x) - width;
    } else {
      left = X(x);
      width = Math.min(width, pageWidth - left);
    }
    const formatting = {
      fontSize: r1(fs1 * S * fontScale),
      color: runColor(first),
      fontWeight: first.weight,
      ...(first.style === 'italic' ? { fontStyle: 'italic' } : {}),
      textAlign: anchor === 'middle' ? 'center' : anchor === 'end' ? 'end' : 'start',
      lineHeightEm: r2(Math.max(0.5, Math.min(2.5, lh))),
      ...(ls ? { letterSpacingEm: Math.min(0.8, Math.round((ls / (fs1 * fontScale)) * 1000) / 1000) } : {}),
    };
    const op = {
      op: 'insert_text',
      text: kept.map((l) => l.text).join('\n'),
      top: r1(Y(y) - ascent * fs1 * S * fontScale),
      left: r1(left),
      width: r1(Math.max(width, 1)),
      formatting,
      ...(sameOpacity ? transparency(first.op) : {}),
    };
    // What differs from the element's formatting: per-paragraph size and spacing, per-run style.
    const post = [];
    kept.forEach((l, i) => {
      if (i === 0) return;
      const pf = {};
      if (Math.abs(l.fs - fs1) > 0.01) pf.fontSize = r1(l.fs * S * fontScale);
      const plh = r2(Math.max(0.5, Math.min(2.5, l.dy / (l.fs * fontScale))));
      if (Math.abs(plh - formatting.lineHeightEm) > 0.02) pf.lineHeightEm = plh;
      if (Object.keys(pf).length) post.push({ find: l.text, formatting: pf });
    });
    for (const l of kept) {
      for (const r of l.runs) {
        const rf = {};
        if (runColor(r) !== formatting.color) rf.color = runColor(r);
        if (r.weight !== first.weight) rf.fontWeight = r.weight;
        if (r.style !== first.style) rf.fontStyle = r.style;
        if (Object.keys(rf).length && r.text.trim()) post.push({ find: r.text.trim(), formatting: rf });
      }
    }
    return { ops: [op], post };
  };

  // Walk the drawing in order, with inherited presentation attributes and translate() offsets.
  let painted = false;
  const translateOf = (t, where) => {
    if (!t) return [0, 0];
    const m = t.trim().match(/^translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)$/) ?? t.trim().match(/^matrix\(\s*1[\s,]+0[\s,]+0[\s,]+1[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/);
    if (m) return [num(m[1]), num(m[2])];
    warn(`transform="${t}" on ${where} isn't supported; it was drawn without it.`);
    return [0, 0];
  };
  const shift = (a, dx, dy) => {
    if (!dx && !dy) return a;
    const out = { ...a };
    for (const k of ['x', 'cx', 'x1', 'x2']) if (out[k] !== undefined) out[k] = String(num(out[k]) + dx);
    for (const k of ['y', 'cy', 'y1', 'y2']) if (out[k] !== undefined) out[k] = String(num(out[k]) + dy);
    return out;
  };
  const shiftPoints = (pts, dx, dy) => pts.map(([px, py]) => [px + dx, py + dy]);
  const pointsOf = (s) => chunks((s ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number), 2).filter((p) => p.length === 2);

  const walk = (node, inherited, [tx, ty]) => {
    for (const c of elementsOf(node)) {
      if (SKIPPED.has(c.tag)) continue;
      const own = c.attrs;
      const a = { ...inherited, ...Object.fromEntries(Object.entries(own).filter(([k]) => k !== 'opacity')), opacity: inherited.opacity * num(own.opacity, 1) };
      for (const k of ['clip-path', 'mask', 'filter']) if (own[k] && own[k] !== 'none') warn(`${k} is ignored (Canva apps can't set it).`);
      if (own['marker-start'] || own['marker-end'] || own['marker-mid']) warn('Line markers (arrowheads) are left out.');
      if (a.display === 'none' || a.visibility === 'hidden') continue;
      const [dx, dy] = translateOf(own.transform, `<${c.tag}${own.id ? ` id="${own.id}"` : ''}>`);
      const off = [tx + dx, ty + dy];
      const sa = shift(a, off[0], off[1]);
      const isBackground = !painted && c.tag === 'rect' && num(sa.x) <= vx && num(sa.y) <= vy && num(sa.width) >= vw && num(sa.height) >= vh;
      switch (c.tag) {
        case 'g':
        case 'a':
        case 'switch':
          walk(c, Object.fromEntries(Object.entries(a).filter(([k]) => INHERITED.includes(k) || k === 'opacity')), off);
          continue;
        case 'rect':
          push(...rectOps(sa, isBackground));
          break;
        case 'circle':
        case 'ellipse': {
          const [rx, ry] = c.tag === 'circle' ? [num(a.r), num(a.r)] : [num(a.rx), num(a.ry)];
          const box = { x: num(sa.cx) - rx, y: num(sa.cy) - ry, w: 2 * rx, h: 2 * ry };
          if (rx > 0 && ry > 0) push(...shapeOps(box, [ellipsePath(rx, ry, box.x, box.y)], sa));
          break;
        }
        case 'line':
          push(...lineOps(sa));
          break;
        case 'polyline':
        case 'polygon': {
          const pts = shiftPoints(pointsOf(a.points), off[0], off[1]);
          if (pts.length >= 2) push(...pathOps(`M${pts.map((p) => p.join(' ')).join(' L')}${c.tag === 'polygon' ? ' Z' : ''}`, a));
          break;
        }
        case 'path': {
          // Shift by the translate offset through the absolute form.
          let d = a.d ?? '';
          if (off[0] || off[1]) {
            try {
              d = absoluteSubpaths(d).subpaths.map((s) => s.d.replace(/(-?\d*\.?\d+(?:e-?\d+)?)\s+(-?\d*\.?\d+(?:e-?\d+)?)/gi, (_, px, py) => `${f(Number(px) + off[0])} ${f(Number(py) + off[1])}`)).join(' ');
              if (/A/.test(d)) warn('A translated path with arcs may be drawn out of place.');
            } catch {
              // pathOps reports unreadable path data.
            }
          }
          push(...pathOps(d, a));
          break;
        }
        case 'text': {
          const t = textOps(c, sa);
          for (const p of t.post) formats.push({ insert: inserted, ...p });
          push(...t.ops);
          break;
        }
        case 'image':
          warn('Images were left out: place them with edit-page\'s insert_image, or by hand in Canva.');
          break;
        default:
          warn(`<${c.tag}> elements are not supported and were left out.`);
          continue;
      }
      painted = true;
    }
  };
  walk(svg, { opacity: 1, ...Object.fromEntries(Object.entries(svg.attrs).filter(([k]) => INHERITED.includes(k))) }, [0, 0]);
  if (!ops.some((o) => o.op === 'set_background')) ops.unshift({ op: 'set_background', color: '#ffffff' });
  return { ops, formats, warnings: [...warnings], size: { width: vw, height: vh } };
}

// --- Command line ---------------------------------------------------------------------------------

/** The SVG files of a folder in name order (numbers compared as numbers), or a single file. */
export function listSlides(source) {
  const stat = fs.statSync(source, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${source} doesn't exist.`);
  if (stat.isFile()) return [path.resolve(source)];
  const files = fs
    .readdirSync(source)
    .filter((n) => n.toLowerCase().endsWith('.svg'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error(`There are no .svg files in ${source}.`);
  return files.map((n) => path.resolve(source, n));
}

/** Turns mapping arguments (3, 3:7, 2-5, 2-5:10) into [{ slide, page }], 1-based. */
export function parseMapping(tokens, slideCount) {
  const list = tokens.length ? tokens : [`1-${slideCount}`];
  const jobs = [];
  for (const t of list) {
    const m = t.match(/^(\d+)(?:-(\d+))?(?::(\d+))?$/);
    if (!m) throw new Error(`Can't read "${t}": use N, N:PAGE, FROM-TO or FROM-TO:PAGE.`);
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    const page = Number(m[3] ?? m[1]);
    if (to < from) throw new Error(`"${t}": the range runs backwards.`);
    for (let s = from; s <= to; s++) {
      if (s < 1 || s > slideCount) throw new Error(`There's no slide ${s}: found ${slideCount} SVG file${slideCount === 1 ? '' : 's'}.`);
      jobs.push({ slide: s, page: page + (s - from) });
    }
  }
  const pages = jobs.map((j) => j.page);
  const twice = pages.find((p, i) => pages.indexOf(p) !== i);
  if (twice !== undefined) throw new Error(`Page ${twice} is the target of two slides.`);
  if (pages.some((p) => p < 1)) throw new Error('Pages are numbered from 1.');
  return jobs;
}

function parseArgs(argv) {
  const opts = { positional: [], replace: false, check: false, dry: false, out: undefined, pageSize: '1920x1080', fontScale: 0.94, ascent: 0.95 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--replace') opts.replace = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--dry') opts.dry = true;
    else if (a === '--out') opts.out = value();
    else if (a === '--page-size') opts.pageSize = value();
    else if (a === '--font-scale') opts.fontScale = Number(value());
    else if (a === '--ascent') opts.ascent = Number(value());
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else opts.positional.push(a);
  }
  if (!(opts.fontScale > 0) || !(opts.ascent > 0)) throw new Error('--font-scale and --ascent take positive numbers.');
  return opts;
}

async function connect() {
  const server = path.join(root, 'dist', 'index.js');
  if (!fs.existsSync(server)) throw new Error('canva-mcp isn\'t built yet: run npm run build first.');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'svg2canva', version: '1.0.0' });
  // A second canva-mcp instance relays through the one Claude runs, so this works alongside it.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env }, stderr: 'ignore' }));
  const { tools } = await client.listTools();
  const name = (base) => {
    const found = tools.find((t) => t.name.endsWith(base));
    if (!found) throw new Error(`canva-mcp has no ${base} tool; is the bridge off (CANVA_BRIDGE=off)?`);
    return found.name;
  };
  const names = { status: name('editor-status'), read: name('read-page'), edit: name('edit-page') };
  const call = async (tool, args = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await client.callTool({ name: names[tool], arguments: args }, undefined, { timeout: 120_000 });
      const text = res.content.find((c) => c.type === 'text')?.text ?? '';
      if (!res.isError) return JSON.parse(text);
      // Canva rate-limits opening the design; a refused batch changed nothing, so retrying is safe.
      if (!/rate.?limit/i.test(text) || attempt >= 6) throw new Error(text);
      const wait = 5000 * 2 ** attempt;
      console.log(`  Canva is rate-limiting; retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  return { call, close: () => client.close() };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.positional.length) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?/gm, ''));
    return;
  }
  const [source, ...mapping] = opts.positional;
  const slides = listSlides(source);
  const jobs = parseMapping(mapping, slides.length);
  const save = (job, result) => {
    if (!opts.out) return;
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, `${path.basename(slides[job.slide - 1], '.svg')}.ops.json`), JSON.stringify(result, null, 1));
  };
  const report = (job, result) => {
    console.log(`slide ${job.slide} (${path.basename(slides[job.slide - 1])}) -> page ${job.page}: ${result.ops.length} operations, ${result.formats.length} text formats`);
    for (const w of result.warnings) console.log(`  note: ${w}`);
  };
  const convertJob = (job, size) => convertSvg(fs.readFileSync(slides[job.slide - 1], 'utf8'), { ...size, fontScale: opts.fontScale, ascent: opts.ascent });

  if (opts.dry) {
    const [pageWidth, pageHeight] = opts.pageSize.split('x').map(Number);
    if (!(pageWidth > 0 && pageHeight > 0)) throw new Error('--page-size looks like 1920x1080.');
    for (const job of jobs) {
      const result = convertJob(job, { pageWidth, pageHeight });
      report(job, result);
      save(job, result);
    }
    return;
  }

  const canva = await connect();
  try {
    const status = await canva.call('status');
    if (!status.design || status.design.error) throw new Error(status.next ?? status.design?.error ?? 'No Canva editor is connected.');
    const pages = status.design.pages;
    const missing = jobs.filter((j) => j.page > pages.length);
    if (missing.length) throw new Error(`The design has ${pages.length} pages, so page${missing.length === 1 ? '' : 's'} ${missing.map((j) => j.page).join(', ')} ${missing.length === 1 ? "doesn't" : "don't"} exist. Add pages in Canva first.`);
    // Refuse up front, before anything changes, if a page with content would be cleared.
    if (!opts.check && !opts.replace) {
      const busy = [];
      for (const job of jobs) {
        const n = (await canva.call('read', { page: job.page })).elements.length;
        if (n) busy.push(`page ${job.page} (${n} elements)`);
      }
      if (busy.length) throw new Error(`These pages already have content: ${busy.join(', ')}. Pass --replace to clear them, or pick empty pages.`);
    }

    for (const job of jobs) {
      const info = pages[job.page - 1];
      const result = convertJob(job, { pageWidth: info.width ?? 1920, pageHeight: info.height ?? 1080 });
      report(job, result);
      save(job, result);
      const backgroundOps = result.ops.filter((o) => o.op === 'set_background');
      const inserts = result.ops.filter((o) => o.op !== 'set_background');
      if (opts.check) {
        for (const batch of chunks([...backgroundOps, ...inserts], BATCH)) await canva.call('edit', { page: job.page, dryRun: true, operations: batch });
        console.log('  dry run passed');
        continue;
      }
      const before = await canva.call('read', { page: job.page });
      for (const batch of chunks(before.elements.map((e) => ({ op: 'delete', element: e.path, key: e.key })), BATCH)) await canva.call('edit', { page: job.page, operations: batch });
      for (const batch of chunks([...backgroundOps, ...inserts], BATCH)) await canva.call('edit', { page: job.page, operations: batch });
      const after = await canva.call('read', { page: job.page });
      // The page was empty, so the n-th inserted element is element n.
      const base = after.elements.length - inserts.length;
      const formats = result.formats.map((p) => ({ op: 'format_text', element: String(base + p.insert), find: p.find, formatting: p.formatting }));
      for (const batch of chunks(formats, BATCH)) await canva.call('edit', { page: job.page, operations: batch });
      console.log(`  built: ${after.elements.length} elements`);
    }
  } finally {
    await canva.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
