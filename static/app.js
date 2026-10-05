/* Timeline video editor frontend — Phase 1. Vanilla JS, no dependencies.
   Project = instructions only; sources are never modified. */
"use strict";

const $ = (s) => document.querySelector(s);
const video = $("#video");

const TRANSITIONS = ["none", "dissolve", "dipblack", "flash", "slideleft", "slideright", "slideup", "slidedown", "push", "zoom", "blur", "pixelize", "wipe", "circle"];
/** Max box size as fraction of stage ( >1 = overflow/crop ). 4 covers 16:9→9:16 cover. */
const MAX_BOX_SCALE = 4;
const BUILTIN_FONTS = ["Arial", "Arial Bold", "Arial Black", "Impact", "Segoe UI", "Segoe UI Bold", "Times New Roman", "Georgia", "Verdana", "Comic Sans", "Consolas", "Nirmala UI (Bangla)", "Nirmala UI Bold (Bangla)", "Shonar Bangla", "Vrinda (Bangla)"];
const FONT_CSS = {
  "Arial": "Arial", "Arial Bold": "Arial", "Arial Black": "'Arial Black'", "Impact": "Impact",
  "Segoe UI": "'Segoe UI'", "Segoe UI Bold": "'Segoe UI'", "Times New Roman": "'Times New Roman'",
  "Georgia": "Georgia", "Verdana": "Verdana", "Comic Sans": "'Comic Sans MS'", "Consolas": "Consolas",
  "Nirmala UI (Bangla)": "'Nirmala UI'", "Nirmala UI Bold (Bangla)": "'Nirmala UI'",
  "Shonar Bangla": "'Shonar Bangla'", "Vrinda (Bangla)": "'Vrinda'",
};
function allFonts() { return [...BUILTIN_FONTS, ...state.fonts.map((f) => f.family)]; }
function fontCss(name) { return FONT_CSS[name] || `'${name}'`; }
function fontWeight(name) { return /Bold|Black|Impact/.test(name) ? "700" : "400"; }
function refreshFontFaces() {
  let styleEl = document.getElementById("customFontFaces");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "customFontFaces";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = state.fonts
    .map((f) => `@font-face { font-family: '${f.family}'; src: url('/media/${f.id}'); }`)
    .join("\n");
}
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_ADJ = { exposure: 0, contrast: 1, saturation: 1, temperature: 0, sharpen: 0, vignette: false };
const PIP_PRESETS = [
  { name: "Inset ↘", x: 0.82, y: 0.82, scaleW: 0.28, keepAspect: true },
  { name: "Inset ↙", x: 0.18, y: 0.82, scaleW: 0.28, keepAspect: true },
  { name: "Inset ↗", x: 0.82, y: 0.18, scaleW: 0.28, keepAspect: true },
  { name: "Inset ↖", x: 0.18, y: 0.18, scaleW: 0.28, keepAspect: true },
  { name: "Full overlay", x: 0.5, y: 0.5, scaleW: 1, scaleH: 1 },
  { name: "Split left", x: 0.25, y: 0.5, scaleW: 0.5, scaleH: 1 },
  { name: "Split right", x: 0.75, y: 0.5, scaleW: 0.5, scaleH: 1 },
];
const FRAME_PRESETS = [
  { name: "Full frame", x: 0.5, y: 0.5, scaleW: 1, scaleH: 1 },
  { name: "Split left", x: 0.25, y: 0.5, scaleW: 0.5, scaleH: 1 },
  { name: "Split right", x: 0.75, y: 0.5, scaleW: 0.5, scaleH: 1 },
  { name: "Top half", x: 0.5, y: 0.25, scaleW: 1, scaleH: 0.5 },
  { name: "Bottom half", x: 0.5, y: 0.75, scaleW: 1, scaleH: 0.5 },
  { name: "Inset ↘", x: 0.82, y: 0.82, scaleW: 0.28, keepAspect: true },
];
/** Stage pixel size (fallback 16:9). */
function stageSize() {
  const stage = $("#stage");
  return {
    sw: (stage && stage.clientWidth) || 1920,
    sh: (stage && stage.clientHeight) || 1080,
  };
}

/** Height fraction that keeps media aspect for a given width fraction. */
function scaleHForAspect(scaleW, natW, natH, sw, sh) {
  const tw = sw || stageSize().sw;
  const th = sh || stageSize().sh;
  const natAr = Math.max((natW || 16) / Math.max(natH || 9, 1), 0.05);
  const stageAr = tw / Math.max(th, 1);
  return clamp(scaleW * stageAr / natAr, 0.05, MAX_BOX_SCALE);
}

/** Default box sized by width, preserving source aspect (clamped to stage). */
function naturalBox(scaleW, natW, natH) {
  const { sw, sh } = stageSize();
  let w = clamp(scaleW, 0.05, 1);
  let h = scaleHForAspect(w, natW, natH, sw, sh);
  if (h > 1) {
    h = 1;
    const natAr = Math.max((natW || 16) / Math.max(natH || 9, 1), 0.05);
    w = clamp(h * natAr / (sw / sh), 0.05, 1);
  }
  return { scaleW: w, scaleH: h, scale: w };
}

function ensureClipLayout(c) {
  if (!c) return;
  if (c.x == null) c.x = 0.5;
  if (c.y == null) c.y = 0.5;
  if (c.scaleW == null) c.scaleW = c.scale != null ? c.scale : 1;
  if (c.scaleH == null) {
    if (Math.abs(c.scaleW - 1) < 0.01 && Math.abs(c.x - 0.5) < 0.01 && Math.abs(c.y - 0.5) < 0.01) {
      c.scaleH = 1;
    } else {
      c.scaleH = scaleHForAspect(c.scaleW, c.w, c.h);
    }
  }
  c.scale = c.scaleW;
}
function isFullFrame(c) {
  ensureClipLayout(c);
  return Math.abs(c.scaleW - 1) < 0.01 && Math.abs(c.scaleH - 1) < 0.01
    && Math.abs(c.x - 0.5) < 0.01 && Math.abs(c.y - 0.5) < 0.01;
}

/** Ensure overlay/clip has scaleW/scaleH (fractions of stage). Legacy `scale` = width. */
function ensureBoxSize(item, sw, sh, natAr) {
  if (item.scaleW == null) item.scaleW = item.scale != null ? item.scale : 0.28;
  if (item.scaleH == null) {
    const ar = (natAr > 0.05 ? natAr : null)
      || ((item.w || 16) / Math.max(item.h || 9, 1));
    item.scaleH = scaleHForAspect(item.scaleW, ar, 1, sw, sh);
  }
  item.scale = item.scaleW;
}

/** Text overlays use a resizable box (wrap width × frame height). Font size is independent. */
const TEXT_H_FROM_SIZE = 1.55; // single-line default padding (Bengali diacritics need room)
function ensureTextBox(t) {
  if (t.size == null) t.size = 0.08;
  if (t.scaleH == null) t.scaleH = clamp(Number(t.size) * TEXT_H_FROM_SIZE, 0.05, 0.7);
  if (t.scaleW == null) t.scaleW = 0.55;
  if (t.lineGap == null) t.lineGap = 1.35;
  t.scale = t.scaleW;
}
/** Corner-scale: grow/shrink font with the box (uniform). */
function syncTextSizeFromBox(t) {
  ensureTextBox(t);
  t.size = clamp(t.scaleH / TEXT_H_FROM_SIZE, 0.015, 0.4);
}
/** Size slider: bump default single-line height; multi-line is remeasured on render. */
function syncTextBoxFromSize(t) {
  if (t.size == null) t.size = 0.08;
  const minH = clamp(Number(t.size) * TEXT_H_FROM_SIZE, 0.05, 0.8);
  if (t.scaleH == null || t.scaleH < minH) t.scaleH = minH;
  if (t.scaleW == null) t.scaleW = 0.55;
  t.scale = t.scaleW;
}

/** Measure text element and grow scaleH so multi-line content is never cropped. */
function fitTextBoxToContent(t, el, sh) {
  if (!el || !sh) return;
  const prevH = el.style.height;
  const prevOv = el.style.overflow;
  el.style.height = "auto";
  el.style.overflow = "visible";
  // force layout
  const needed = (el.scrollHeight || el.offsetHeight) / sh;
  el.style.height = prevH;
  el.style.overflow = prevOv;
  const padded = needed * 1.06 + 0.012;
  if (padded > (t.scaleH || 0) + 0.002) {
    t.scaleH = clamp(padded, 0.05, 0.95);
  }
}

/** If the user shrunk the box, reduce font until the text fits (no cropping). */
function shrinkTextToFitBox(t, el, sh) {
  if (!el || !sh) return;
  let fs = Math.max(6, (t.size || 0.08) * sh);
  el.style.fontSize = fs + "px";
  el.style.height = (t.scaleH * sh) + "px";
  el.style.overflow = "hidden";
  let guard = 0;
  while (guard++ < 40 && el.scrollHeight > el.clientHeight + 2 && fs > 6) {
    fs *= 0.92;
    el.style.fontSize = fs + "px";
  }
  t.size = fs / sh;
}

/**
 * Render a text overlay to a PNG at export resolution (frame W×H) so the export matches the preview:
 * the browser lays the text out with the same box styles as #ovLayer .ovText, then each line is
 * painted onto a canvas. Returns a PNG data URL of the (rotated) box, or null for empty text.
 */
async function rasterizeText(t, W, H) {
  ensureTextBox(t);
  const text = String(t.text || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;
  const family = fontCss(t.font);
  const weight = fontWeight(t.font);
  const fs = Math.max(1, (Number(t.size) || 0.08) * H);
  const font = `${weight} ${fs}px ${family}`;
  try { await document.fonts.load(font, text); } catch (_) { /* fall back to whatever is available */ }

  const bw = Math.max(1, Math.round(t.scaleW * W));
  const bh = Math.max(1, Math.round(t.scaleH * H));
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed", left: "-100000px", top: "0", visibility: "hidden",
    display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
    padding: "0.2em 0.35em", textAlign: "center", overflow: "hidden",
    width: bw + "px", height: bh + "px", fontFamily: family, fontWeight: weight, fontSize: fs + "px",
  });
  const inner = document.createElement("div");
  Object.assign(inner.style, {
    whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", maxWidth: "100%",
    lineHeight: String(t.lineGap), textAlign: "center",
  });
  inner.textContent = text;
  box.appendChild(inner);
  document.body.appendChild(box);

  // Group characters into the line boxes the browser produced (handles wrapping and explicit newlines).
  const lines = [];
  try {
    const node = inner.firstChild;
    const origin = box.getBoundingClientRect();
    const range = document.createRange();
    let cur = null;
    for (let i = 0; i < text.length;) {
      const n = text.codePointAt(i) > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + n);
      if (ch === "\n") {
        cur = null;
      } else {
        range.setStart(node, i);
        range.setEnd(node, i + n);
        const r = range.getClientRects()[0];
        if (r) {
          if (!cur || Math.abs(r.top - cur.top) > fs * 0.3) {
            cur = { text: "", left: r.left - origin.left, top: r.top - origin.top };
            lines.push(cur);
          }
          cur.text += ch;
        }
      }
      i += n;
    }
  } finally {
    box.remove();
  }

  const c = document.createElement("canvas");
  c.width = bw;
  c.height = bh;
  const g = c.getContext("2d");
  if (t.box) {
    g.fillStyle = shadowRgba(t.boxColor || "#000000", t.boxAlpha != null ? Number(t.boxAlpha) : 0.5);
    g.beginPath();
    g.roundRect(0, 0, bw, bh, 0.12 * fs);
    g.fill();
  }
  g.font = font;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  const ascent = g.measureText("H").fontBoundingBoxAscent;
  g.fillStyle = t.color || "#ffffff";
  if (t.shadow) {
    g.shadowColor = shadowRgba(t.shadowColor || "#000000");
    g.shadowOffsetX = g.shadowOffsetY = TEXT_SHADOW_OFFSET * H;
    g.shadowBlur = TEXT_SHADOW_BLUR * H;
  }
  for (const ln of lines) g.fillText(ln.text, ln.left, ln.top + ascent);
  g.shadowColor = "transparent";
  if (Number(t.strokeW) > 0) {
    g.lineWidth = Number(t.strokeW) * (H / 1080);
    g.strokeStyle = t.stroke || "#000000";
    for (const ln of lines) g.strokeText(ln.text, ln.left, ln.top + ascent);
  }

  const rad = ((Number(t.rotate) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.ceil(bw * cos + bh * sin));
  out.height = Math.max(1, Math.ceil(bw * sin + bh * cos));
  const og = out.getContext("2d");
  og.globalAlpha = Math.max(0, Math.min(Number(t.opacity ?? 1), 1));
  og.translate(out.width / 2, out.height / 2);
  og.rotate(rad);
  og.drawImage(c, -bw / 2, -bh / 2);
  return out.toDataURL("image/png");
}

function applyPresetBox(item, pr) {
  item.x = pr.x; item.y = pr.y;
  item.scaleW = pr.scaleW != null ? pr.scaleW : pr.scale;
  if (pr.keepAspect || pr.scaleH == null) {
    const box = naturalBox(item.scaleW, item.w, item.h);
    item.scaleW = box.scaleW;
    item.scaleH = box.scaleH;
  } else {
    item.scaleH = pr.scaleH;
  }
  item.scale = item.scaleW;
}

function addResizeHandles(parent, withRot) {
  for (const c of ["nw", "n", "ne", "w", "e", "sw", "s", "se"]) {
    const h = document.createElement("div");
    h.className = "ovHandle " + c;
    h.dataset.corner = c;
    parent.appendChild(h);
  }
  if (withRot) {
    const rot = document.createElement("div");
    rot.className = "ovHandle rot";
    rot.dataset.corner = "rot";
    rot.title = "Drag to rotate · snaps to 90° when Snap is on";
    parent.appendChild(rot);
  }
}

/** Resize item box from a handle; mx/my are 0–1 stage coords. start = edges at mousedown. */
function resizeByHandle(item, handle, mx, my, start, opts = {}) {
  let L = start.L, R = start.R, T = start.T, B = start.B;
  const minW = 0.05, minH = 0.05;
  const stage = $("#stage");
  const sw = stage ? (stage.clientWidth || 1) : 1;
  const sh = stage ? (stage.clientHeight || 1) : 1;
  // scaleW/H are fractions of stage W/H — pixel aspect ≠ scaleW/scaleH.
  // For media, lock corners to the source pixel aspect ratio.
  let aspect;
  if (opts.sourceAspect !== false && item.w && item.h) {
    const natAr = item.w / Math.max(item.h, 1e-6);
    aspect = Math.max(natAr * sh / sw, 0.05); // target scaleW / scaleH
  } else {
    aspect = Math.max(start.scaleW / Math.max(start.scaleH, 1e-6), 0.05);
  }
  const corner = handle.length === 2;

  if (corner) {
    if (handle === "se") {
      L = start.L; T = start.T;
      let w = Math.max(minW, mx - L);
      let h = Math.max(minH, my - T);
      if (w / h > aspect) h = w / aspect; else w = h * aspect;
      R = L + w; B = T + h;
    } else if (handle === "sw") {
      R = start.R; T = start.T;
      let w = Math.max(minW, R - mx);
      let h = Math.max(minH, my - T);
      if (w / h > aspect) h = w / aspect; else w = h * aspect;
      L = R - w; B = T + h;
    } else if (handle === "ne") {
      L = start.L; B = start.B;
      let w = Math.max(minW, mx - L);
      let h = Math.max(minH, B - my);
      if (w / h > aspect) h = w / aspect; else w = h * aspect;
      R = L + w; T = B - h;
    } else if (handle === "nw") {
      R = start.R; B = start.B;
      let w = Math.max(minW, R - mx);
      let h = Math.max(minH, B - my);
      if (w / h > aspect) h = w / aspect; else w = h * aspect;
      L = R - w; T = B - h;
    }
  } else if (handle === "e") {
    R = Math.max(L + minW, mx);
  } else if (handle === "w") {
    L = Math.min(R - minW, mx);
  } else if (handle === "s") {
    B = Math.max(T + minH, my);
  } else if (handle === "n") {
    T = Math.min(B - minH, my);
  }

  let scaleW = clamp(R - L, minW, MAX_BOX_SCALE);
  let scaleH = clamp(B - T, minH, MAX_BOX_SCALE);
  // Re-assert aspect after clamping so edges don't skew media.
  if (corner) {
    const cur = scaleW / Math.max(scaleH, 1e-6);
    if (Math.abs(cur - aspect) > 0.001) {
      if (cur > aspect) scaleH = scaleW / aspect;
      else scaleW = scaleH * aspect;
      scaleW = clamp(scaleW, minW, MAX_BOX_SCALE);
      scaleH = clamp(scaleH, minH, MAX_BOX_SCALE);
      if (handle.includes("e")) R = L + scaleW; else L = R - scaleW;
      if (handle.includes("s")) B = T + scaleH; else T = B - scaleH;
    }
  }
  item.scaleW = scaleW;
  item.scaleH = scaleH;
  applyItemPos(item, (L + R) / 2, (T + B) / 2);
  item.scale = item.scaleW;
}

/** Snap resizing edges to other objects (and match their width/height). */
function snapResizeToGuides(item, handle, start, excludeType, excludeI) {
  const stage = $("#stage");
  const sw = stage.clientWidth || 1;
  const sh = stage.clientHeight || 1;
  const tolX = 8 / sw;
  const tolY = 8 / sh;
  const { xs, ys, widths, heights } = collectGuideTargets(excludeType, excludeI);
  const minW = 0.05, minH = 0.05;
  const corner = handle.length === 2;

  let L = item.x - item.scaleW / 2;
  let R = item.x + item.scaleW / 2;
  let T = item.y - item.scaleH / 2;
  let B = item.y + item.scaleH / 2;

  const moveL = handle === "w" || handle === "nw" || handle === "sw";
  const moveR = handle === "e" || handle === "ne" || handle === "se";
  const moveT = handle === "n" || handle === "nw" || handle === "ne";
  const moveB = handle === "s" || handle === "sw" || handle === "se";

  let guideX = null, guideY = null;

  const nearest = (val, list, tol) => {
    let best = null, bd = tol;
    for (const t of list) {
      const d = Math.abs(val - t);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  };

  // 1) Snap moving edges to other edges / canvas center.
  // Skip guides we're leaving — otherwise frame edges (0/1) stick and block
  // growing past the canvas (needed to cover-crop 16:9 into 9:16).
  const leaving = (cur, startV, target, tol) =>
    Math.abs(startV - target) <= tol && Math.abs(cur - target) > Math.abs(startV - target);

  if (moveR) {
    const t = nearest(R, xs, tolX);
    if (t != null && !leaving(R, start.R, t, tolX)) { R = Math.max(L + minW, t); guideX = t; }
  }
  if (moveL) {
    const t = nearest(L, xs, tolX);
    if (t != null && !leaving(L, start.L, t, tolX)) { L = Math.min(R - minW, t); guideX = t; }
  }
  if (moveB) {
    const t = nearest(B, ys, tolY);
    if (t != null && !leaving(B, start.B, t, tolY)) { B = Math.max(T + minH, t); guideY = t; }
  }
  if (moveT) {
    const t = nearest(T, ys, tolY);
    if (t != null && !leaving(T, start.T, t, tolY)) { T = Math.min(B - minH, t); guideY = t; }
  }

  // 2) Snap size to match another object's width/height
  let w = R - L, h = B - T;
  if (moveL || moveR) {
    const tw = nearest(w, widths, tolX);
    if (tw != null) {
      if (moveR && !moveL) R = L + tw;
      else if (moveL && !moveR) L = R - tw;
      else if (moveR) R = L + tw;
      else L = R - tw;
      w = R - L;
      // show guides on both edges of the resized box so matching size is obvious
      guideX = moveR ? R : L;
    }
  }
  if (moveT || moveB) {
    const th = nearest(h, heights, tolY);
    if (th != null) {
      if (moveB && !moveT) B = T + th;
      else if (moveT && !moveB) T = B - th;
      else if (moveB) B = T + th;
      else T = B - th;
      h = B - T;
      guideY = moveB ? B : T;
    }
  }

  // Keep aspect when dragging a corner (source pixel AR when available)
  if (corner) {
    w = R - L; h = B - T;
    let aspect = Math.max(start.scaleW / Math.max(start.scaleH, 1e-6), 0.05);
    if (item.w && item.h) {
      const stage = $("#stage");
      const sw = stage ? (stage.clientWidth || 1) : 1;
      const sh = stage ? (stage.clientHeight || 1) : 1;
      aspect = Math.max((item.w / Math.max(item.h, 1e-6)) * sh / sw, 0.05);
    }
    if (Math.abs(w / h - aspect) > 0.001) {
      // Prefer the dimension that was snapped / moved more
      const preferW = guideX != null || Math.abs((R - L) - (start.R - start.L)) >= Math.abs((B - T) - (start.B - start.T));
      if (preferW) {
        h = w / aspect;
        if (moveB && !moveT) B = T + h;
        else if (moveT && !moveB) T = B - h;
        else { B = T + h; }
      } else {
        w = h * aspect;
        if (moveR && !moveL) R = L + w;
        else if (moveL && !moveR) L = R - w;
        else { R = L + w; }
      }
    }
  }

  item.scaleW = clamp(R - L, minW, MAX_BOX_SCALE);
  item.scaleH = clamp(B - T, minH, MAX_BOX_SCALE);
  applyItemPos(item, (L + R) / 2, (T + B) / 2);
  item.scale = item.scaleW;

  // When size matched, draw both edges of our box so you see the match
  const linesX = [];
  const linesY = [];
  if (guideX != null) linesX.push(guideX);
  if (guideY != null) linesY.push(guideY);
  // If width matched another object, also highlight opposite edge
  if ((moveL || moveR) && widths.some((tw) => Math.abs(item.scaleW - tw) < tolX * 1.5)) {
    linesX.push(item.x - item.scaleW / 2, item.x + item.scaleW / 2);
  }
  if ((moveT || moveB) && heights.some((th) => Math.abs(item.scaleH - th) < tolY * 1.5)) {
    linesY.push(item.y - item.scaleH / 2, item.y + item.scaleH / 2);
  }
  showCanvasGuidesMulti(linesX, linesY);
}

function showCanvasGuidesMulti(xs, ys) {
  renderGuideLayer(xs, ys);
}

function ensureCanvasGuides() {
  if (!state.canvas.guides || typeof state.canvas.guides !== "object") {
    state.canvas.guides = { v: [], h: [] };
  }
  if (!Array.isArray(state.canvas.guides.v)) state.canvas.guides.v = [];
  if (!Array.isArray(state.canvas.guides.h)) state.canvas.guides.h = [];
  if (!state.canvas.guideColor) state.canvas.guideColor = "#22d3ee";
  if (state.canvas.showRulers == null) state.canvas.showRulers = true;
}

function applyGuideColor() {
  ensureCanvasGuides();
  const c = normHex(state.canvas.guideColor || "#22d3ee");
  state.canvas.guideColor = c;
  document.documentElement.style.setProperty("--guide-color", c);
  const inp = $("#guideColor");
  if (inp && inp.value !== c) inp.value = c;
}

function applyRulerVisibility() {
  ensureCanvasGuides();
  const on = state.canvas.showRulers !== false;
  const board = $("#stageBoard");
  if (board) board.classList.toggle("noRulers", !on);
  const tog = $("#rulerToggle");
  if (tog) tog.checked = on;
  // Re-layout stage after chrome change
  requestAnimationFrame(() => {
    paintStageRulers();
    layoutVideo();
  });
}

function persistRulerPrefs() {
  try {
    localStorage.setItem("veRulers", JSON.stringify({
      showRulers: state.canvas.showRulers !== false,
      guideColor: state.canvas.guideColor || "#22d3ee",
    }));
  } catch (e) {}
}

function loadRulerPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem("veRulers") || "{}");
    if (typeof saved.showRulers === "boolean") state.canvas.showRulers = saved.showRulers;
    if (saved.guideColor) state.canvas.guideColor = normHex(saved.guideColor);
  } catch (e) {}
}

function renderUserGuides() {
  applyGuideColor();
  renderGuideLayer([], []);
}

function renderGuideLayer(snapXs, snapYs, preview) {
  const layer = $("#guideLayer");
  if (!layer) return;
  layer.innerHTML = "";
  ensureCanvasGuides();
  const guideClass = (v) => {
    if (Math.abs(v - 0.5) < 1e-4) return " center";
    if (Math.abs(v) < 1e-4 || Math.abs(v - 1) < 1e-4) return " frame";
    return "";
  };
  const edgePos = (v) => {
    if (Math.abs(v) < 1e-4) return "0px";
    if (Math.abs(v - 1) < 1e-4) return "calc(100% - 1px)";
    return (v * 100) + "%";
  };
  const addLine = (axis, val, extraClass, userIndex) => {
    if (val == null || !Number.isFinite(val)) return;
    const el = document.createElement("div");
    el.className = "guideLine " + (axis === "v" ? "v" : "h") + (extraClass || "");
    if (axis === "v") el.style.left = edgePos(val);
    else el.style.top = edgePos(val);
    if (userIndex != null) {
      el.dataset.guideAxis = axis;
      el.dataset.guideIndex = String(userIndex);
      el.title = "Drag to move · drag onto ruler to delete · double-click to remove";
    }
    layer.appendChild(el);
  };
  state.canvas.guides.v.forEach((x, i) => addLine("v", x, " user", i));
  state.canvas.guides.h.forEach((y, i) => addLine("h", y, " user", i));
  const seenX = new Set(), seenY = new Set();
  for (const gx of snapXs || []) {
    if (gx == null) continue;
    const k = +gx.toFixed(4);
    if (seenX.has(k)) continue;
    seenX.add(k);
    addLine("v", gx, guideClass(gx));
  }
  for (const gy of snapYs || []) {
    if (gy == null) continue;
    const k = +gy.toFixed(4);
    if (seenY.has(k)) continue;
    seenY.add(k);
    addLine("h", gy, guideClass(gy));
  }
  if (preview) {
    if (preview.axis === "v") addLine("v", preview.val, " preview");
    if (preview.axis === "h") addLine("h", preview.val, " preview");
  }
}

function pointerOverStage(e) {
  const stage = $("#stage");
  if (!stage) return false;
  const r = stage.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function pointerOverRulerBand(e, axis) {
  // Treat the matching ruler wrap (and corner) as the "delete" zone
  const rh = $("#rulerHWrap");
  const rv = $("#rulerVWrap");
  const corner = $("#rulerCorner");
  const hit = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  if (hit(corner)) return true;
  if (axis === "h") return hit(rh);
  if (axis === "v") return hit(rv);
  return hit(rh) || hit(rv);
}

function commitGuideGesture(e) {
  ensureCanvasGuides();
  if (!gesture) return;
  if (gesture.kind === "place-guide-h" || gesture.kind === "move-guide-h") {
    const y = clamp(gesture.y, 0, 1);
    const kill = !pointerOverStage(e) || pointerOverRulerBand(e, "h");
    if (gesture.kind === "place-guide-h") {
      if (!kill) state.canvas.guides.h.push(+y.toFixed(4));
    } else {
      if (kill) state.canvas.guides.h.splice(gesture.index, 1);
      else state.canvas.guides.h[gesture.index] = +y.toFixed(4);
    }
  } else if (gesture.kind === "place-guide-v" || gesture.kind === "move-guide-v") {
    const x = clamp(gesture.x, 0, 1);
    const kill = !pointerOverStage(e) || pointerOverRulerBand(e, "v");
    if (gesture.kind === "place-guide-v") {
      if (!kill) state.canvas.guides.v.push(+x.toFixed(4));
    } else {
      if (kill) state.canvas.guides.v.splice(gesture.index, 1);
      else state.canvas.guides.v[gesture.index] = +x.toFixed(4);
    }
  }
  gesture = null;
  renderUserGuides();
}

function boxStart(item) {
  return {
    L: item.x - item.scaleW / 2,
    R: item.x + item.scaleW / 2,
    T: item.y - item.scaleH / 2,
    B: item.y + item.scaleH / 2,
    scaleW: item.scaleW,
    scaleH: item.scaleH,
  };
}

function syncSizeInputs(item, wId, hId) {
  setRangeNum(wId, item.scaleW, 2);
  setRangeNum(hId, item.scaleH, 2);
}
let builtinLuts = [];
fetch("/api/luts").then((r) => r.json()).then((j) => {
  if (j.ok) { builtinLuts = j.luts || []; if ($("#inspector")) renderInspector(); }
}).catch(() => {});

function uid() { return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function normDeg(d) {
  d = Number(d) || 0;
  d = ((d % 360) + 360) % 360;
  return Math.round(d * 10) / 10;
}
function snapDeg(d) {
  const n = normDeg(d);
  for (const t of [0, 90, 180, 270]) {
    const diff = Math.min(Math.abs(n - t), 360 - Math.abs(n - t));
    if (diff <= 8) return t;
  }
  return n;
}
function applyRotateSnap(d) {
  return state.snapRotate ? snapDeg(d) : normDeg(d);
}
/** Next free track id — used when peeling a brand-new lane. */
function nextTrackId(items) {
  let max = -1;
  for (const it of items) {
    if (typeof it.track === "number") max = Math.max(max, it.track);
  }
  return max + 1;
}
/** [start, end] on the timeline for timed overlays / media items. */
function timedSpan(it) {
  if (it == null) return [0, 0.05];
  if (it.offset != null && it.durn == null && (it.in != null || it.out != null)) {
    const a = it.offset || 0;
    return [a, a + itemLen(it)];
  }
  const a = it.start != null ? Number(it.start) || 0 : (it.offset || 0);
  const d = it.durn != null ? Number(it.durn) || 0.05 : itemLen(it);
  return [a, a + Math.max(0.05, d)];
}
function mediaSpan(it) {
  const a = it.offset || 0;
  return [a, a + itemLen(it)];
}
function rangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 - 1e-4 && b0 < a1 - 1e-4;
}
/**
 * Lowest track where `item` does not overlap others (same kind).
 * Lets many texts/images share one lane when their times don't collide.
 */
function findPackTrack(items, item, excludeI, getSpan) {
  getSpan = getSpan || timedSpan;
  const [a0, a1] = getSpan(item);
  const byTrack = new Map();
  let maxT = -1;
  items.forEach((it, i) => {
    if (i === excludeI) return;
    const t = typeof it.track === "number" ? it.track : 0;
    maxT = Math.max(maxT, t);
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t).push(it);
  });
  for (let t = 0; t <= Math.max(0, maxT); t++) {
    const list = byTrack.get(t) || [];
    if (!list.some((it) => {
      const s = getSpan(it);
      return rangesOverlap(a0, a1, s[0], s[1]);
    })) return t;
  }
  return maxT + 1;
}
function assignPackedTrack(items, item, excludeI, getSpan) {
  item.track = findPackTrack(items, item, excludeI, getSpan);
  return item.track;
}
/** Keep preferTrack if free at item's time; otherwise pack. */
function preferOrPackTrack(items, item, excludeI, preferTrack, getSpan) {
  getSpan = getSpan || timedSpan;
  const [a0, a1] = getSpan(item);
  const t = typeof preferTrack === "number" ? preferTrack : 0;
  const clash = items.some((it, i) => {
    if (i === excludeI) return false;
    if ((typeof it.track === "number" ? it.track : 0) !== t) return false;
    const s = getSpan(it);
    return rangesOverlap(a0, a1, s[0], s[1]);
  });
  if (!clash) {
    item.track = t;
    return t;
  }
  return assignPackedTrack(items, item, excludeI, getSpan);
}
/** Group item indices by explicit .track (sorted). */
function groupByTrack(items) {
  const map = new Map();
  items.forEach((it, i) => {
    const t = typeof it.track === "number" ? it.track : 0;
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(i);
  });
  return [...map.keys()].sort((a, b) => a - b).map((t) => ({ track: t, idxs: map.get(t) }));
}
/** Assign missing .track so each item is alone (legacy pip/music). */
function ensureItemTracks(items) {
  let next = 0;
  const used = new Set();
  for (const it of items) {
    if (typeof it.track === "number") used.add(it.track);
  }
  for (const it of items) {
    if (typeof it.track === "number") continue;
    while (used.has(next)) next++;
    it.track = next;
    used.add(next);
    next++;
  }
  return items;
}
/** Assign missing .track by packing non-overlapping items onto shared lanes. */
function ensurePackedTracks(items, getSpan) {
  getSpan = getSpan || timedSpan;
  items.forEach((it, i) => {
    if (typeof it.track === "number" && Number.isFinite(it.track)) return;
    it.track = findPackTrack(items, it, i, getSpan);
  });
  return items;
}
function trackUnderPoint(clientX, clientY, prefix) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const lane = el.closest(".lane");
  if (!lane) return null;
  const lid = lane.dataset.lane || "";
  if (!lid.startsWith(prefix)) return null;
  const n = +lid.slice(prefix.length);
  return Number.isFinite(n) ? { kind: "track", track: n } : null;
}

function laneIdUnderPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const lane = el.closest(".lane");
  return lane ? (lane.dataset.lane || null) : null;
}

function clipTrack(c) {
  return typeof c.track === "number" && Number.isFinite(c.track) ? c.track : 0;
}

function ensureClipTracks() {
  for (const c of state.clips) {
    if (typeof c.track !== "number" || !Number.isFinite(c.track)) c.track = 0;
  }
  return state.clips;
}

function videoLaneId(track) {
  return "video-" + (typeof track === "number" ? track : 0);
}

const state = {
  clips: [],   // {mid,path,name,dur,in,out,speed,rotate,flipH,flipV,mute,volume,denoise,fadeIn,fadeOut,adj,trans,w,h,has_audio}
  music: [],   // {uid,mid,path,name,dur,in,out,offset,volume,fadeIn,fadeOut,track}
  pips: [],    // video overlays + explicit track (new adds always get a new track)
  texts: [],   // {text,font,size,color,stroke,strokeW,box,boxColor,boxAlpha,shadow,opacity,x,y,start,durn}
  shapes: [],  // {kind,x,y,scaleW,scaleH,rotate,fill,color,border,borderColor,borderW,opacity,start,durn}
  images: [],  // {mid,path,name,x,y,scale,opacity,start,durn}
  subs: {
    style: { font: "Arial", size: 0.055, color: "#ffffff", stroke: "#000000", strokeW: 2, box: true, boxColor: "#000000", boxAlpha: 0.55, shadow: false, shadowColor: "#000000", opacity: 1, y: 0.92 },
    entries: [],  // {text,start,durn}
  },
  fonts: [],   // {id,family,path,name}
  bin: [],     // media library {mid,kind,name,path,duration,width,height,has_audio}
  canvas: { preset: "auto", w: 1920, h: 1080, mode: "fit", bg: "#000000", lut: null, guides: { v: [], h: [] }, guideColor: "#22d3ee", showRulers: true },
  t: 0,
  playing: false,
  sel: null,   // {type:'clip'|'music'|'text'|'image', i}
  zoom: 1,
  trackH: 1,
  tlH: 200,
  laneH: {},      // laneId -> height px
  laneFlags: {},  // laneId -> { lock, hide, mute }
  leftPane: 260,
  rightPane: 300,
  leftHidden: false,
  rightHidden: false,
  snapRotate: true,
  binFilter: "all",
  binSel: null,
};

const audioCache = {};   // mid -> Audio element
const pipVideoCache = {};  // uid -> <video>
let pps = 50;
let activeClip = -1;
let gesture = null;
let undoStack = [];
let redoStack = [];

/* ---------- helpers ---------- */

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
function fmtClock(t, withTenth) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const core = `${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  const head = h ? String(h).padStart(2, "0") + ":" : "";
  if (withTenth) return head + core + "." + Math.floor((s % 1) * 10);
  return head + core;
}
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/**
 * Clamp item center for free layout / reel reframing.
 * When the box is larger than the stage on an axis, allow the center outside
 * 0…1 so you can pan (cover-crop). When smaller, keep the center on-stage.
 */
function clampItemPos(item, x, y) {
  const sw = Math.max(0.05, Number(item && item.scaleW) || 1);
  const sh = Math.max(0.05, Number(item && item.scaleH) || 1);
  let minX, maxX, minY, maxY;
  if (sw >= 1) {
    minX = 1 - sw / 2;
    maxX = sw / 2;
  } else {
    minX = 0;
    maxX = 1;
  }
  if (sh >= 1) {
    minY = 1 - sh / 2;
    maxY = sh / 2;
  } else {
    minY = 0;
    maxY = 1;
  }
  return {
    x: clamp(x, Math.min(minX, maxX), Math.max(minX, maxX)),
    y: clamp(y, Math.min(minY, maxY), Math.max(minY, maxY)),
  };
}

function applyItemPos(item, x, y) {
  const p = clampItemPos(item, x, y);
  item.x = p.x;
  item.y = p.y;
  return p;
}

function clipLen(c) { return Math.max(0.05, (c.out - c.in) / (c.speed || 1)); }
function itemLen(m) { return Math.max(0.05, m.out - m.in); }
/** Linear fade envelope for preview (0–1). localT = time within the item. */
function fadeGain(item, localT, len) {
  const fi = Math.max(0, Number(item && item.fadeIn) || 0);
  const fo = Math.max(0, Number(item && item.fadeOut) || 0);
  const t = Math.max(0, localT);
  const L = Math.max(0.05, len || 0.05);
  let g = 1;
  if (fi > 0.001) g = Math.min(g, t >= fi ? 1 : t / fi);
  if (fo > 0.001) g = Math.min(g, t <= L - fo ? 1 : Math.max(0, (L - t) / fo));
  return clamp(g, 0, 1);
}
function transDur(c, next) {
  if (!c || !c.trans || c.trans.type === "none" || !next) return 0;
  return clamp(c.trans.dur || 0.5, 0, Math.min(clipLen(c), clipLen(next)) * 0.45);
}
/** Assign timeline offsets to clips that lack them (legacy sequential packs). */
function ensureClipOffsets() {
  if (!state.clips.length) return;
  const missing = state.clips.filter((c) => c.offset == null || !Number.isFinite(+c.offset));
  if (missing.length === state.clips.length) {
    let acc = 0;
    for (let i = 0; i < state.clips.length; i++) {
      state.clips[i].offset = acc;
      acc += clipLen(state.clips[i]);
      if (i < state.clips.length - 1) acc -= transDur(state.clips[i], state.clips[i + 1]);
    }
    return;
  }
  let end = 0;
  for (const c of state.clips) {
    if (c.offset != null && Number.isFinite(+c.offset)) {
      c.offset = Math.max(0, +c.offset);
      end = Math.max(end, c.offset + clipLen(c));
    }
  }
  for (const c of state.clips) {
    if (c.offset == null || !Number.isFinite(+c.offset)) {
      c.offset = end;
      end += clipLen(c);
    }
  }
}
function clipStarts() {
  ensureClipOffsets();
  return state.clips.map((c) => c.offset || 0);
}
function mainClipsEnd() {
  if (!state.clips.length) return 0;
  ensureClipOffsets();
  let end = 0;
  for (const c of state.clips) end = Math.max(end, (c.offset || 0) + clipLen(c));
  return end;
}
function totalDur() {
  let end = mainClipsEnd();
  for (const m of state.music) end = Math.max(end, m.offset + itemLen(m));
  for (const p of state.pips) end = Math.max(end, p.offset + itemLen(p));
  for (const x of state.texts) end = Math.max(end, x.start + x.durn);
  for (const x of state.shapes) end = Math.max(end, x.start + x.durn);
  for (const x of state.images) end = Math.max(end, x.start + x.durn);
  for (const x of state.subs.entries) end = Math.max(end, x.start + x.durn);
  return end;
}
function locate(t) {
  ensureClipOffsets();
  ensureClipTracks();
  // Highest video track covering t wins (upper lanes sit on top).
  let best = null;
  let bestTrack = -Infinity;
  for (let i = 0; i < state.clips.length; i++) {
    const c = state.clips[i];
    if (isLaneHidden(videoLaneId(clipTrack(c)))) continue;
    const s = c.offset || 0;
    const len = clipLen(c);
    // Half-open [start, end) so the playhead leaves the clip at clipLen.
    if (t >= s - 1e-6 && t < s + len - 1e-9) {
      const tr = clipTrack(c);
      if (tr >= bestTrack) {
        bestTrack = tr;
        best = { i, local: clamp(t - s, 0, len) };
      }
    }
  }
  return best;
}
/** True when playhead is past the last main clip but timeline still has overlays/music. */
function pastMainVideo(t = state.t) {
  if (!state.clips.length) return false;
  const mainEnd = mainClipsEnd();
  return t >= mainEnd - 0.02 && contentEnd() > mainEnd + 0.05;
}
function contentEnd() {
  return Math.max(totalDur(), 0);
}
function canExport() {
  return !!(state.clips.length || state.music.length || state.images.length || state.texts.length || state.shapes.length || state.pips.length || state.subs.entries.length);
}
function getAudio(m) {
  const key = m.uid || m.mid;
  if (!audioCache[key]) {
    audioCache[key] = new Audio("/media/" + m.mid);
    audioCache[key].preload = "auto";
  }
  return audioCache[key];
}
/** Fully stop a media element so its decoder and HTTP connection are freed. */
function releaseMediaEl(el) {
  if (!el) return;
  try { el.pause(); } catch (_) {}
  try { el.removeAttribute("src"); el.load(); } catch (_) {}
  if (el.parentNode) el.parentNode.removeChild(el);
}
/**
 * Free players for items that no longer exist (deleted, split, undone).
 * WebView2 allows only 6 connections to the local server; leaked players
 * hold them open until the main video can no longer load.
 */
function gcMediaCaches() {
  const liveAudio = new Set(state.music.map((m) => m.uid || m.mid));
  for (const key of Object.keys(audioCache)) {
    if (!liveAudio.has(key)) { releaseMediaEl(audioCache[key]); delete audioCache[key]; }
  }
  const livePip = new Set(state.pips.map((p) => p.uid));
  for (const key of Object.keys(pipVideoCache)) {
    if (!livePip.has(key)) { releaseMediaEl(pipVideoCache[key]); delete pipVideoCache[key]; }
  }
}

/* ---------- undo / redo ---------- */

function serialize() {
  return JSON.stringify({
    clips: state.clips, music: state.music, pips: state.pips, texts: state.texts,
    shapes: state.shapes, images: state.images, subs: state.subs, canvas: state.canvas,
  });
}
function pushUndo() {
  undoStack.push(serialize());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
function restore(json) {
  const s = JSON.parse(json);
  state.clips = s.clips; state.music = s.music; state.texts = s.texts;
  state.shapes = s.shapes || [];
  state.images = s.images; state.canvas = s.canvas;
  ensureCanvasGuides();
  applyGuideColor();
  applyRulerVisibility();
  state.pips = s.pips || [];
  if (s.subs) state.subs = s.subs;
  state.sel = null;
  state.t = clamp(state.t, 0, totalDur());
  refresh();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(serialize());
  restore(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(serialize());
  restore(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $("#undoBtn").disabled = !undoStack.length;
  $("#redoBtn").disabled = !redoStack.length;
}

/* ---------- media loading ---------- */

function pickMedia(kind) {
  return fetch("/api/pick?kind=" + kind).then((r) => r.json()).then((j) => {
    if (!j.ok) { if (j.error) alert(j.error); return; }
    pushUndo();
    addMediaInfo(j.media, kind);
  });
}

function rememberBin(m, kind) {
  const k = kind === "pip" ? "video" : (m.kind || kind);
  if (state.bin.some((b) => b.path === m.path || b.mid === m.id)) {
    const existing = state.bin.find((b) => b.path === m.path || b.mid === m.id);
    if (existing && m.id) existing.mid = m.id;
    renderBin();
    return existing;
  }
  const item = {
    mid: m.id, kind: k, name: m.name, path: m.path,
    duration: m.duration || 0, width: m.width, height: m.height, has_audio: m.has_audio,
    entries: m.entries || null,
  };
  state.bin.push(item);
  renderBin();
  return item;
}

function addMediaInfo(m, kind, opts) {
  rememberBin(m, kind);
  if (kind === "video") {
    ensureClipOffsets();
    state.clips.push({
      mid: m.id, path: m.path, name: m.name, dur: m.duration, in: 0, out: m.duration,
      offset: state.clips.length ? mainClipsEnd() : Math.max(0, state.t),
      track: (opts && opts.track != null) ? opts.track : 0,
      speed: 1, rotate: 0, flipH: false, flipV: false, mute: false, volume: 1, denoise: false,
      fadeIn: 0, fadeOut: 0, adj: { ...DEFAULT_ADJ }, trans: { type: "none", dur: 0.5 },
      x: 0.5, y: 0.5, scale: 1, scaleW: 1, scaleH: 1, cornerRadius: 0,
      w: m.width || 16, h: m.height || 9, has_audio: m.has_audio,
    });
    state.sel = { type: "clip", i: state.clips.length - 1 };
    if (state.clips.length === 1) state.t = 0;
  } else if (kind === "audio") {
    const item = {
      uid: uid(),
      mid: m.id, path: m.path, name: m.name, dur: m.duration, in: 0, out: m.duration,
      offset: 0, volume: 1, fadeIn: 0, fadeOut: 0,
      track: 0,
    };
    if (opts && opts.track != null) item.track = opts.track;
    else assignPackedTrack(state.music, item, -1, mediaSpan);
    getAudio(item);
    state.music.push(item);
    state.sel = { type: "music", i: state.music.length - 1 };
  } else if (kind === "image") {
    const musicEnd = state.music.reduce((e, m) => Math.max(e, m.offset + itemLen(m)), 0);
    const defaultDurn = Math.max(5, musicEnd - state.t, totalDur() - state.t || 0, 5);
    const full = !state.clips.length;
    const nw = m.width || 16, nh = m.height || 9;
    const box = naturalBox(full ? 1 : 0.2, nw, nh);
    const item = {
      mid: m.id, path: m.path, name: m.name,
      x: 0.5, y: 0.5, ...box, opacity: 1,
      border: false, borderColor: "#ffffff", borderW: 4, rotate: 0, cornerRadius: 0,
      start: state.t, durn: defaultDurn,
      w: nw, h: nh,
      track: 0,
    };
    if (opts && opts.track != null) item.track = opts.track;
    else assignPackedTrack(state.images, item, -1, timedSpan);
    state.images.push(item);
    state.sel = { type: "image", i: state.images.length - 1 };
  } else if (kind === "pip") {
    const nw = m.width || 16, nh = m.height || 9;
    const box = naturalBox(0.28, nw, nh);
    const item = {
      uid: uid(),
      mid: m.id, path: m.path, name: m.name, dur: m.duration, in: 0, out: m.duration,
      offset: state.t, x: 0.82, y: 0.82, ...box, opacity: 1,
      border: false, borderColor: "#ffffff", borderW: 4, rotate: 0, cornerRadius: 0,
      volume: 1, mute: false, has_audio: m.has_audio,
      w: nw, h: nh,
      track: 0,
    };
    if (opts && opts.track != null) item.track = opts.track;
    else assignPackedTrack(state.pips, item, -1, mediaSpan);
    state.pips.push(item);
    state.sel = { type: "pip", i: state.pips.length - 1 };
  }
  refresh();
}

/** Convert a main-track video clip into a PiP overlay (inset by default if full-frame). */
function clipToPip(clipIndex, opts) {
  opts = opts || {};
  const c = state.clips[clipIndex];
  if (!c) return null;
  ensureClipLayout(c);
  ensureClipOffsets();
  const keepLayout = opts.keepLayout != null ? opts.keepLayout : !isFullFrame(c);
  const box = naturalBox(0.28, c.w || 16, c.h || 9);
  const pip = {
    uid: uid(),
    mid: c.mid, path: c.path, name: c.name, dur: c.dur,
    in: c.in, out: c.out,
    offset: c.offset || 0,
    x: keepLayout ? c.x : 0.82,
    y: keepLayout ? c.y : 0.82,
    scaleW: keepLayout ? c.scaleW : box.scaleW,
    scaleH: keepLayout ? c.scaleH : box.scaleH,
    scale: keepLayout ? (c.scaleW != null ? c.scaleW : c.scale) : box.scaleW,
    opacity: 1,
    border: false, borderColor: "#ffffff", borderW: 4,
    rotate: c.rotate || 0, cornerRadius: c.cornerRadius || 0,
    volume: c.volume != null ? c.volume : 1,
    mute: !!c.mute,
    has_audio: c.has_audio,
    w: c.w, h: c.h,
    track: 0,
  };
  if (opts.track != null) preferOrPackTrack(state.pips, pip, -1, opts.track, mediaSpan);
  else assignPackedTrack(state.pips, pip, -1, mediaSpan);

  if (state.sel && state.sel.type === "clip") {
    if (state.sel.i === clipIndex) state.sel = null;
    else if (state.sel.i > clipIndex) state.sel.i--;
  }
  if (activeClip === clipIndex) activeClip = -1;
  else if (activeClip > clipIndex) activeClip--;
  state.clips.splice(clipIndex, 1);
  state.pips.push(pip);
  state.sel = { type: "pip", i: state.pips.length - 1 };
  return pip;
}

/** Convert a PiP overlay back into a main video-track clip. */
function pipToClip(pipIndex, opts) {
  opts = opts || {};
  const p = state.pips[pipIndex];
  if (!p) return null;
  ensureClipOffsets();
  const clip = {
    mid: p.mid, path: p.path, name: p.name, dur: p.dur,
    in: p.in, out: p.out,
    offset: p.offset || 0,
    track: opts.track != null ? opts.track : 0,
    speed: 1, rotate: p.rotate || 0, flipH: false, flipV: false,
    mute: !!p.mute, volume: p.volume != null ? p.volume : 1, denoise: false,
    fadeIn: 0, fadeOut: 0, adj: { ...DEFAULT_ADJ },
    trans: { type: "none", dur: 0.5 },
    x: p.x != null ? p.x : 0.5,
    y: p.y != null ? p.y : 0.5,
    scale: p.scaleW != null ? p.scaleW : 1,
    scaleW: p.scaleW != null ? p.scaleW : 1,
    scaleH: p.scaleH != null ? p.scaleH : 1,
    cornerRadius: p.cornerRadius || 0,
    w: p.w, h: p.h, has_audio: p.has_audio,
  };
  if (opts.fullFrame) {
    clip.x = 0.5; clip.y = 0.5; clip.scaleW = 1; clip.scaleH = 1; clip.scale = 1;
  }
  if (pipVideoCache[p.uid]) {
    releaseMediaEl(pipVideoCache[p.uid]);
    delete pipVideoCache[p.uid];
  }
  if (state.sel && state.sel.type === "pip") {
    if (state.sel.i === pipIndex) state.sel = null;
    else if (state.sel.i > pipIndex) state.sel.i--;
  }
  state.pips.splice(pipIndex, 1);
  state.clips.push(clip);
  state.sel = { type: "clip", i: state.clips.length - 1 };
  return clip;
}

function binAsMedia(b) {
  return { id: b.mid, name: b.name, path: b.path, duration: b.duration, width: b.width, height: b.height, has_audio: b.has_audio, kind: b.kind };
}

function addFromBin(b, dest, opts) {
  if (b.kind === "srt") {
    pushUndo();
    const raw = b.entries;
    if (!raw || !raw.length) {
      alert("That subtitle file has no entries. Re-import the .srt file.");
      return;
    }
    applySrtEntries(raw);
    refresh();
    return;
  }
  const kind = dest || b.kind;
  if (kind === "audio" && b.kind !== "audio") return;
  if (kind === "image" && b.kind !== "image") return;
  if ((kind === "video" || kind === "pip") && b.kind !== "video") return;
  pushUndo();
  addMediaInfo(binAsMedia(b), kind, opts || {});
}

function renderBin() {
  const grid = $("#mediaGrid");
  if (!grid) return;
  const items = state.bin.filter((b) => state.binFilter === "all" || b.kind === state.binFilter);
  if (!items.length) {
    grid.innerHTML = `<div class="mediaEmpty">${state.bin.length ? "Nothing in this filter." : "Drop video, audio, images or .srt here<br>— or click <b>Import</b>.<br>Then drag clips onto the timeline."}</div>`;
    return;
  }
  grid.innerHTML = "";
  items.forEach((b) => {
    const card = document.createElement("div");
    card.className = "mediaCard" + (state.binSel === b.mid ? " sel" : "");
    // HTML5 DnD is unreliable in WebView2 (VideoEditor.exe). Use pointer drag instead.
    card.draggable = false;
    const dur = (b.kind === "image") ? "" : fmtClock(b.duration);
    const thumb = b.kind === "srt"
      ? `<div class="thumb srt">CC</div>`
      : `<img class="thumb ${b.kind}" draggable="false" src="/api/thumb?mid=${encodeURIComponent(b.mid)}" alt="">`;
    card.innerHTML = `
      ${thumb}
      ${dur ? `<span class="dur">${dur}</span>` : ""}
      <div class="cname" title="${b.name}">${b.name}</div>
      <div class="actions">
        <button class="btn sm" data-act="add">${b.kind === "srt" ? "Use" : "Add"}</button>
        ${b.kind === "video" ? `<button class="btn sm" data-act="ov">Overlay</button>` : ""}
        <button class="btn sm" data-act="rm" title="Remove from library">✕</button>
      </div>`;
    card.onclick = (e) => {
      if (e.target.closest("button")) return;
      state.binSel = b.mid;
      renderBin();
    };
    card.ondblclick = () => addFromBin(b, b.kind === "video" ? "video" : b.kind);
    card.querySelector("[data-act=add]").onclick = (e) => {
      e.stopPropagation();
      addFromBin(b, b.kind === "video" ? "video" : b.kind);
    };
    const ov = card.querySelector("[data-act=ov]");
    if (ov) ov.onclick = (e) => { e.stopPropagation(); addFromBin(b, "pip"); };
    card.querySelector("[data-act=rm]").onclick = (e) => {
      e.stopPropagation();
      state.bin = state.bin.filter((x) => x.mid !== b.mid);
      if (state.binSel === b.mid) state.binSel = null;
      renderBin();
    };
    // Pointer drag — works in browsers and WebView2 / VideoEditor.exe
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      startBinPointerDrag(e, b, card);
    });
    grid.appendChild(card);
  });
}

/* ---------- media → timeline drag (WebView2-safe) ---------- */

let pendingBinDrag = null; // {mid, kind} during HTML5 or pointer drag
let binPtrDrag = null;     // active pointer drag state

function clearBinDragGhost() {
  document.querySelectorAll(".binDragGhost").forEach((el) => el.remove());
  document.body.classList.remove("binDragging");
}

function startBinPointerDrag(e, b, card) {
  const startX = e.clientX;
  const startY = e.clientY;
  const pid = e.pointerId;
  let armed = false;
  const onMove = (ev) => {
    if (ev.pointerId !== pid) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!armed) {
      if (dx * dx + dy * dy < 36) return; // 6px threshold — still a click
      armed = true;
      pendingBinDrag = { mid: b.mid, kind: b.kind };
      binPtrDrag = { mid: b.mid, kind: b.kind, pointerId: pid };
      document.body.classList.add("binDragging");
      const ghost = document.createElement("div");
      ghost.className = "binDragGhost";
      ghost.textContent = b.name || b.kind;
      document.body.appendChild(ghost);
      try { card.setPointerCapture(pid); } catch (err) { /* ignore */ }
    }
    const ghost = document.querySelector(".binDragGhost");
    if (ghost) {
      ghost.style.left = ev.clientX + 12 + "px";
      ghost.style.top = ev.clientY + 12 + "px";
    }
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const overTl = !!(under && under.closest && under.closest("#tlScroll"));
    $("#tlScroll")?.classList.toggle("dropTarget", overTl);
  };
  const onUp = (ev) => {
    if (ev.pointerId !== pid) return;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    try { card.releasePointerCapture(pid); } catch (err) { /* ignore */ }
    const wasArmed = armed;
    const dropX = ev.clientX;
    const dropY = ev.clientY;
    clearBinDragGhost();
    $("#tlScroll")?.classList.remove("dropTarget");
    pendingBinDrag = null;
    binPtrDrag = null;
    if (!wasArmed) return;
    const under = document.elementFromPoint(dropX, dropY);
    const tl = under && under.closest && under.closest("#tlScroll");
    if (!tl) return;
    dropBinAtPoint({ mid: b.mid, kind: b.kind }, dropX, dropY);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

function dropBinAtPoint(data, clientX, clientY) {
  if (!data || !data.mid) return;
  const b = state.bin.find((x) => x.mid === data.mid);
  if (!b) return;
  const under = document.elementFromPoint(clientX, clientY);
  const lane = under && under.closest ? under.closest(".lane") : null;
  let dest = b.kind;
  const lid = (lane && lane.dataset.lane) || "";
  const opts = {};
  if (b.kind === "video") {
    if (lid.startsWith("video-") || lid === "v1") {
      dest = "video";
      opts.track = lid.startsWith("video-") ? +lid.slice(6) : 0;
    } else if (lid.startsWith("pip-")) {
      dest = "pip";
      opts.track = +lid.slice(4);
    } else {
      dest = "video";
      opts.track = 0;
    }
  } else if (b.kind === "srt") dest = "srt";
  else if (b.kind === "audio") {
    dest = "audio";
    if (lid.startsWith("music-")) opts.track = +lid.slice(6);
  }   else if (b.kind === "image") {
    dest = "image";
    if (lid.startsWith("image-")) opts.track = +lid.slice(6);
  }
  addFromBin(b, dest, opts);
}

async function importToBin() {
  const r = await fetch("/api/pick?kind=media");
  const j = await r.json();
  if (!j.ok) { if (j.error) alert(j.error); return; }
  for (const m of j.items || []) rememberBin(m, m.kind);
}

/** Import local files by absolute path (WebView / native drop). */
async function importPaths(paths, opts = {}) {
  const list = (paths || []).map((p) => String(p || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const r = await fetch("/api/import-paths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: list }),
  });
  const j = await r.json();
  if (!j.ok) {
    if (j.error) alert(j.error);
    return [];
  }
  if (!opts.skipUndo) pushUndo();
  const items = j.items || [];
  for (const m of items) rememberBin(m, m.kind);
  if (opts.addToTimeline) {
    for (const m of items) {
      if (m.kind === "srt") {
        applySrtEntries(m.entries || []);
      } else {
        addMediaInfo(m, m.kind, opts.laneOpts || {});
      }
    }
  }
  if (j.errors && j.errors.length) {
    $("#exportStatus").textContent = j.errors.slice(0, 2).join(" · ");
  }
  refresh();
  return items;
}

/** Upload a File blob when the OS path is unavailable (browser / some WebViews). */
async function uploadOneFile(file) {
  const r = await fetch("/api/upload-one", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name || "upload.bin"),
    },
    body: file,
  });
  return r.json();
}

let _nativeDropAt = 0;
window.__veNativeDrop = (paths) => {
  _nativeDropAt = Date.now();
  clearFileDropHighlight();
  importPaths(paths).catch((err) => alert(String(err && err.message || err)));
};

function fileDropHasFiles(e) {
  const types = e.dataTransfer ? [...(e.dataTransfer.types || [])] : [];
  return types.includes("Files") || (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length);
}

function setFileDropHighlight(on) {
  document.body.classList.toggle("fileDropTarget", !!on);
  $("#mediaPane")?.classList.toggle("fileDropTarget", !!on);
}

let _fileDropClearTimer = null;
/** Keep highlight only while dragover keeps firing; clears on cancel / leave. */
function pulseFileDropHighlight() {
  setFileDropHighlight(true);
  if (_fileDropClearTimer) clearTimeout(_fileDropClearTimer);
  _fileDropClearTimer = setTimeout(() => {
    _fileDropClearTimer = null;
    setFileDropHighlight(false);
  }, 180);
}

function clearFileDropHighlight() {
  if (_fileDropClearTimer) {
    clearTimeout(_fileDropClearTimer);
    _fileDropClearTimer = null;
  }
  setFileDropHighlight(false);
}

/**
 * Import files dropped from Explorer / Finder.
 * Prefers real paths; falls back to streaming upload.
 */
async function importOsFileList(fileList, opts = {}) {
  const files = [...(fileList || [])].filter((f) => f && f.name);
  if (!files.length) return;
  const paths = files.map((f) => f.path || f.fileName || "").filter(Boolean);
  if (paths.length === files.length) {
    await importPaths(paths, opts);
    return;
  }
  // Mixed or path-less: upload each (and use path when present).
  if (!opts.skipUndo) pushUndo();
  const status = $("#exportStatus");
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (status) status.textContent = `Importing ${i + 1}/${files.length}…`;
    try {
      if (file.path) {
        await importPaths([file.path], { skipUndo: true, addToTimeline: opts.addToTimeline, laneOpts: opts.laneOpts });
        continue;
      }
      const j = await uploadOneFile(file);
      if (!j.ok) {
        if (j.error) alert(j.error);
        continue;
      }
      const m = j.item;
      rememberBin(m, m.kind);
      if (opts.addToTimeline) {
        if (m.kind === "srt") applySrtEntries(m.entries || []);
        else addMediaInfo(m, m.kind, opts.laneOpts || {});
      }
    } catch (err) {
      alert(String(err && err.message || err));
    }
  }
  if (status) status.textContent = "";
  refresh();
}

function bindOsFileDrop() {
  const onDragOver = (e) => {
    if (!fileDropHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    pulseFileDropHighlight();
  };
  const onDragLeave = (e) => {
    // relatedTarget is null when the cursor leaves the window (cancel / drag away).
    const to = e.relatedTarget;
    if (!to || to === document.documentElement || to === document.body) {
      clearFileDropHighlight();
    }
  };
  const onDrop = async (e) => {
    if (!fileDropHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearFileDropHighlight();
    // Native WebView drop may also fire — ignore duplicate HTML5 drop.
    if (Date.now() - _nativeDropAt < 500) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const onTimeline = !!(under && under.closest && under.closest("#tlScroll, #timeline"));
    await importOsFileList(files, { addToTimeline: onTimeline });
  };
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  // Escape / cancelled OS drag — these fire on the page even when source is Explorer.
  window.addEventListener("dragend", clearFileDropHighlight);
  window.addEventListener("blur", clearFileDropHighlight);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearFileDropHighlight();
  });
}

function addText() {
  pushUndo();
  const size = 0.08;
  const item = {
    text: "Your text", font: "Arial Bold", size,
    color: "#ffffff", stroke: "#000000", strokeW: 2,
    box: false, boxColor: "#000000", boxAlpha: 0.5, shadow: true, shadowColor: "#000000",
    opacity: 1, x: 0.5, y: 0.82, rotate: 0,
    scaleW: 0.55, scaleH: size * TEXT_H_FROM_SIZE,
    start: state.t, durn: 3,
  };
  assignPackedTrack(state.texts, item, -1, timedSpan);
  state.texts.push(item);
  state.sel = { type: "text", i: state.texts.length - 1 };
  refresh();
}

const SHAPE_KINDS = [
  { id: "rect", label: "Rectangle" },
  { id: "roundrect", label: "Rounded" },
  { id: "ellipse", label: "Ellipse" },
  { id: "triangle", label: "Triangle" },
  { id: "diamond", label: "Diamond" },
  { id: "star", label: "Star" },
  { id: "arrow", label: "Arrow" },
  { id: "line", label: "Line" },
  { id: "linearrow", label: "Line arrow" },
];

const LINE_STYLES = [
  { id: "solid", label: "Solid" },
  { id: "dashed", label: "Dashed" },
  { id: "dotted", label: "Dotted" },
];

function isLineShape(kind) {
  return kind === "line" || kind === "linearrow";
}

function shapeLabel(kind) {
  return (SHAPE_KINDS.find((s) => s.id === kind) || { label: "Shape" }).label;
}

function lineDashArray(style, swPx) {
  const w = Math.max(1, swPx || 2);
  if (style === "dashed") return `${Math.max(8, w * 4)} ${Math.max(5, w * 2.5)}`;
  if (style === "dotted") return `${Math.max(1, w)} ${Math.max(4, w * 2.5)}`;
  return "";
}

function shapePathMarkup(kind) {
  switch (kind) {
    case "roundrect": return `<rect class="shapePath" x="6" y="6" width="88" height="88" rx="16" ry="16"/>`;
    case "ellipse": return `<ellipse class="shapePath" cx="50" cy="50" rx="44" ry="44"/>`;
    case "triangle": return `<polygon class="shapePath" points="50,8 92,90 8,90"/>`;
    case "diamond": return `<polygon class="shapePath" points="50,6 94,50 50,94 6,50"/>`;
    case "star": return `<polygon class="shapePath" points="50,6 61,38 95,38 68,58 78,92 50,72 22,92 32,58 5,38 39,38"/>`;
    case "arrow": return `<polygon class="shapePath" points="8,32 58,32 58,12 94,50 58,88 58,68 8,68"/>`;
    case "line": return `<line class="shapePath" x1="4" y1="50" x2="96" y2="50"/>`;
    case "linearrow":
      // Shaft runs into the chevron apex so there's no gap
      return `<line class="shapePath shapeLine" x1="4" y1="50" x2="92" y2="50"/>`
        + `<polyline class="shapePath shapeHead" points="70,28 92,50 70,72" fill="none"/>`;
    default: return `<rect class="shapePath" x="6" y="6" width="88" height="88"/>`;
  }
}

function buildShapeSvg(sh, sw, shH) {
  const kind = sh.kind || "rect";
  const w = Math.max(8, (sh.scaleW || 0.2) * sw);
  const h = Math.max(isLineShape(kind) ? 4 : 8, (sh.scaleH || 0.15) * shH);
  const lineLike = isLineShape(kind);
  const strokeColor = lineLike
    ? (sh.color || "#5eead4")
    : (sh.border ? (sh.borderColor || "#ffffff") : ((sh.fill === false && !sh.border) ? "#8b93a7" : "none"));
  const fill = lineLike
    ? "none"
    : (sh.fill === false ? "none" : (sh.color || "#5eead4"));
  const ghost = !lineLike && sh.fill === false && !sh.border;
  const swPx = lineLike
    ? Math.max(1, Number(sh.borderW) || 3)
    : (sh.border ? Math.max(1, Number(sh.borderW) || 3) : (ghost ? 2 : 0));
  const useDash = lineLike || sh.border || ghost;
  const dash = useDash
    ? (ghost && !sh.border ? "4 3" : lineDashArray(sh.lineStyle || "solid", swPx))
    : "";
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
  let markup = shapePathMarkup(kind);
  if (kind === "linearrow") {
    // Shaft + open chevron head (>) — both stroked, head never dashed
    markup = markup
      .replace(
        'class="shapePath shapeLine"',
        `class="shapePath shapeLine" fill="none" stroke="${strokeColor}" stroke-width="${swPx}" stroke-linecap="round"${dashAttr}`,
      )
      .replace(
        'class="shapePath shapeHead"',
        `class="shapePath shapeHead" fill="none" stroke="${strokeColor}" stroke-width="${swPx}" stroke-linecap="round" stroke-linejoin="round"`,
      );
  } else {
    markup = markup.replace(
      'class="shapePath"',
      `class="shapePath" fill="${fill}" stroke="${strokeColor}" stroke-width="${swPx}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}`,
    );
  }
  return `<svg viewBox="0 0 100 100" width="${w}" height="${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
}

function addShape(kind) {
  pushUndo();
  const k = kind || "rect";
  const lineLike = isLineShape(k);
  // scaleW/H are fractions of stage W/H — use naturalBox so square designs
  // stay square in pixels on non-1:1 canvases (otherwise they look skewed).
  const box = lineLike
    ? naturalBox(0.42, 8, 1)   // wide thin strip for line / line-arrow
    : naturalBox(0.26, 1, 1);  // square pixel box for all other shapes
  const item = {
    kind: k,
    x: 0.5, y: 0.5,
    ...box,
    rotate: 0,
    fill: lineLike ? false : true,
    color: "#5eead4",
    border: false,
    borderColor: "#ffffff",
    borderW: lineLike ? 3 : 3,
    lineStyle: "solid",
    opacity: 1,
    start: state.t,
    durn: Math.max(3, 5),
  };
  assignPackedTrack(state.shapes, item, -1, timedSpan);
  state.shapes.push(item);
  state.sel = { type: "shape", i: state.shapes.length - 1 };
  refresh();
}

function toggleShapeMenu(show) {
  const menu = $("#shapeMenu");
  if (!menu) return;
  if (show == null) menu.hidden = !menu.hidden;
  else menu.hidden = !show;
}

function addSub() {
  pushUndo();
  state.subs.entries.push({ text: "Subtitle text", start: state.t, durn: 2 });
  state.subs.entries.sort((a, b) => a.start - b.start);
  const i = state.subs.entries.findIndex((e) => e.start === state.t || e.text === "Subtitle text");
  state.sel = { type: "sub", i: Math.max(0, i) };
  refresh();
}

function applySrtEntries(raw) {
  if (!raw || !raw.length) { alert("No subtitles in that file."); return false; }
  const entries = raw.map((e) => {
    const start = e.start;
    const durn = e.durn != null ? e.durn : Math.max(0.2, (e.end ?? start + 2) - start);
    return { text: e.text, start, durn };
  });
  if (state.subs.entries.length && !confirm(`Replace existing ${state.subs.entries.length} subtitle(s) with ${entries.length} imported ones?\n(Cancel appends instead)`)) {
    state.subs.entries.push(...entries);
  } else {
    state.subs.entries = entries;
  }
  state.subs.entries.sort((a, b) => a.start - b.start);
  state.sel = { type: "sub", i: 0 };
  return true;
}

async function importSrt() {
  const r = await fetch("/api/pick?kind=srt");
  const j = await r.json();
  if (!j.ok) { if (j.error) alert(j.error); return; }
  pushUndo();
  applySrtEntries(j.entries);
  refresh();
}

async function pickFont() {
  const r = await fetch("/api/pick?kind=font");
  const j = await r.json();
  if (!j.ok) { if (j.error) alert(j.error); return null; }
  if (!state.fonts.some((f) => f.family === j.font.family)) {
    state.fonts.push(j.font);
    refreshFontFaces();
  }
  return j.font.family;
}

/* test / power-user hook */
window.addMediaByPath = async (path, kind = "video") => {
  const r = await fetch(`/api/pick?kind=${kind}&path=${encodeURIComponent(path)}`);
  const j = await r.json();
  if (j.ok) { pushUndo(); addMediaInfo(j.media, kind); }
  return j;
};
window.ed = { state, refresh: () => refresh(), addText, addSub };
window.addFontByPath = async (path) => {
  const r = await fetch(`/api/pick?kind=font&path=${encodeURIComponent(path)}`);
  const j = await r.json();
  if (j.ok && !state.fonts.some((f) => f.family === j.font.family)) {
    state.fonts.push(j.font);
    refreshFontFaces();
    refresh();
  }
  return j;
};

/* ---------- preview playback ---------- */

function syncPreview(autoplay) {
  const loc = state.clips.length ? locate(state.t) : null;
  if (!loc) {
    video.pause();
    video.removeAttribute("src");
    delete video.dataset.mid;
    // Keep stage clear for canvas/overlays during gaps — don't flash the empty hint
    // if the timeline still has content.
    $("#emptyHint").style.display = canExport() ? "none" : "flex";
    activeClip = -1;
    applyClipFX();
    layoutVideo();
    return;
  }
  $("#emptyHint").style.display = "none";
  const c = state.clips[loc.i];
  activeClip = loc.i;
  const want = c.in + loc.local * (c.speed || 1);
  const apply = () => {
    try { video.currentTime = clamp(want, 0, c.dur || want); } catch (e) {}
    if (autoplay) video.play().catch(() => {});
    else video.pause();
    applyClipFX();
  };
  if (video.dataset.mid !== c.mid) {
    video.dataset.mid = c.mid;
    video.src = "/media/" + c.mid;
    video.onloadedmetadata = apply;
    video.load();
  } else {
    apply();
  }
}

function applyClipFX() {
  const c = state.clips[activeClip];
  layoutVideo();
  const frame = $("#mainFrame");
  const laneId = c ? videoLaneId(clipTrack(c)) : videoLaneId(0);
  if (frame) frame.style.visibility = (!c || isLaneHidden(laneId)) ? "hidden" : "";
  if (!c) { $("#fxTint").style.opacity = 0; $("#fxVignette").style.opacity = 0; return; }
  video.playbackRate = c.speed || 1;
  const loc = locate(state.t);
  const local = (loc && loc.i === activeClip) ? loc.local : 0;
  const gain = fadeGain(c, local, clipLen(c));
  video.volume = (c.mute || isLaneMuted(laneId)) ? 0 : clamp(c.volume * gain, 0, 1);
  const a = c.adj || DEFAULT_ADJ;
  video.style.filter = `brightness(${1 + a.exposure * 0.6}) contrast(${a.contrast}) saturate(${a.saturation})`;
  const tint = $("#fxTint");
  if (Math.abs(a.temperature) > 1) {
    tint.style.background = a.temperature > 0 ? "#ff9a3c" : "#3c78ff";
    tint.style.opacity = Math.abs(a.temperature) / 260;
  } else {
    tint.style.opacity = 0;
  }
  $("#fxVignette").style.opacity = a.vignette ? 1 : 0;
  updateLutStage();
}

let lastFrame = 0;
let stallSince = 0;
/** Drop and re-open the main video source (recovers a stuck load). */
function reloadMainVideo() {
  gcMediaCaches();
  try { video.pause(); } catch (_) {}
  video.removeAttribute("src");
  try { video.load(); } catch (_) {}
  delete video.dataset.mid;
  syncPreview(state.playing);
}
video.addEventListener("error", () => {
  // Next sync re-opens the source instead of waiting on a dead element.
  delete video.dataset.mid;
});
function play() {
  if (contentEnd() <= 0.05) return;
  if (state.t >= contentEnd() - 0.05) state.t = 0;
  state.playing = true;
  lastFrame = 0;
  stallSince = 0;
  if (video.error) delete video.dataset.mid;
  $("#playBtn").textContent = "⏸";
  syncPreview(true);
  requestAnimationFrame(loop);
}
function pause() {
  state.playing = false;
  lastFrame = 0;
  $("#playBtn").textContent = "▶";
  video.pause();
  state.music.forEach((m) => getAudio(m).pause());
  Object.values(pipVideoCache).forEach((v) => v.pause());
}

function loop() {
  if (!state.playing) return;
  const end = contentEnd();
  const now = performance.now();
  ensureClipOffsets();

  const loc = state.clips.length ? locate(state.t) : null;

  if (loc) {
    const c = state.clips[loc.i];
    const off = c.offset || 0;
    const len = clipLen(c);
    const clipEnd = off + len;
    const spd = Math.max(0.05, c.speed || 1);

    if (activeClip !== loc.i || video.dataset.mid !== c.mid) {
      syncPreview(true);
      lastFrame = now;
    } else if (!video.seeking && video.readyState >= 2) {
      // Always map media time → timeline with speed (never free-run wall-clock
      // inside a clip — that raced past the shortened 4× duration).
      if (video.playbackRate !== spd) {
        try { video.playbackRate = spd; } catch (err) { /* ignore */ }
      }
      const mediaT = video.currentTime;
      const reachedOut = video.ended || mediaT >= c.out - 0.05;
      if (reachedOut) {
        state.t = clipEnd + 0.001;
        video.pause();
        lastFrame = now;
        if (locate(state.t)) syncPreview(true);
        else syncPreview(false);
      } else {
        state.t = off + clamp((mediaT - c.in) / spd, 0, len);
        lastFrame = now;
        if (video.paused) video.play().catch(() => {});
      }
    } else {
      // Still loading / seeking — hold playhead; don't advance by wall-clock.
      lastFrame = now;
      if (!stallSince) stallSince = now;
      else if (now - stallSince > 3000) {
        stallSince = 0;
        reloadMainVideo();
      }
    }
    if (video.readyState >= 2 && !video.seeking) stallSince = 0;
  } else {
    // Gap between clips, or only overlays/images left — wall-clock time.
    if (lastFrame) state.t += (now - lastFrame) / 1000;
    lastFrame = now;
    if (!video.paused) video.pause();
    if (locate(state.t)) syncPreview(true);
  }

  if (state.t >= end - 0.01) {
    pause();
    state.t = end;
  }

  musicSync();
  pipSync();
  // Keep clip volume envelope updating while the playhead moves inside a clip.
  const locNow = state.clips.length ? locate(state.t) : null;
  if (locNow && state.clips[locNow.i]) {
    const c = state.clips[locNow.i];
    const laneId = videoLaneId(clipTrack(c));
    const gain = fadeGain(c, locNow.local, clipLen(c));
    video.volume = (c.mute || isLaneMuted(laneId)) ? 0 : clamp(c.volume * gain, 0, 1);
  }
  overlayTick();
  paintPlayhead();
  updateTimeLabel();
  requestAnimationFrame(loop);
}

function getPipVideo(p) {
  let v = pipVideoCache[p.uid];
  if (!v) {
    v = document.createElement("video");
    v.src = "/media/" + p.mid;
    v.preload = "auto";
    v.playsInline = true;
    v.style.pointerEvents = "none";
    v.addEventListener("play", () => {
      if (!state.playing) {
        try { v.pause(); } catch (err) { /* ignore */ }
      }
    });
    pipVideoCache[p.uid] = v;
  }
  return v;
}

function pipSync() {
  state.pips.forEach((p, i) => {
    const v = getPipVideo(p);
    const laneMute = isLaneMuted(laneIdFor("pip", i));
    const laneHide = isLaneHidden(laneIdFor("pip", i));
    const len = itemLen(p);
    const active = !laneHide && state.t >= p.offset - 1e-6 && state.t <= p.offset + len + 1e-6;
    const localT = state.t - p.offset;
    const want = p.in + localT;
    const gain = fadeGain(p, localT, len);
    v.volume = (p.mute || laneMute) ? 0 : clamp(p.volume * gain, 0, 1);
    if (state.playing && active) {
      if (v.paused) {
        try { v.currentTime = want; } catch (e) {}
        v.play().catch(() => {});
      } else if (Math.abs(v.currentTime - want) > 0.35) {
        try { v.currentTime = want; } catch (e) {}
      }
    } else {
      if (!v.paused) v.pause();
      if (active && v.readyState >= 1 && Math.abs(v.currentTime - want) > 0.05) {
        try { v.currentTime = want; } catch (e) {}
      }
    }
  });
}

function musicSync() {
  state.music.forEach((m, i) => {
    const el = getAudio(m);
    const len = itemLen(m);
    const laneMute = isLaneMuted(laneIdFor("music", i));
    const active = state.playing && !laneMute && state.t >= m.offset && state.t < m.offset + len;
    if (active) {
      const localT = state.t - m.offset;
      const want = m.in + localT;
      const gain = fadeGain(m, localT, len);
      el.volume = clamp(m.volume * gain, 0, 1);
      if (el.paused) {
        try { el.currentTime = want; } catch (e) {}
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - want) > 0.35) {
        try { el.currentTime = want; } catch (e) {}
      }
    } else if (!el.paused) {
      el.pause();
    }
  });
}

function setT(t) {
  state.t = clamp(t, 0, Math.max(contentEnd(), 0));
  syncPreview(state.playing);
  if (!state.playing) state.music.forEach((m) => getAudio(m).pause());
  pipSync();
  overlayTick();
  paintPlayhead();
  updateTimeLabel();
}

/* ---------- stage ---------- */

function canvasAspect() {
  const map = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5], "4:3": [4, 3], "3:4": [3, 4] };
  const cv = state.canvas;
  if (cv.preset === "custom") return `${cv.w} / ${cv.h}`;
  if (cv.preset in map) return `${map[cv.preset][0]} / ${map[cv.preset][1]}`;
  const c = state.clips[0];
  if (!c) return "16 / 9";
  // Only reorient the canvas when the main clip fills the frame at 90°/270°.
  // Inset/resized clips rotate in place without changing canvas aspect.
  const r = ((Math.round(c.rotate || 0) % 360) + 360) % 360;
  const swapped = isFullFrame(c) && (r === 90 || r === 270);
  return `${swapped ? c.h : c.w} / ${swapped ? c.w : c.h}`;
}

function layoutVideo() {
  const stage = $("#stage");
  const frame = $("#mainFrame");
  stage.style.aspectRatio = canvasAspect();
  const c = state.clips[activeClip];
  if (!c || !frame) {
    stage.style.background = state.canvas.bg || "#05070a";
    if (frame) {
      frame.style.display = "none";
      frame.classList.remove("sel");
      frame.querySelectorAll(".ovHandle").forEach((h) => h.remove());
    }
    paintStageRulers();
    return;
  }
  ensureClipLayout(c);
  const free = !isFullFrame(c);
  stage.style.background = (free || state.canvas.mode === "fit") ? state.canvas.bg : "#05070a";
  frame.style.display = "";
  const cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  const ar = (c.w || 16) / (c.h || 9);
  const rot = ((c.rotate % 360) + 360) % 360;
  const swapped = !free && (rot === 90 || rot === 270);
  const ar2 = swapped ? 1 / ar : ar;
  const fx = c.flipH ? " scaleX(-1)" : "";
  const fy = c.flipV ? " scaleY(-1)" : "";

  let bw, bh;
  if (free) {
    bw = c.scaleW * cw;
    bh = c.scaleH * ch;
  } else if (state.canvas.mode === "fill") {
    bw = cw; bh = cw / ar2;
    if (bh < ch) { bh = ch; bw = ch * ar2; }
  } else {
    bw = cw; bh = cw / ar2;
    if (bh > ch) { bh = ch; bw = ch * ar2; }
  }
  const vw = free ? bw : (swapped ? bh : bw);
  const vh = free ? bh : (swapped ? bw : bh);
  video.style.width = vw + "px";
  video.style.height = vh + "px";
  // Never stretch pixels — box sizing keeps aspect on corner resize; contain is a safety net.
  video.style.objectFit = "contain";
  video.style.background = "#000";
  // Full-frame: rotate the video (and canvas aspect via canvasAspect).
  // Free layout: rotate the frame so the clip spins without changing the canvas.
  if (free) {
    video.style.transform = `${fx}${fy}`.trim() || "none";
    frame.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
  } else {
    video.style.transform = `rotate(${rot}deg)${fx}${fy}`;
    frame.style.transform = "translate(-50%, -50%)";
  }
  frame.style.left = (c.x * 100) + "%";
  frame.style.top = (c.y * 100) + "%";
  frame.style.width = vw + "px";
  frame.style.height = vh + "px";
  applyCornerRadius(video, c, vw, vh);
  const lut = $("#lutStage");
  if (lut) applyCornerRadius(lut, c, vw, vh);
  // Keep frame overflow visible so corner resize/rotate handles aren't clipped.
  frame.style.overflow = "visible";
  frame.style.borderRadius = "";
  updateMainHandles();
  paintStageRulers();
}

function updateMainHandles() {
  const frame = $("#mainFrame");
  if (!frame) return;
  frame.querySelectorAll(".ovHandle").forEach((h) => h.remove());
  const sel = state.sel && state.sel.type === "clip" && state.sel.i === activeClip && activeClip >= 0;
  frame.classList.toggle("sel", !!sel);
  if (!sel || activeClip < 0) return;
  const c = state.clips[activeClip];
  const free = c && !isFullFrame(c);
  addResizeHandles(frame, !!free);
}

/* ---------- overlays on stage ---------- */

function applyOvBorder(mediaEl, item) {
  if (item.border) {
    const w = Math.max(1, Number(item.borderW) || 4);
    mediaEl.style.boxShadow = `0 0 0 ${w}px ${item.borderColor || "#ffffff"}`;
  } else {
    mediaEl.style.boxShadow = "none";
  }
}

/** cornerRadius 0–100 = % of half the short side (100 = pill). */
function cornerRadiusPx(item, wPx, hPx) {
  const pct = clamp(Number(item.cornerRadius) || 0, 0, 100);
  if (pct < 0.5) return 0;
  return Math.min(wPx, hPx) * 0.5 * (pct / 100);
}

function applyCornerRadius(el, item, wPx, hPx) {
  if (!el) return;
  const r = cornerRadiusPx(item, wPx, hPx);
  el.style.borderRadius = r > 0 ? r + "px" : "";
  // Do NOT set overflow:hidden here — parents that own resize handles must stay visible.
}

function cornerControls(prefix, obj) {
  if (obj.cornerRadius == null) obj.cornerRadius = 0;
  return `
    <h3>Corners</h3>
    ${row("Round", rangeField(prefix + "Corner", obj.cornerRadius, { min: 0, max: 100, step: 1, suffix: "%" }))}
    <div class="muted">0 = square · 100 = fully rounded (pill).</div>`;
}
function bindCornerControls(prefix, obj, after) {
  if (obj.cornerRadius == null) obj.cornerRadius = 0;
  bindRange(prefix + "Corner", obj, "cornerRadius", after || renderOverlays, true);
}

function borderControls(prefix, obj, { withStyle = false } = {}) {
  ensureBorder(obj);
  if (obj.lineStyle == null) obj.lineStyle = "solid";
  const styleRow = withStyle
    ? row("Style", `<select id="${prefix}LineStyle">${LINE_STYLES.map((s) =>
        `<option value="${s.id}" ${(obj.lineStyle || "solid") === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select>`)
    : "";
  return `
    <h3>Border</h3>
    <div class="row"><label><input type="checkbox" id="${prefix}Border" ${obj.border ? "checked" : ""}> Enable border</label></div>
    <div id="${prefix}BorderOpts" style="display:${obj.border ? "block" : "none"}">
      ${row("Color", colorField(prefix + "BorderColor", obj.borderColor))}
      ${row("Thickness", rangeField(prefix + "BorderW", obj.borderW, { min: 1, max: 40, step: 1 }))}
      ${styleRow}
    </div>`;
}
function ensureBorder(obj) {
  if (obj.borderColor == null) obj.borderColor = "#ffffff";
  if (obj.borderW == null) obj.borderW = 4;
  if (obj.border == null) obj.border = false;
  if (obj.lineStyle == null) obj.lineStyle = "solid";
}
function bindBorderControls(prefix, obj, { withStyle = false } = {}) {
  ensureBorder(obj);
  const opts = document.getElementById(prefix + "BorderOpts");
  bindCheck(prefix + "Border", obj, "border", () => {
    if (opts) opts.style.display = obj.border ? "block" : "none";
    renderOverlays();
  });
  bindColor(prefix + "BorderColor", obj, "borderColor", renderOverlays);
  bindRange(prefix + "BorderW", obj, "borderW", renderOverlays, true);
  if (withStyle) {
    const sel = document.getElementById(prefix + "LineStyle");
    if (sel) {
      sel.onchange = () => {
        pushUndo();
        obj.lineStyle = sel.value;
        renderOverlays();
      };
    }
  }
}

function renderOverlays() {
  const layer = $("#ovLayer");
  layer.innerHTML = "";
  const sh = $("#stage").clientHeight || 1;
  const sw = $("#stage").clientWidth || 1;
  state.pips.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "ov ovPip" + (isSel("pip", i) ? " sel" : "");
    d.dataset.type = "pip"; d.dataset.i = i;
    d.style.left = p.x * 100 + "%";
    d.style.top = p.y * 100 + "%";
    d.style.opacity = p.opacity;
    d.style.transform = `translate(-50%,-50%) rotate(${p.rotate || 0}deg)`;
    const natAr = (p.w || 16) / (p.h || 9);
    ensureBoxSize(p, sw, sh, natAr);
    const v = getPipVideo(p);
    v.style.width = p.scaleW * sw + "px";
    v.style.height = p.scaleH * sh + "px";
    v.style.objectFit = "contain";
    v.style.background = "#000";
    applyOvBorder(v, p);
    applyCornerRadius(v, p, p.scaleW * sw, p.scaleH * sh);
    // Parent stays overflow:visible so corner handles remain usable
    d.style.overflow = "visible";
    d.style.borderRadius = "";
    d.appendChild(v);
    if (isSel("pip", i)) addOverlayHandles(d, true);
    layer.appendChild(d);
  });
  state.texts.forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "ov ovText" + (isSel("text", i) ? " sel" : "");
    d.dataset.type = "text"; d.dataset.i = i;
    ensureTextBox(t);
    if (typeof t.text === "string") t.text = t.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    d.style.left = t.x * 100 + "%";
    d.style.top = t.y * 100 + "%";
    d.style.width = t.scaleW * sw + "px";
    d.style.fontFamily = fontCss(t.font);
    d.style.fontWeight = fontWeight(t.font);
    d.style.fontSize = t.size * sh + "px";
    d.style.color = t.color;
    d.style.opacity = t.opacity;
    d.style.transform = `translate(-50%,-50%) rotate(${t.rotate || 0}deg)`;
    if (t.strokeW > 0) d.style.webkitTextStroke = `${t.strokeW * (sh / 1080)}px ${t.stroke}`;
    d.style.textShadow = t.shadow ? cssTextShadow(t.shadowColor || "#000000", sh) : "none";
    if (t.box) {
      const a = Math.round(t.boxAlpha * 255).toString(16).padStart(2, "0");
      d.style.background = t.boxColor + a;
      d.style.borderRadius = "0.12em";
    }
    // Inner node carries pre-wrap newlines — putting text on the flex container itself collapses lines.
    const inner = document.createElement("div");
    inner.className = "ovTextInner";
    inner.style.lineHeight = String(t.lineGap);
    inner.textContent = t.text || "";
    d.appendChild(inner);
    // Measure at auto height so multi-line / Bengali glyphs aren't cropped.
    d.style.height = "auto";
    d.style.overflow = "visible";
    layer.appendChild(d);
    if (t._heightLocked) {
      shrinkTextToFitBox(t, d, sh);
      d.style.height = t.scaleH * sh + "px";
    } else {
      fitTextBoxToContent(t, d, sh);
      d.style.height = t.scaleH * sh + "px";
    }
    d.style.overflow = "hidden";
    if (isSel("text", i)) addOverlayHandles(d, true);
  });
  state.shapes.forEach((shItem, i) => {
    const d = document.createElement("div");
    d.className = "ov ovShape" + (isSel("shape", i) ? " sel" : "");
    d.dataset.type = "shape"; d.dataset.i = i;
    d.style.left = shItem.x * 100 + "%";
    d.style.top = shItem.y * 100 + "%";
    d.style.opacity = shItem.opacity;
    d.style.transform = `translate(-50%,-50%) rotate(${shItem.rotate || 0}deg)`;
    ensureBoxSize(shItem, sw, sh, (shItem.scaleW || 0.28) / Math.max(shItem.scaleH || 0.18, 0.01));
    d.innerHTML = buildShapeSvg(shItem, sw, sh);
    if (isSel("shape", i)) addOverlayHandles(d, true);
    layer.appendChild(d);
  });
  state.images.forEach((im, i) => {
    const d = document.createElement("div");
    d.className = "ov ovImage" + (isSel("image", i) ? " sel" : "");
    d.dataset.type = "image"; d.dataset.i = i;
    d.style.left = im.x * 100 + "%";
    d.style.top = im.y * 100 + "%";
    d.style.opacity = im.opacity;
    d.style.transform = `translate(-50%,-50%) rotate(${im.rotate || 0}deg)`;
    ensureBoxSize(im, sw, sh, (im.w || 1) / (im.h || 1));
    const img = document.createElement("img");
    img.src = "/media/" + im.mid;
    img.style.width = im.scaleW * sw + "px";
    img.style.height = im.scaleH * sh + "px";
    img.style.objectFit = "fill";
    applyOvBorder(img, im);
    applyCornerRadius(img, im, im.scaleW * sw, im.scaleH * sh);
    d.style.overflow = "visible";
    d.style.borderRadius = "";
    d.appendChild(img);
    if (isSel("image", i)) addOverlayHandles(d, true);
    layer.appendChild(d);
  });
  overlayTick();
}

function addOverlayHandles(d, withScale) {
  if (withScale) addResizeHandles(d, true);
  else {
    const rot = document.createElement("div");
    rot.className = "ovHandle rot";
    rot.dataset.corner = "rot";
    rot.title = "Drag to rotate · snaps to 90° when Snap is on";
    d.appendChild(rot);
  }
}

function overlayTick() {
  document.querySelectorAll("#ovLayer .ov").forEach((el) => {
    const type = el.dataset.type;
    const i = +el.dataset.i;
    const arr = { text: state.texts, image: state.images, pip: state.pips, shape: state.shapes }[type];
    const it = arr && arr[i];
    if (!it) return;
    const start = type === "pip" ? it.offset : it.start;
    const len = type === "pip" ? itemLen(it) : it.durn;
    const inRange = state.t >= start - 1e-6 && state.t <= start + len + 1e-6;
    const hidden = isLaneHidden(laneIdFor(type, i));
    el.classList.toggle("hiddenNow", !inRange || hidden);
  });
  subPreviewTick();
}

function subPreviewTick() {
  const el = $("#subPreview");
  if (!el) return;
  if (isLaneHidden("subs")) { el.style.display = "none"; return; }
  const active = state.subs.entries.find((e) => {
    const start = Number(e.start) || 0;
    const durn = e.durn != null ? Number(e.durn) : Math.max(0.2, (Number(e.end) || start + 2) - start);
    return state.t >= start - 1e-6 && state.t <= start + durn + 1e-6;
  });
  if (!active) { el.style.display = "none"; return; }
  const st = state.subs.style || {};
  const sh = $("#stage").clientHeight || 1;
  el.style.display = "block";
  el.style.top = (st.y != null ? st.y : 0.92) * 100 + "%";
  el.style.fontFamily = fontCss(st.font || "Arial");
  el.style.fontWeight = fontWeight(st.font || "Arial");
  el.style.fontSize = (st.size != null ? st.size : 0.055) * sh + "px";
  el.style.color = st.color || "#ffffff";
  el.style.opacity = st.opacity != null ? st.opacity : 1;
  el.style.webkitTextStroke = st.strokeW > 0 && !st.box ? `${st.strokeW * (sh / 1080)}px ${st.stroke || "#000"}` : "";
  el.style.textShadow = st.shadow ? cssTextShadow(st.shadowColor || "#000000", sh) : "none";
  if (st.box) {
    const a = Math.round((st.boxAlpha != null ? st.boxAlpha : 0.55) * 255).toString(16).padStart(2, "0");
    el.style.background = (st.boxColor || "#000000") + a;
    el.style.padding = "0.12em 0.4em";
    el.style.borderRadius = "0.1em";
  } else {
    el.style.background = "none";
    el.style.padding = "0";
  }
  el.textContent = String(active.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/* overlay dragging on stage */
$("#ovLayer").addEventListener("mousedown", (e) => {
  const el = e.target.closest(".ov");
  if (!el) return;
  const type = el.dataset.type, i = +el.dataset.i;
  if (itemLaneLocked(type, i)) { state.sel = { type, i }; refresh(); return; }
  state.sel = { type, i };
  pushUndo();
  const handle = e.target.closest(".ovHandle");
  const arr = { pip: state.pips, image: state.images, text: state.texts, shape: state.shapes }[type];
  const it = arr[i];
  if (handle && handle.dataset.corner === "rot") {
    const rect = $("#stage").getBoundingClientRect();
    const cx = rect.left + it.x * rect.width;
    const cy = rect.top + it.y * rect.height;
    gesture = {
      kind: "rotate-overlay", type, i,
      cx, cy,
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI,
      origRotate: it.rotate || 0,
    };
  } else if (handle && (type === "pip" || type === "image" || type === "shape" || type === "text")) {
    const sw = $("#stage").clientWidth || 1;
    const sh = $("#stage").clientHeight || 1;
    if (type === "text") ensureTextBox(it);
    else ensureBoxSize(it, sw, sh, (it.w || 16) / (it.h || 9));
    const rect = $("#stage").getBoundingClientRect();
    gesture = {
      kind: "scale-overlay", type, i,
      corner: handle.dataset.corner,
      rect,
      start: boxStart(it),
    };
  } else {
    const rect = $("#stage").getBoundingClientRect();
    gesture = {
      kind: "move-overlay", type, i, rect,
      startX: it.x,
      startY: it.y,
      originClientX: e.clientX,
      originClientY: e.clientY,
    };
  }
  refresh();
  e.preventDefault();
  e.stopPropagation();
});

/* main clip frame: move / scale / rotate on stage */
$("#mainFrame").addEventListener("mousedown", (e) => {
  if (!state.clips.length || activeClip < 0) return;
  const loc = locate(state.t);
  if (!loc) return;
  if (isLaneLocked(laneIdFor("clip", loc.i))) { state.sel = { type: "clip", i: loc.i }; refresh(); return; }
  const c = state.clips[loc.i];
  ensureClipLayout(c);
  state.sel = { type: "clip", i: loc.i };
  // Repositioning must never start playback.
  if (!state.playing) {
    try { video.pause(); } catch (err) { /* ignore */ }
  }
  const handle = e.target.closest(".ovHandle");
  if (handle && handle.dataset.corner === "rot") {
    pushUndo();
    const rect = $("#stage").getBoundingClientRect();
    gesture = {
      kind: "rotate-main",
      cx: rect.left + c.x * rect.width,
      cy: rect.top + c.y * rect.height,
      startAngle: Math.atan2(e.clientY - (rect.top + c.y * rect.height), e.clientX - (rect.left + c.x * rect.width)) * 180 / Math.PI,
      origRotate: c.rotate || 0,
    };
  } else if (handle) {
    pushUndo();
    ensureClipLayout(c);
    const rect = $("#stage").getBoundingClientRect();
    gesture = {
      kind: "scale-main",
      corner: handle.dataset.corner,
      rect,
      start: boxStart(c),
    };
  } else {
    pushUndo();
    const rect = $("#stage").getBoundingClientRect();
    gesture = {
      kind: "move-main",
      rect,
      startX: c.x,
      startY: c.y,
      originClientX: e.clientX,
      originClientY: e.clientY,
    };
  }
  updateMainHandles();
  renderInspector();
  e.preventDefault();
  e.stopPropagation();
});

// Guard: WebView2 / browser may try to play <video> on click — only allow when transport is playing.
video.addEventListener("play", () => {
  if (!state.playing) {
    try { video.pause(); } catch (err) { /* ignore */ }
  }
});
video.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
});
video.addEventListener("mousedown", (e) => {
  e.preventDefault();
});

/* ---------- timeline rendering ---------- */

function computePps() {
  // Stable px/sec — do not re-fit to project length (that makes trims feel like the
  // timeline is sliding/zooming under the cursor). Zoom still scales this.
  const PPS_BASE = 80;
  pps = PPS_BASE * (state.zoom || 1);
}

function applyLaneHeights() {
  const root = document.documentElement;
  const h = state.trackH;
  root.style.setProperty("--lane-v", Math.round(46 * h) + "px");
  root.style.setProperty("--lane-a", Math.round(30 * h) + "px");
  root.style.setProperty("--lane-o", Math.round(26 * h) + "px");
  const area = $("#tlArea");
  const tl = $("#tlScroll");
  if (tl) tl.style.height = state.tlH + "px";
  if (area) area.style.height = state.tlH + "px";
  const lab = $("#thLabel");
  if (lab) lab.textContent = Math.round(h * 100) + "%";
}

function laneFlags(id) {
  // Migrate legacy "v1" flags onto video-0
  if (id === "video-0" && state.laneFlags.v1 && !state.laneFlags["video-0"]) {
    state.laneFlags["video-0"] = { ...state.laneFlags.v1 };
  }
  if (!state.laneFlags[id]) state.laneFlags[id] = { lock: false, hide: false, mute: false };
  return state.laneFlags[id];
}

function laneHeight(id, kind) {
  if (state.laneH[id]) return state.laneH[id];
  const base = kind === "video" ? 46 : kind === "music" ? 30 : 26;
  return Math.round(base * state.trackH);
}

function makeLaneHead(id, kind, label, icon, opts = {}) {
  const f = laneFlags(id);
  const h = laneHeight(id, kind);
  const head = document.createElement("div");
  head.className = "laneHead" + (f.hide ? " is-hidden" : "") + (f.lock ? " is-locked" : "");
  head.dataset.lane = id;
  head.dataset.kind = kind;
  head.style.height = h + "px";
  const muteBtn = opts.hasMute !== false
    ? `<button type="button" class="laneBtn${f.mute ? " on" : ""}" data-act="mute" title="Mute track">${f.mute ? "🔇" : "🔊"}</button>`
    : "";
  head.innerHTML = `
    <span class="laneIcon" title="${label}">${icon}</span>
    <div class="laneHeadBtns">
      <button type="button" class="laneBtn${f.lock ? " on danger" : ""}" data-act="lock" title="Lock track">${f.lock ? "🔒" : "🔓"}</button>
      <button type="button" class="laneBtn${f.hide ? " on" : ""}" data-act="hide" title="Hide / show">${f.hide ? "🚫" : "👁"}</button>
      ${muteBtn}
    </div>
    <div class="laneResize" data-lane="${id}" data-kind="${kind}" title="Drag to resize track height"></div>`;
  return head;
}

function makeLane(id, kind) {
  const f = laneFlags(id);
  const h = laneHeight(id, kind);
  const lane = document.createElement("div");
  lane.className = `lane ${kind}` + (f.lock ? " is-locked" : "") + (f.hide ? " is-hidden" : "");
  lane.dataset.lane = id;
  lane.style.height = h + "px";
  return lane;
}

function isLaneLocked(laneId) { return !!(laneFlags(laneId).lock); }
function isLaneHidden(laneId) { return !!(laneFlags(laneId).hide); }
function isLaneMuted(laneId) { return !!(laneFlags(laneId).mute); }

function laneIdFor(type, i) {
  if (type === "clip") {
    const c = state.clips[i];
    return videoLaneId(c ? clipTrack(c) : 0);
  }
  if (type === "text") {
    const t = state.texts[i];
    return "text-" + (t && typeof t.track === "number" ? t.track : 0);
  }
  if (type === "shape") {
    const s = state.shapes[i];
    return "shape-" + (s && typeof s.track === "number" ? s.track : 0);
  }
  if (type === "image") {
    const im = state.images[i];
    return "image-" + (im && typeof im.track === "number" ? im.track : 0);
  }
  if (type === "sub") return "subs";
  if (type === "pip") {
    const p = state.pips[i];
    return "pip-" + (p && typeof p.track === "number" ? p.track : 0);
  }
  if (type === "music") {
    const m = state.music[i];
    return "music-" + (m && typeof m.track === "number" ? m.track : 0);
  }
  return null;
}
function itemLaneLocked(type, i) {
  const id = laneIdFor(type, i);
  return id ? isLaneLocked(id) : false;
}

function isSel(type, i) { return state.sel && state.sel.type === type && state.sel.i === i; }

function blockEl(cls, type, i, left, width, label, lenText) {
  const b = document.createElement("div");
  b.className = `block ${cls}` + (isSel(type, i) ? " sel" : "");
  b.style.left = left + "px";
  b.style.width = Math.max(width, 12) + "px";
  b.dataset.type = type; b.dataset.i = i;
  b.innerHTML = `<span class="bname">${label}</span><span class="blen">${lenText}</span>` +
    `<div class="handle l" data-h="l"></div><div class="handle r" data-h="r"></div>`;
  return b;
}

function appendLanePair(heads, lanesEl, head, lane) {
  heads.appendChild(head);
  lanesEl.appendChild(lane);
}

function renderTimeline() {
  applyLaneHeights();
  computePps();
  const total = Math.max(contentEnd(), 10);
  $("#timeline").style.width = total * pps + 40 + "px";

  const ruler = $("#ruler");
  ruler.innerHTML = "";
  const majors = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = majors.find((s) => s * pps >= 52) || 600;
  let minor = 1;
  if (major <= 0.2) minor = 0.05;
  else if (major <= 1) minor = 0.1;
  else if (major <= 5) minor = 1;
  else if (major <= 30) minor = 1;
  else minor = 5;
  const showTenth = major < 1;
  for (let t = 0; t <= total + 1e-9; t = Math.round((t + minor) * 1000) / 1000) {
    const d = document.createElement("div");
    const isMajor = Math.abs((t / major) - Math.round(t / major)) < 1e-6;
    const isSecond = Math.abs(t - Math.round(t)) < 1e-6;
    d.className = "tick" + (isMajor ? " major" : isSecond ? " minor" : "");
    d.style.left = t * pps + "px";
    if (isMajor) {
      const lab = document.createElement("span");
      lab.className = "tlbl";
      lab.textContent = showTenth ? fmtClock(t, true) : fmtClock(t);
      d.appendChild(lab);
    }
    ruler.appendChild(d);
  }

  const heads = $("#tlHeads");
  const lanesEl = $("#lanes");
  if (!heads || !lanesEl) return;
  heads.innerHTML = "";
  lanesEl.innerHTML = "";

  state.texts.length && (() => {
    ensurePackedTracks(state.texts, timedSpan);
    const groups = groupByTrack(state.texts);
    groups.forEach((group, n) => {
      const id = "text-" + group.track;
      const lane = makeLane(id, "overlay");
      group.idxs.forEach((i) => {
        const t = state.texts[i];
        const b = blockEl("text", "text", i, t.start * pps, t.durn * pps, "𝐓 " + (t.text || "").split("\n")[0].slice(0, 24), fmt(t.durn));
        b.dataset.track = group.track;
        lane.appendChild(b);
      });
      const label = groups.length > 1 ? ("Text " + (n + 1)) : "Text";
      appendLanePair(heads, lanesEl, makeLaneHead(id, "overlay", label, "𝐓", { hasMute: false }), lane);
    });
  })();
  state.shapes.length && (() => {
    ensurePackedTracks(state.shapes, timedSpan);
    const groups = groupByTrack(state.shapes);
    groups.forEach((group, n) => {
      const id = "shape-" + group.track;
      const lane = makeLane(id, "overlay");
      group.idxs.forEach((i) => {
        const shItem = state.shapes[i];
        const b = blockEl("shape", "shape", i, shItem.start * pps, shItem.durn * pps, "◆ " + shapeLabel(shItem.kind), fmt(shItem.durn));
        b.dataset.track = group.track;
        lane.appendChild(b);
      });
      const label = groups.length > 1 ? ("Shape " + (n + 1)) : "Shape";
      appendLanePair(heads, lanesEl, makeLaneHead(id, "overlay", label, "◆", { hasMute: false }), lane);
    });
  })();
  state.images.length && (() => {
    ensurePackedTracks(state.images, timedSpan);
    const groups = groupByTrack(state.images);
    groups.forEach((group, n) => {
      const id = "image-" + group.track;
      const lane = makeLane(id, "overlay");
      group.idxs.forEach((i) => {
        const im = state.images[i];
        const b = blockEl("image", "image", i, im.start * pps, im.durn * pps, "🖼 " + im.name, fmt(im.durn));
        b.dataset.track = group.track;
        lane.appendChild(b);
      });
      const label = groups.length > 1 ? ("Image " + (n + 1)) : "Image";
      appendLanePair(heads, lanesEl, makeLaneHead(id, "overlay", label, "🖼", { hasMute: false }), lane);
    });
  })();

  ensurePackedTracks(state.pips, mediaSpan);
  let pipLanes = groupByTrack(state.pips);
  // Always show at least one Overlay lane so video clips can be dragged onto it
  if (!pipLanes.length) pipLanes = [{ track: 0, idxs: [] }];
  pipLanes.forEach((group, n) => {
    const id = "pip-" + group.track;
    const lane = makeLane(id, "overlay");
    group.idxs.forEach((i) => {
      const p = state.pips[i];
      const b = blockEl("pip", "pip", i, p.offset * pps, itemLen(p) * pps, "▣ " + p.name, fmt(itemLen(p)));
      b.dataset.track = group.track;
      lane.appendChild(b);
    });
    if (!group.idxs.length) {
      const hint = document.createElement("div");
      hint.style.cssText = "position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#8b93a7;font-size:11px;pointer-events:none";
      hint.textContent = "Drop video here for overlay";
      lane.appendChild(hint);
    }
    const label = pipLanes.length > 1 ? ("Overlay " + (n + 1)) : "Overlay";
    appendLanePair(heads, lanesEl, makeLaneHead(id, "overlay", label, "▣"), lane);
  });

  ensureClipTracks();
  let videoGroups = groupByTrack(state.clips);
  if (!videoGroups.some((g) => g.track === 0)) videoGroups.push({ track: 0, idxs: [] });
  videoGroups.sort((a, b) => b.track - a.track); // higher track nearer the top
  const starts = clipStarts();
  videoGroups.forEach((group) => {
    const id = videoLaneId(group.track);
    const vlane = makeLane(id, "video");
    group.idxs.forEach((i) => {
      const c = state.clips[i];
      const label = `${c.name}${c.rotate ? " ⟳" + c.rotate : ""}${c.speed !== 1 ? " ×" + c.speed : ""}`;
      const b = blockEl("clip", "clip", i, starts[i] * pps, clipLen(c) * pps, label, fmt(clipLen(c)));
      b.dataset.track = group.track;
      if (c.trans && c.trans.type !== "none" && i < state.clips.length - 1) {
        const tr = document.createElement("div");
        tr.className = "btrans";
        tr.style.width = Math.max(transDur(c, state.clips[i + 1]) * pps, 6) + "px";
        b.appendChild(tr);
      }
      vlane.appendChild(b);
    });
    if (!group.idxs.length) {
      const hint = document.createElement("div");
      hint.style.cssText = "position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#8b93a7;font-size:11px;pointer-events:none";
      hint.textContent = "Drag media here";
      vlane.appendChild(hint);
    }
    appendLanePair(heads, lanesEl, makeLaneHead(id, "video", "Video " + (group.track + 1), "🎬"), vlane);
  });

  if (state.subs.entries.length) {
    const id = "subs";
    const lane = makeLane(id, "overlay");
    state.subs.entries.forEach((e, i) => {
      lane.appendChild(blockEl("sub", "sub", i, e.start * pps, e.durn * pps, "💬 " + e.text.split("\n")[0].slice(0, 28), fmt(e.durn)));
    });
    appendLanePair(heads, lanesEl, makeLaneHead(id, "overlay", "Subtitles", "💬", { hasMute: false }), lane);
  }

  ensurePackedTracks(state.music, mediaSpan);
  const musicLanes = groupByTrack(state.music);
  musicLanes.forEach((group, n) => {
    const id = "music-" + group.track;
    const lane = makeLane(id, "music");
    group.idxs.forEach((i) => {
      const m = state.music[i];
      const b = blockEl("music", "music", i, m.offset * pps, itemLen(m) * pps, "♪ " + m.name, fmt(itemLen(m)));
      b.dataset.track = group.track;
      lane.appendChild(b);
    });
    appendLanePair(heads, lanesEl, makeLaneHead(id, "music", "Audio " + (n + 1), "♪"), lane);
  });

  paintPlayhead();
}

function paintPlayhead() {
  $("#playhead").style.left = 10 + state.t * pps + "px";
}
function updateTimeLabel() {
  const total = contentEnd();
  $("#timeLabel").textContent = `${fmtClock(state.t, true)} / ${fmtClock(total, true)}`;
}

function afterSpeedChange(c) {
  // Timeline shrinks/grows with speed — keep playhead + preview in range.
  state.t = clamp(state.t, 0, Math.max(contentEnd(), 0));
  if (c && state.clips[activeClip] === c) {
    try { video.playbackRate = c.speed || 1; } catch (err) { /* ignore */ }
  }
  refresh();
  syncPreview(!!state.playing);
}

/* ---------- snapping ---------- */

function timelineItemDur(type, item) {
  if (!item) return 0.05;
  if (type === "clip") return clipLen(item);
  if (type === "music" || type === "pip") return itemLen(item);
  return Math.max(0.05, +item.durn || 0.05);
}

function snapPoints(excludeType, excludeI) {
  const pts = [0, state.t];
  const starts = clipStarts();
  state.clips.forEach((c, i) => {
    if (excludeType === "clip" && i === excludeI) return;
    pts.push(starts[i], starts[i] + clipLen(c));
  });
  state.music.forEach((m, i) => {
    if (!(excludeType === "music" && i === excludeI)) pts.push(m.offset, m.offset + itemLen(m));
  });
  state.pips.forEach((p, i) => {
    if (!(excludeType === "pip" && i === excludeI)) pts.push(p.offset, p.offset + itemLen(p));
  });
  [...state.texts.entries()].forEach(([i, t]) => {
    if (!(excludeType === "text" && i === excludeI)) pts.push(t.start, t.start + t.durn);
  });
  [...state.shapes.entries()].forEach(([i, t]) => {
    if (!(excludeType === "shape" && i === excludeI)) pts.push(t.start, t.start + t.durn);
  });
  [...state.images.entries()].forEach(([i, t]) => {
    if (!(excludeType === "image" && i === excludeI)) pts.push(t.start, t.start + t.durn);
  });
  [...state.subs.entries.entries()].forEach(([i, t]) => {
    if (!(excludeType === "sub" && i === excludeI)) pts.push(t.start, t.start + t.durn);
  });
  return pts;
}

/** Snap a single timeline edge; optionally light up other edges that already align. */
function snap(t, excludeType, excludeI, otherEdges) {
  const tol = 8 / pps;
  const pts = snapPoints(excludeType, excludeI);
  let best = t, bd = tol, hit = null;
  for (const p of pts) {
    const d = Math.abs(t - p);
    if (d < bd) { bd = d; best = p; hit = p; }
  }
  const guides = [];
  if (hit != null) guides.push(hit);
  for (const e of otherEdges || []) {
    if (!Number.isFinite(e)) continue;
    for (const p of pts) {
      if (Math.abs(e - p) <= tol) guides.push(p);
    }
  }
  showTlGuides(guides);
  return best;
}

/**
 * Snap a block by either its start or its end to neighboring edges.
 * When both land on targets (e.g. filling a gap), both guide lines show.
 */
function snapBlock(start, dur, excludeType, excludeI) {
  const tol = 8 / pps;
  const pts = snapPoints(excludeType, excludeI);
  const d = Math.max(0.05, dur || 0.05);
  let best = start, bd = tol;
  for (const p of pts) {
    const d0 = Math.abs(start - p);
    if (d0 < bd) { bd = d0; best = p; }
    const d1 = Math.abs(start + d - p);
    if (d1 < bd) { bd = d1; best = p - d; }
  }
  best = Math.max(0, best);
  const guides = [];
  for (const p of pts) {
    if (Math.abs(best - p) <= tol) guides.push(p);
    if (Math.abs(best + d - p) <= tol) guides.push(p);
  }
  showTlGuides(guides);
  return best;
}

function showTlGuides(times) {
  const g = $("#tlGuide");
  if (!g) return;
  const uniq = [];
  for (const t of times || []) {
    if (!Number.isFinite(t)) continue;
    if (uniq.some((u) => Math.abs(u - t) < 1e-4)) continue;
    uniq.push(t);
  }
  if (!uniq.length) {
    g.style.display = "none";
    g.innerHTML = "";
    return;
  }
  g.style.display = "block";
  g.innerHTML = "";
  for (const t of uniq) {
    const el = document.createElement("div");
    el.className = "tlGuideLine";
    el.style.left = (t * pps) + "px";
    g.appendChild(el);
  }
}

function showTlGuide(t) {
  showTlGuides(t == null ? [] : [t]);
}

function clearTlGuide() {
  showTlGuides([]);
}

/* ---------- canvas alignment guides ---------- */

function itemBox(it) {
  const sw = $("#stage").clientWidth || 1;
  const sh = $("#stage").clientHeight || 1;
  if (it.scaleW != null || it.scale != null) {
    ensureBoxSize(it, sw, sh, (it.w || 16) / (it.h || 9));
    return {
      x: it.x, y: it.y,
      L: it.x - it.scaleW / 2, R: it.x + it.scaleW / 2,
      T: it.y - it.scaleH / 2, B: it.y + it.scaleH / 2,
      hasEdges: true,
    };
  }
  return { x: it.x, y: it.y, L: it.x, R: it.x, T: it.y, B: it.y, hasEdges: false };
}

function collectGuideTargets(excludeType, excludeI) {
  // Frame edges (L/R/T/B) + center crosshair + user ruler guides
  const xs = [0, 0.5, 1];
  const ys = [0, 0.5, 1];
  ensureCanvasGuides();
  for (const x of state.canvas.guides.v) xs.push(x);
  for (const y of state.canvas.guides.h) ys.push(y);
  const widths = [];
  const heights = [];
  const add = (type, i, it) => {
    if (!it) return;
    if (excludeType === type && excludeI === i) return;
    const b = itemBox(it);
    xs.push(b.x);
    ys.push(b.y);
    if (b.hasEdges) {
      xs.push(b.L, b.R);
      ys.push(b.T, b.B);
      widths.push(b.R - b.L);
      heights.push(b.B - b.T);
    }
  };
  if (activeClip >= 0 && state.clips[activeClip] && !isFullFrame(state.clips[activeClip])) {
    add("clip", activeClip, state.clips[activeClip]);
  }
  state.pips.forEach((p, i) => add("pip", i, p));
  state.images.forEach((im, i) => add("image", i, im));
  state.shapes.forEach((s, i) => add("shape", i, s));
  state.texts.forEach((t, i) => add("text", i, t));
  return { xs, ys, widths, heights };
}

function snapItemToGuides(item, excludeType, excludeI) {
  const stage = $("#stage");
  const sw = stage.clientWidth || 1;
  const sh = stage.clientHeight || 1;
  const tolX = 8 / sw;
  const tolY = 8 / sh;
  const { xs, ys } = collectGuideTargets(excludeType, excludeI);
  const b = itemBox(item);
  const xCandidates = [{ edge: item.x, delta: 0 }];
  const yCandidates = [{ edge: item.y, delta: 0 }];
  if (b.hasEdges) {
    xCandidates.push(
      { edge: item.x - item.scaleW / 2, delta: -item.scaleW / 2 },
      { edge: item.x + item.scaleW / 2, delta: item.scaleW / 2 },
    );
    yCandidates.push(
      { edge: item.y - item.scaleH / 2, delta: -item.scaleH / 2 },
      { edge: item.y + item.scaleH / 2, delta: item.scaleH / 2 },
    );
  }
  let bestXd = tolX, bestYd = tolY;
  let snapDx = 0, snapDy = 0;
  for (const c of xCandidates) {
    for (const t of xs) {
      const d = Math.abs(c.edge - t);
      if (d < bestXd) {
        bestXd = d;
        snapDx = t - c.edge;
      }
    }
  }
  for (const c of yCandidates) {
    for (const t of ys) {
      const d = Math.abs(c.edge - t);
      if (d < bestYd) {
        bestYd = d;
        snapDy = t - c.edge;
      }
    }
  }
  if (bestXd < tolX || bestYd < tolY) {
    applyItemPos(
      item,
      bestXd < tolX ? item.x + snapDx : item.x,
      bestYd < tolY ? item.y + snapDy : item.y,
    );
  }

  // Light up every frame/object edge that currently aligns
  const b2 = itemBox(item);
  const linesX = [], linesY = [];
  const checkX = [item.x];
  const checkY = [item.y];
  if (b2.hasEdges) {
    checkX.push(b2.L, b2.R);
    checkY.push(b2.T, b2.B);
  }
  for (const t of xs) {
    if (checkX.some((e) => Math.abs(e - t) <= tolX)) linesX.push(t);
  }
  for (const t of ys) {
    if (checkY.some((e) => Math.abs(e - t) <= tolY)) linesY.push(t);
  }
  showCanvasGuidesMulti(linesX, linesY);
}

function showCanvasGuides(gx, gy) {
  showCanvasGuidesMulti(gx != null ? [gx] : [], gy != null ? [gy] : []);
}

function clearCanvasGuides() {
  renderUserGuides();
}

/* ---------- stage rulers (Photoshop-style) ---------- */

function previewCanvasSize() {
  const map = {
    "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080],
    "4:5": [1080, 1350], "4:3": [1440, 1080], "3:4": [1080, 1440],
  };
  const cv = state.canvas;
  if (cv.preset === "custom") return [cv.w || 1920, cv.h || 1080];
  if (cv.preset in map) return map[cv.preset];
  const c = state.clips[0];
  if (!c) return [1920, 1080];
  const r = ((Math.round(c.rotate || 0) % 360) + 360) % 360;
  const swapped = isFullFrame(c) && (r === 90 || r === 270);
  const w = c.w || 1920, h = c.h || 1080;
  return swapped ? [h, w] : [w, h];
}

function niceTickStep(span, targetTicks) {
  const raw = span / Math.max(targetTicks, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const n = raw / pow;
  let step = pow;
  if (n > 5) step = 10 * pow;
  else if (n > 2) step = 5 * pow;
  else if (n > 1) step = 2 * pow;
  return Math.max(step, 1);
}

function paintStageRulers() {
  if (state.canvas && state.canvas.showRulers === false) return;
  const stage = $("#stage");
  const rh = $("#rulerH");
  const rv = $("#rulerV");
  const rhWrap = $("#rulerHWrap");
  const rvWrap = $("#rulerVWrap");
  if (!stage || !rh || !rv || !rhWrap || !rvWrap) return;
  const sw = stage.clientWidth || 1;
  const sh = stage.clientHeight || 1;
  const [cw, ch] = previewCanvasSize();
  const dpr = window.devicePixelRatio || 1;

  // Align ruler canvases with the centered stage inside their cells
  const stageRect = stage.getBoundingClientRect();
  const rhRect = rhWrap.getBoundingClientRect();
  const rvRect = rvWrap.getBoundingClientRect();
  const hLeft = Math.round(stageRect.left - rhRect.left);
  const vTop = Math.round(stageRect.top - rvRect.top);

  rh.style.left = hLeft + "px";
  rh.style.width = sw + "px";
  rh.style.height = "22px";
  rh.width = Math.max(1, Math.round(sw * dpr));
  rh.height = Math.round(22 * dpr);
  const ctxH = rh.getContext("2d");
  ctxH.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctxH.clearRect(0, 0, sw, 22);
  ctxH.fillStyle = "#141824";
  ctxH.fillRect(0, 0, sw, 22);
  ctxH.fillStyle = "#8b93a7";
  ctxH.strokeStyle = "#3a4258";
  ctxH.font = "10px Segoe UI, sans-serif";
  ctxH.textAlign = "center";
  ctxH.textBaseline = "top";
  const stepX = niceTickStep(cw, Math.max(6, sw / 70));
  for (let px = 0; px <= cw + 0.5; px += stepX) {
    const x = (px / cw) * sw;
    const major = Math.abs(px % (stepX * 2)) < 0.01 || px === 0;
    ctxH.beginPath();
    ctxH.moveTo(x + 0.5, major ? 8 : 14);
    ctxH.lineTo(x + 0.5, 22);
    ctxH.stroke();
    if (major) ctxH.fillText(String(Math.round(px)), x, 1);
  }

  rv.style.top = vTop + "px";
  rv.style.height = sh + "px";
  rv.style.width = "22px";
  rv.width = Math.round(22 * dpr);
  rv.height = Math.max(1, Math.round(sh * dpr));
  const ctxV = rv.getContext("2d");
  ctxV.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctxV.clearRect(0, 0, 22, sh);
  ctxV.fillStyle = "#141824";
  ctxV.fillRect(0, 0, 22, sh);
  ctxV.fillStyle = "#8b93a7";
  ctxV.strokeStyle = "#3a4258";
  ctxV.font = "10px Segoe UI, sans-serif";
  ctxV.textAlign = "right";
  ctxV.textBaseline = "middle";
  const stepY = niceTickStep(ch, Math.max(6, sh / 70));
  for (let py = 0; py <= ch + 0.5; py += stepY) {
    const y = (py / ch) * sh;
    const major = Math.abs(py % (stepY * 2)) < 0.01 || py === 0;
    ctxV.beginPath();
    ctxV.moveTo(major ? 8 : 14, y + 0.5);
    ctxV.lineTo(22, y + 0.5);
    ctxV.stroke();
    if (major) {
      ctxV.save();
      ctxV.translate(10, y);
      ctxV.rotate(-Math.PI / 2);
      ctxV.textAlign = "center";
      ctxV.fillText(String(Math.round(py)), 0, 0);
      ctxV.restore();
    }
  }
}

function stageNormFromEvent(e) {
  const stage = $("#stage");
  if (!stage) return { x: 0.5, y: 0.5 };
  const r = stage.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / Math.max(r.width, 1), 0, 1),
    y: clamp((e.clientY - r.top) / Math.max(r.height, 1), 0, 1),
  };
}

function initStageRulers() {
  const rhWrap = $("#rulerHWrap");
  const rvWrap = $("#rulerVWrap");
  const layer = $("#guideLayer");
  if (!rhWrap || !rvWrap) return;

  const startH = (e) => {
    e.preventDefault();
    pushUndo();
    const { y } = stageNormFromEvent(e);
    gesture = { kind: "place-guide-h", y: Number.isFinite(y) ? y : 0 };
    renderGuideLayer([], [], { axis: "h", val: gesture.y });
  };
  const startV = (e) => {
    e.preventDefault();
    pushUndo();
    const { x } = stageNormFromEvent(e);
    gesture = { kind: "place-guide-v", x: Number.isFinite(x) ? x : 0 };
    renderGuideLayer([], [], { axis: "v", val: gesture.x });
  };

  rhWrap.addEventListener("mousedown", startH);
  rvWrap.addEventListener("mousedown", startV);
  rhWrap.addEventListener("dblclick", () => {
    ensureCanvasGuides();
    if (!state.canvas.guides.h.length) return;
    pushUndo();
    state.canvas.guides.h = [];
    renderUserGuides();
  });
  rvWrap.addEventListener("dblclick", () => {
    ensureCanvasGuides();
    if (!state.canvas.guides.v.length) return;
    pushUndo();
    state.canvas.guides.v = [];
    renderUserGuides();
  });
  if (layer) {
    layer.addEventListener("mousedown", (e) => {
      const g = e.target.closest(".guideLine.user");
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      const axis = g.dataset.guideAxis;
      const index = +g.dataset.guideIndex;
      if (!Number.isFinite(index)) return;
      pushUndo();
      if (axis === "v") {
        gesture = { kind: "move-guide-v", index, x: state.canvas.guides.v[index] };
        renderGuideLayer([], [], { axis: "v", val: gesture.x });
      } else {
        gesture = { kind: "move-guide-h", index, y: state.canvas.guides.h[index] };
        renderGuideLayer([], [], { axis: "h", val: gesture.y });
      }
    });
    layer.addEventListener("dblclick", (e) => {
      const g = e.target.closest(".guideLine.user");
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      const axis = g.dataset.guideAxis;
      const index = +g.dataset.guideIndex;
      ensureCanvasGuides();
      pushUndo();
      if (axis === "v") state.canvas.guides.v.splice(index, 1);
      else state.canvas.guides.h.splice(index, 1);
      renderUserGuides();
    });
  }
  const slot = $("#stageSlot");
  const stage = $("#stage");
  if (slot && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { paintStageRulers(); }).observe(slot);
  }
  if (stage && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { paintStageRulers(); }).observe(stage);
  }
  window.addEventListener("resize", () => paintStageRulers());
}

function initRulerMenu() {
  loadRulerPrefs();
  ensureCanvasGuides();
  const tog = $("#rulerToggle");
  const col = $("#guideColor");
  if (tog) {
    tog.checked = state.canvas.showRulers !== false;
    tog.addEventListener("change", () => {
      state.canvas.showRulers = tog.checked;
      persistRulerPrefs();
      applyRulerVisibility();
    });
  }
  if (col) {
    col.value = normHex(state.canvas.guideColor || "#22d3ee");
    col.addEventListener("input", () => {
      state.canvas.guideColor = normHex(col.value);
      persistRulerPrefs();
      applyGuideColor();
      renderUserGuides();
    });
  }
  applyGuideColor();
  applyRulerVisibility();
}

/* ---------- inspector ---------- */

function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstChild;
}
function row(label, inner) {
  return `<div class="row"><span class="lbl">${label}</span>${inner}</div>`;
}

/** Range + editable number field. suffix e.g. "°". digits = fixed decimal places for display. */
function rangeField(id, value, { min, max, step, suffix = "", digits } = {}) {
  const n = Number(value);
  const shown = digits != null && Number.isFinite(n) ? n.toFixed(digits) : value;
  return `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">`
    + `<input type="number" class="val" id="${id}Num" min="${min}" max="${max}" step="${step}" value="${shown}">`
    + (suffix ? `<span class="valUnit">${suffix}</span>` : "");
}

function setRangeNum(id, value, digits) {
  const inp = document.getElementById(id);
  const num = document.getElementById(id + "Num");
  const n = Number(value);
  if (inp) inp.value = n;
  if (num) num.value = digits != null && Number.isFinite(n) ? n.toFixed(digits) : n;
}

function renderInspector() {
  const box = $("#inspector");
  box.innerHTML = "";
  const sel = state.sel;
  if (!sel) { renderProjectPanel(box); return; }
  if (sel.type === "clip") renderClipPanel(box, state.clips[sel.i]);
  else if (sel.type === "music") renderMusicPanel(box, state.music[sel.i]);
  else if (sel.type === "text") renderTextPanel(box, state.texts[sel.i]);
  else if (sel.type === "shape") renderShapePanel(box, state.shapes[sel.i]);
  else if (sel.type === "image") renderImagePanel(box, state.images[sel.i]);
  else if (sel.type === "sub") renderSubPanel(box, state.subs.entries[sel.i]);
  else if (sel.type === "pip") renderPipPanel(box, state.pips[sel.i]);
}

function rotateControls(prefix, obj) {
  const r = Math.round(obj.rotate || 0);
  return `
    <div class="row">
      <button class="btn sm" id="${prefix}RotL" title="Rotate −90°">⟲ 90</button>
      <button class="btn sm" id="${prefix}RotR" title="Rotate +90°">⟳ 90</button>
      <button class="btn sm" id="${prefix}Rot0" title="Reset">0°</button>
    </div>
    ${row("Angle", rangeField(prefix + "Rot", r, { min: 0, max: 359, step: 1, suffix: "°" }))}
    <div class="row"><label><input type="checkbox" id="snapRot" ${state.snapRotate ? "checked" : ""}> Auto-snap to 90°</label></div>`;
}
function bindRotateControls(prefix, obj) {
  const apply = () => {
    renderOverlays();
    setRangeNum(prefix + "Rot", normDeg(obj.rotate));
  };
  document.getElementById(prefix + "RotL").onclick = () => { pushUndo(); obj.rotate = normDeg((obj.rotate || 0) - 90); apply(); };
  document.getElementById(prefix + "RotR").onclick = () => { pushUndo(); obj.rotate = normDeg((obj.rotate || 0) + 90); apply(); };
  document.getElementById(prefix + "Rot0").onclick = () => { pushUndo(); obj.rotate = 0; apply(); };
  bindRange(prefix + "Rot", obj, "rotate", () => { obj.rotate = normDeg(obj.rotate); apply(); });
  const snap = $("#snapRot");
  if (snap) snap.onchange = () => { state.snapRotate = snap.checked; };
}

function renderPipPanel(box, p) {
  if (!p) return;
  if (p.rotate == null) p.rotate = 0;
  const sw = $("#stage").clientWidth || 1, sh = $("#stage").clientHeight || 1;
  ensureBoxSize(p, sw, sh, (p.w || 16) / (p.h || 9));
  box.innerHTML = `
    <div class="name">▣ ${p.name}</div>
    <div class="muted">Overlay track · ${fmt(itemLen(p))} at ${fmt(p.offset)}</div>
    <div class="row"><button class="btn sm" id="pToClip">▭ Move to video track</button></div>
    <h3>Layout</h3>
    <div class="row" style="flex-wrap:wrap;gap:4px">
      ${PIP_PRESETS.map((pr, i) => `<button class="btn sm" data-pip="${i}">${pr.name}</button>`).join("")}
    </div>
    ${row("Width", rangeField("pScaleW", p.scaleW, { min: 0.05, max: MAX_BOX_SCALE, step: 0.02, digits: 2 }))}
    ${row("Height", rangeField("pScaleH", p.scaleH, { min: 0.05, max: MAX_BOX_SCALE, step: 0.02, digits: 2 }))}
    ${row("Opacity", rangeField("pOpacity", p.opacity, { min: 0.1, max: 1, step: 0.05, digits: 2 }))}
    <h3>Rotate</h3>
    ${rotateControls("p", p)}
    ${cornerControls("p", p)}
    ${borderControls("p", p)}
    <h3>Audio</h3>
    ${row("Volume", rangeField("pVol", p.volume, { min: 0, max: 2, step: 0.05, digits: 2 }))}
    <div class="row"><label><input type="checkbox" id="pMute" ${p.mute ? "checked" : ""}> Mute</label></div>
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="pOffset" step="0.1" min="0" value="${p.offset.toFixed(1)}"> s`)}
    <div class="muted">Drag to move · side handles stretch · corners keep aspect · top handle rotates.</div>`;
  box.querySelectorAll("[data-pip]").forEach((btn) => {
    btn.onclick = () => {
      pushUndo();
      applyPresetBox(p, PIP_PRESETS[+btn.dataset.pip]);
      refresh();
    };
  });
  const pToClipBtn = $("#pToClip");
  if (pToClipBtn) {
    pToClipBtn.onclick = () => {
      const i = state.sel && state.sel.type === "pip" ? state.sel.i : state.pips.indexOf(p);
      if (i < 0) return;
      pushUndo();
      pipToClip(i, { track: 0, fullFrame: false });
      refresh();
    };
  }
  bindRange("pScaleW", p, "scaleW", () => { p.scale = p.scaleW; renderOverlays(); });
  bindRange("pScaleH", p, "scaleH", renderOverlays);
  bindRange("pOpacity", p, "opacity", renderOverlays);
  bindRotateControls("p", p);
  bindCornerControls("p", p, renderOverlays);
  bindBorderControls("p", p);
  bindRange("pVol", p, "volume", pipSync);
  bindCheck("pMute", p, "mute", pipSync);
  $("#pOffset").onchange = (e) => { pushUndo(); p.offset = Math.max(0, +e.target.value || 0); refresh(); };
}

function fontSelect(id, current) {
  const customs = state.fonts.map((f) => f.family);
  return `<select id="${id}">
    ${BUILTIN_FONTS.map((f) => `<option ${current === f ? "selected" : ""}>${f}</option>`).join("")}
    ${customs.length ? `<optgroup label="Custom">${customs.map((f) => `<option ${current === f ? "selected" : ""}>${f}</option>`).join("")}</optgroup>` : ""}
  </select><button class="btn sm" id="${id}Add" title="Add a .ttf/.otf font file">＋</button>`;
}
function bindFontSelect(id, obj, key, after) {
  const sel = document.getElementById(id);
  sel.onchange = (e) => { pushUndo(); obj[key] = e.target.value; if (after) after(); };
  document.getElementById(id + "Add").onclick = async () => {
    const family = await pickFont();
    if (family) { pushUndo(); obj[key] = family; renderInspector(); if (after) after(); }
  };
}

function bindRange(id, obj, key, after, isInt) {
  const inp = document.getElementById(id);
  const num = document.getElementById(id + "Num");
  if (!inp) return;
  let undoDone = false;
  const min = parseFloat(inp.min);
  const max = parseFloat(inp.max);
  const apply = (raw, from) => {
    let n = isInt ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) return;
    n = clamp(n, min, max);
    if (isInt) n = Math.round(n);
    if (!undoDone) { pushUndo(); undoDone = true; }
    obj[key] = n;
    if (from !== "range") inp.value = String(n);
    if (num && from !== "num") num.value = String(n);
    if (after) after();
  };
  inp.addEventListener("input", () => apply(inp.value, "range"));
  inp.addEventListener("change", () => { undoDone = false; });
  if (num) {
    const commit = () => { apply(num.value, "num"); undoDone = false; };
    num.addEventListener("change", commit);
    num.addEventListener("blur", commit);
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); num.blur(); }
      e.stopPropagation();
    });
    num.addEventListener("mousedown", (e) => e.stopPropagation());
  }
}
function bindCheck(id, obj, key, after) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.addEventListener("change", () => { pushUndo(); obj[key] = inp.checked; if (after) after(); });
}
function normHex(c) {
  let s = String(c || "#ffffff").trim();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return "#ffffff";
  return s.toLowerCase();
}
/** Color swatch + editable HEX (default visible). */
function colorField(id, value) {
  const hex = normHex(value);
  return `<span class="colorField">`
    + `<input type="color" id="${id}" value="${hex}" title="Pick color">`
    + `<input type="text" class="hex" id="${id}Hex" value="${hex.toUpperCase()}" maxlength="7" spellcheck="false" title="HEX">`
    + `</span>`;
}
/** Text shadow offset/blur as a fraction of frame height (≈2px / 4px on a 540px-tall stage). */
const TEXT_SHADOW_OFFSET = 2 / 540;
const TEXT_SHADOW_BLUR = 4 / 540;
function shadowRgba(hex, alpha) {
  const c = normHex(hex || "#000000").slice(1);
  const a = alpha != null ? alpha : 0.6;
  return `rgba(${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${a})`;
}
/** CSS text-shadow scaled to a frame of height `frameH` px (default black @ 60% opacity). */
function cssTextShadow(hex, frameH, alpha) {
  const o = TEXT_SHADOW_OFFSET * frameH;
  return `${o}px ${o}px ${TEXT_SHADOW_BLUR * frameH}px ${shadowRgba(hex, alpha)}`;
}
function bindColor(id, obj, key, after) {
  const inp = document.getElementById(id);
  const hex = document.getElementById(id + "Hex");
  if (!inp) return;
  const apply = (v, fromHex) => {
    const n = normHex(v);
    obj[key] = n;
    inp.value = n;
    if (hex) hex.value = n.toUpperCase();
    if (after) after();
  };
  inp.addEventListener("input", () => apply(inp.value, false));
  inp.addEventListener("change", () => { pushUndo(); apply(inp.value, false); });
  if (hex) {
    hex.addEventListener("input", () => {
      const raw = hex.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(raw) || /^#?[0-9a-fA-F]{3}$/.test(raw)) {
        apply(raw, true);
      }
    });
    hex.addEventListener("change", () => { pushUndo(); apply(hex.value, true); });
    hex.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); hex.blur(); }
      e.stopPropagation();
    });
    hex.addEventListener("mousedown", (e) => e.stopPropagation());
  }
}

function lutMarkup(prefix, lut) {
  const builtins = builtinLuts.map((l) => `<option value="${encodeURIComponent(l.path)}">${l.name}</option>`).join("");
  return `
    <h3>LUT (color grade)</h3>
    <div class="row">
      <select id="${prefix}LutBuilt"><option value="">Built-in LUT…</option>${builtins}</select>
    </div>
    <div class="row">
      <button class="btn sm" id="${prefix}LutPick">${lut ? "Change .cube…" : "Load .cube…"}</button>
      ${lut ? `<span class="muted" style="max-width:110px;overflow:hidden;text-overflow:ellipsis" title="${lut.name}">${lut.name}</span><button class="btn sm" id="${prefix}LutOff">✕</button>` : ""}
    </div>
    ${lut ? row("Mix", rangeField(prefix + "LutInt", lut.intensity, { min: 0, max: 1, step: 0.05, digits: 2 })) : ""}
    ${lut ? `<img id="${prefix}LutPrev" class="lutPrev" alt="LUT preview">` : ""}
    ${lut ? `<div class="muted">Preview updates when paused. Export burns the LUT in.</div>` : ""}
  `;
}

function lutThumb(prefix, holder, mid) {
  const img = document.getElementById(prefix + "LutPrev");
  if (!img || !holder.lut || !mid) return;
  const loc = state.clips.length ? locate(state.t) : null;
  const c = loc ? state.clips[loc.i] : state.clips[0];
  const t = c ? c.in + (loc ? loc.local : 0) * (c.speed || 1) : 0;
  img.src = `/api/lutframe?mid=${mid}&lut=${encodeURIComponent(holder.lut.path)}&t=${t.toFixed(2)}&intensity=${holder.lut.intensity}&_=${Date.now()}`;
}

function bindLut(prefix, holder, previewMid) {
  const apply = (lut) => { pushUndo(); holder.lut = lut; renderInspector(); updateLutStage(); };
  const built = document.getElementById(prefix + "LutBuilt");
  if (built) {
    built.onchange = (e) => {
      if (!e.target.value) return;
      const path = decodeURIComponent(e.target.value);
      const found = builtinLuts.find((l) => l.path === path);
      apply({ path, name: found ? found.name : path.split(/[\\/]/).pop(), intensity: 1 });
    };
  }
  const pick = document.getElementById(prefix + "LutPick");
  if (pick) {
    pick.onclick = async () => {
      const r = await fetch("/api/pick?kind=lut");
      const j = await r.json();
      if (!j.ok) { if (j.error) alert(j.error); return; }
      apply({ path: j.lut.path, name: j.lut.name, intensity: 1 });
    };
  }
  const off = document.getElementById(prefix + "LutOff");
  if (off) off.onclick = () => apply(null);
  if (holder.lut) {
    let t = null;
    bindRange(prefix + "LutInt", holder.lut, "intensity", () => {
      clearTimeout(t);
      t = setTimeout(() => { updateLutStage(); lutThumb(prefix, holder, previewMid); }, 200);
    });
    lutThumb(prefix, holder, previewMid);
  }
}

let lutStageTimer = null;
function updateLutStage() {
  const img = $("#lutStage");
  if (!img) return;
  const loc = state.clips.length ? locate(state.t) : null;
  const c = loc ? state.clips[loc.i] : null;
  const lut = (c && c.lut) || state.canvas.lut || null;
  if (!lut || !c || state.playing) {
    img.style.display = "none";
    video.style.opacity = 1;
    return;
  }
  video.style.opacity = 0.02;
  img.style.display = "block";
  const t = c.in + loc.local * (c.speed || 1);
  clearTimeout(lutStageTimer);
  lutStageTimer = setTimeout(() => {
    img.src = `/api/lutframe?mid=${c.mid}&lut=${encodeURIComponent(lut.path)}&t=${t.toFixed(2)}&intensity=${lut.intensity}&_=${Date.now()}`;
  }, 60);
}

function renderProjectPanel(box) {
  box.innerHTML = `
    <h3>Canvas</h3>
    ${row("Preset", `<select id="pvPreset">
      ${["auto", "16:9", "9:16", "1:1", "4:5", "4:3", "3:4", "custom"].map((p) => `<option ${state.canvas.preset === p ? "selected" : ""}>${p}</option>`).join("")}
    </select>`)}
    <div class="row" id="pvCustomRow" style="display:${state.canvas.preset === "custom" ? "flex" : "none"}">
      <span class="lbl">Size</span>
      <input type="number" id="pvW" value="${state.canvas.w}" min="128" max="7680"> ×
      <input type="number" id="pvH" value="${state.canvas.h}" min="128" max="7680">
    </div>
    ${row("Mode", `<select id="pvMode">
      <option value="fit" ${state.canvas.mode === "fit" ? "selected" : ""}>Fit (pad)</option>
      <option value="fill" ${state.canvas.mode === "fill" ? "selected" : ""}>Fill (crop)</option>
      <option value="blur" ${state.canvas.mode === "blur" ? "selected" : ""}>Blur background</option>
    </select>`)}
    ${row("Background", `${colorField("pvBg", state.canvas.bg)}<span class="muted">for Fit mode</span>`)}
    ${lutMarkup("pv", state.canvas.lut)}`;
  $("#pvPreset").onchange = (e) => {
    pushUndo();
    state.canvas.preset = e.target.value;
    $("#pvCustomRow").style.display = e.target.value === "custom" ? "flex" : "none";
    layoutVideo(); renderOverlays();
  };
  $("#pvW").onchange = (e) => { state.canvas.w = clamp(+e.target.value || 1920, 128, 7680); layoutVideo(); };
  $("#pvH").onchange = (e) => { state.canvas.h = clamp(+e.target.value || 1080, 128, 7680); layoutVideo(); };
  $("#pvMode").onchange = (e) => { pushUndo(); state.canvas.mode = e.target.value; layoutVideo(); };
  bindColor("pvBg", state.canvas, "bg", layoutVideo);
  bindLut("pv", state.canvas, state.clips[0] && state.clips[0].mid);
}

function adjPresets() {
  try { return JSON.parse(localStorage.getItem("adjPresets") || "{}"); }
  catch (e) { return {}; }
}

function renderClipPanel(box, c) {
  if (!c) return;
  ensureClipLayout(c);
  ensureClipOffsets();
  const presets = adjPresets();
  box.innerHTML = `
    <div class="name">${c.name}</div>
    <div class="muted">${fmt(itemLen(c))} source · ${fmt(clipLen(c))} on timeline</div>
    <div class="row"><button class="btn sm" id="cToPip">▣ Use as overlay</button></div>
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="cOffset" step="0.1" min="0" value="${(c.offset || 0).toFixed(1)}"> s`)}
    <div class="muted">Drag the clip on the timeline to place it anywhere — gaps are allowed.</div>
    <h3>Frame layout</h3>
    <div class="row wrap">
      ${FRAME_PRESETS.map((pr, i) => `<button class="btn sm" data-frame="${i}">${pr.name}</button>`).join("")}
    </div>
    ${row("Width", rangeField("cScaleW", c.scaleW, { min: 0.05, max: MAX_BOX_SCALE, step: 0.02, digits: 2 }))}
    ${row("Height", rangeField("cScaleH", c.scaleH, { min: 0.05, max: MAX_BOX_SCALE, step: 0.02, digits: 2 }))}
    <div class="muted">Drag on stage to move · sides stretch · corners keep aspect. When resized, use the blue rotate handle to spin the clip without turning the canvas.</div>
    <h3>Transform</h3>
    ${rotateControls("c", c)}
    <div class="row">
      <button class="btn sm" id="cFlipH">⇋ Flip H</button>
      <button class="btn sm" id="cFlipV">⇵ Flip V</button>
    </div>
    <div class="muted">${isFullFrame(c)
      ? "Full-frame ±90° also reorients the canvas (Auto preset)."
      : "Inset clip: rotation spins the video only — canvas stays put."}</div>
    ${cornerControls("c", c)}
    ${row("Speed", `<input type="number" class="val valWide" id="cSpeed" min="0.25" max="4" step="0.05" value="${c.speed}"><span class="valUnit">×</span>
      <select id="cSpeedPreset" title="Presets"><option value="">Custom</option>${SPEEDS.map((s) => `<option value="${s}" ${+c.speed === s ? "selected" : ""}>${s}×</option>`).join("")}</select>`)}
    <h3>Audio</h3>
    ${row("Volume", rangeField("cVol", c.volume, { min: 0, max: 2, step: 0.05, digits: 2 }))}
    <div class="row">
      <label><input type="checkbox" id="cMute" ${c.mute ? "checked" : ""}> Mute</label>
      <label><input type="checkbox" id="cDen" ${c.denoise ? "checked" : ""}> Denoise</label>
    </div>
    ${row("Fade in", rangeField("cFadeIn", c.fadeIn, { min: 0, max: 3, step: 0.1, digits: 1 }))}
    ${row("Fade out", rangeField("cFadeOut", c.fadeOut, { min: 0, max: 3, step: 0.1, digits: 1 }))}
    <div class="row"><button class="btn sm" id="cSilence">🤫 Auto-cut silence…</button></div>
    <h3>Adjust</h3>
    ${row("Exposure", rangeField("cExp", c.adj.exposure, { min: -1, max: 1, step: 0.05, digits: 2 }))}
    ${row("Contrast", rangeField("cCon", c.adj.contrast, { min: 0.4, max: 1.6, step: 0.05, digits: 2 }))}
    ${row("Saturation", rangeField("cSat", c.adj.saturation, { min: 0, max: 2, step: 0.05, digits: 2 }))}
    ${row("Warmth", rangeField("cTemp", c.adj.temperature, { min: -100, max: 100, step: 5 }))}
    ${row("Sharpen", rangeField("cSharp", c.adj.sharpen, { min: 0, max: 1, step: 0.05, digits: 2 }))}
    <div class="row"><label><input type="checkbox" id="cVig" ${c.adj.vignette ? "checked" : ""}> Vignette</label></div>
    <div class="row">
      <select id="cPresetSel"><option value="">— preset —</option>${Object.keys(presets).map((n) => `<option>${n}</option>`).join("")}</select>
      <button class="btn sm" id="cPresetSave">Save…</button>
    </div>
    ${lutMarkup("c", c.lut)}
    <h3>Transition to next clip</h3>
    ${row("Type", `<select id="cTrans">${TRANSITIONS.map((t) => `<option ${c.trans.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>`)}
    ${row("Duration", rangeField("cTransDur", c.trans.dur, { min: 0.2, max: 2, step: 0.1, digits: 1 }))}
    <div class="muted">Transitions render on export (preview shows a hard cut).</div>`;

  box.querySelectorAll("[data-frame]").forEach((btn) => {
    btn.onclick = () => {
      const pr = FRAME_PRESETS[+btn.dataset.frame];
      if (!pr) return;
      pushUndo();
      applyPresetBox(c, pr);
      layoutVideo();
      renderInspector();
    };
  });
  const cToPipBtn = $("#cToPip");
  if (cToPipBtn) {
    cToPipBtn.onclick = () => {
      const i = state.sel && state.sel.type === "clip" ? state.sel.i : state.clips.indexOf(c);
      if (i < 0) return;
      pushUndo();
      clipToPip(i);
      refresh();
    };
  }
  $("#cOffset").onchange = (e) => {
    pushUndo();
    c.offset = Math.max(0, +e.target.value || 0);
    e.target.value = c.offset.toFixed(1);
    refresh();
  };
  bindRange("cScaleW", c, "scaleW", () => { c.scale = c.scaleW; layoutVideo(); renderInspector(); });
  bindRange("cScaleH", c, "scaleH", () => { layoutVideo(); renderInspector(); });
  const applyClipRot = () => {
    if (isFullFrame(c)) refresh();
    else { layoutVideo(); renderInspector(); }
    setRangeNum("cRot", normDeg(c.rotate));
  };
  $("#cRotL").onclick = () => { pushUndo(); c.rotate = normDeg((c.rotate || 0) - 90); applyClipRot(); };
  $("#cRotR").onclick = () => { pushUndo(); c.rotate = normDeg((c.rotate || 0) + 90); applyClipRot(); };
  $("#cRot0").onclick = () => { pushUndo(); c.rotate = 0; applyClipRot(); };
  bindRange("cRot", c, "rotate", () => { c.rotate = normDeg(c.rotate); applyClipRot(); });
  const snap = $("#snapRot");
  if (snap) snap.onchange = () => { state.snapRotate = snap.checked; };
  bindCornerControls("c", c, () => { layoutVideo(); });
  $("#cFlipH").onclick = () => { pushUndo(); c.flipH = !c.flipH; applyClipFX(); };
  $("#cFlipV").onclick = () => { pushUndo(); c.flipV = !c.flipV; applyClipFX(); };
  $("#cSpeed").onchange = (e) => {
    pushUndo();
    c.speed = clamp(parseFloat(e.target.value) || 1, 0.25, 4);
    e.target.value = c.speed;
    const pre = $("#cSpeedPreset");
    if (pre) pre.value = SPEEDS.includes(c.speed) ? String(c.speed) : "";
    afterSpeedChange(c);
  };
  $("#cSpeed").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); e.stopPropagation(); };
  const speedPre = $("#cSpeedPreset");
  if (speedPre) {
    speedPre.onchange = (e) => {
      pushUndo();
      c.speed = parseFloat(e.target.value);
      $("#cSpeed").value = c.speed;
      afterSpeedChange(c);
    };
  }
  bindRange("cVol", c, "volume", () => applyClipFX());
  bindCheck("cMute", c, "mute", () => applyClipFX());
  bindCheck("cDen", c, "denoise");
  bindRange("cFadeIn", c, "fadeIn", () => applyClipFX());
  bindRange("cFadeOut", c, "fadeOut", () => applyClipFX());
  bindRange("cExp", c.adj, "exposure", applyClipFX);
  bindRange("cCon", c.adj, "contrast", applyClipFX);
  bindRange("cSat", c.adj, "saturation", applyClipFX);
  bindRange("cTemp", c.adj, "temperature", applyClipFX);
  bindRange("cSharp", c.adj, "sharpen");
  bindCheck("cVig", c.adj, "vignette", applyClipFX);
  $("#cTrans").onchange = (e) => { pushUndo(); c.trans.type = e.target.value; refresh(); };
  bindRange("cTransDur", c.trans, "dur", () => renderTimeline());
  $("#cPresetSel").onchange = (e) => {
    const p = adjPresets()[e.target.value];
    if (p) { pushUndo(); c.adj = { ...DEFAULT_ADJ, ...p }; renderInspector(); applyClipFX(); }
  };
  $("#cPresetSave").onclick = () => {
    const name = prompt("Preset name (e.g. Mindspark Warm Product):");
    if (!name) return;
    const all = adjPresets();
    all[name] = { ...c.adj };
    localStorage.setItem("adjPresets", JSON.stringify(all));
    renderInspector();
  };
  $("#cSilence").onclick = () => autoSilence(c);
  bindLut("c", c, c.mid);
}

function renderMusicPanel(box, m) {
  if (!m) return;
  box.innerHTML = `
    <div class="name">♪ ${m.name}</div>
    <div class="muted">${fmt(itemLen(m))} at ${fmt(m.offset)}</div>
    <h3>Audio</h3>
    ${row("Volume", rangeField("mVol", m.volume, { min: 0, max: 2, step: 0.05, digits: 2 }))}
    ${row("Fade in", rangeField("mFadeIn", m.fadeIn, { min: 0, max: 5, step: 0.1, digits: 1 }))}
    ${row("Fade out", rangeField("mFadeOut", m.fadeOut, { min: 0, max: 5, step: 0.1, digits: 1 }))}
    <div class="muted">Drag the block to place it in time. Music stops at the video's end on export.</div>`;
  bindRange("mVol", m, "volume", () => { if (state.playing) musicSync(); });
  bindRange("mFadeIn", m, "fadeIn", () => { if (state.playing) musicSync(); });
  bindRange("mFadeOut", m, "fadeOut", () => { if (state.playing) musicSync(); });
}

function renderShapePanel(box, sh) {
  if (!sh) return;
  if (sh.rotate == null) sh.rotate = 0;
  if (sh.fill == null) sh.fill = true;
  if (!sh.lineStyle) sh.lineStyle = "solid";
  ensureBorder(sh);
  const lineLike = isLineShape(sh.kind);
  const sw = $("#stage").clientWidth || 1, shH = $("#stage").clientHeight || 1;
  ensureBoxSize(sh, sw, shH, (sh.scaleW || 0.28) / Math.max(sh.scaleH || 0.18, 0.01));
  const fillBlock = lineLike ? "" : `
    <h3>Fill</h3>
    <div class="row"><label><input type="checkbox" id="shFill" ${sh.fill !== false ? "checked" : ""}> Solid fill</label></div>
    <div id="shFillOpts" style="display:${sh.fill !== false ? "block" : "none"}">
      ${row("Color", colorField("shColor", sh.color || "#5eead4"))}
    </div>
    ${borderControls("sh", sh, { withStyle: true })}`;
  const lineBlock = lineLike ? `
    <h3>Line</h3>
    ${row("Color", colorField("shColor", sh.color || "#5eead4"))}
    ${row("Thickness", rangeField("shBorderW", sh.borderW || 3, { min: 1, max: 40, step: 1 }))}
    ${row("Style", `<select id="shLineStyle">${LINE_STYLES.map((s) =>
      `<option value="${s.id}" ${(sh.lineStyle || "solid") === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select>`)}
    <div class="muted">Rotate to aim the line. Drag side handles to change length / thickness area.</div>` : "";
  box.innerHTML = `
    <div class="name">⬡ ${shapeLabel(sh.kind)}</div>
    <h3>Shape</h3>
    ${row("Type", `<select id="shKind">${SHAPE_KINDS.map((k) =>
      `<option value="${k.id}" ${sh.kind === k.id ? "selected" : ""}>${k.label}</option>`).join("")}</select>`)}
    ${fillBlock}
    ${lineBlock}
    <h3>Layout</h3>
    ${row("Width", rangeField("shScaleW", sh.scaleW, { min: 0.03, max: 1, step: 0.01, digits: 2 }))}
    ${row("Height", rangeField("shScaleH", sh.scaleH, { min: 0.02, max: 1, step: 0.01, digits: 2 }))}
    ${row("Opacity", rangeField("shOpacity", sh.opacity, { min: 0.05, max: 1, step: 0.05, digits: 2 }))}
    <h3>Rotate</h3>
    ${rotateControls("sh", sh)}
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="shStart" step="0.1" min="0" value="${sh.start.toFixed(1)}"> s`)}
    ${row("Length", `<input type="number" id="shDurn" step="0.1" min="0.2" value="${sh.durn.toFixed(1)}"> s`)}
    <div class="muted">${lineLike
      ? "Line arrow tip points right by default — rotate to aim."
      : "Drag to move · side handles stretch freely · corners keep aspect · top handle rotates. Uncheck fill for outline-only."}</div>`;
  $("#shKind").onchange = (e) => {
    pushUndo();
    const next = e.target.value;
    const wasLine = isLineShape(sh.kind);
    const nowLine = isLineShape(next);
    sh.kind = next;
    if (nowLine && !wasLine) {
      sh.fill = false;
      sh.border = true;
      if (!sh.lineStyle) sh.lineStyle = "solid";
      Object.assign(sh, naturalBox(Math.max(sh.scaleW || 0.42, 0.3), 8, 1));
    } else if (!nowLine && wasLine) {
      sh.fill = true;
      Object.assign(sh, naturalBox(Math.min(sh.scaleW || 0.26, 0.4), 1, 1));
    }
    refresh();
  };
  if (!lineLike) {
    const fillOpts = $("#shFillOpts");
    const fillEl = $("#shFill");
    if (fillEl) {
      fillEl.onchange = () => {
        pushUndo();
        sh.fill = fillEl.checked;
        if (fillOpts) fillOpts.style.display = sh.fill ? "block" : "none";
        renderOverlays();
      };
    }
    bindBorderControls("sh", sh, { withStyle: true });
  } else {
    bindRange("shBorderW", sh, "borderW", renderOverlays, true);
    $("#shLineStyle").onchange = (e) => { pushUndo(); sh.lineStyle = e.target.value; renderOverlays(); };
  }
  bindColor("shColor", sh, "color", renderOverlays);
  bindRange("shScaleW", sh, "scaleW", () => { sh.scale = sh.scaleW; renderOverlays(); });
  bindRange("shScaleH", sh, "scaleH", renderOverlays);
  bindRange("shOpacity", sh, "opacity", renderOverlays);
  bindRotateControls("sh", sh);
  $("#shStart").onchange = (e) => { pushUndo(); sh.start = Math.max(0, +e.target.value || 0); refresh(); };
  $("#shDurn").onchange = (e) => { pushUndo(); sh.durn = Math.max(0.2, +e.target.value || 1); refresh(); };
}

function renderTextPanel(box, t) {
  if (!t) return;
  if (t.rotate == null) t.rotate = 0;
  ensureTextBox(t);
  if (typeof t.text === "string") t.text = t.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  box.innerHTML = `
    <div class="name">Text</div>
    <textarea id="tText" rows="4" placeholder="Type here — Enter for a new line"></textarea>
    <div class="muted" style="margin-top:4px">Press Enter for a new line. Box height grows automatically.</div>
    <h3>Layout</h3>
    ${row("Width", rangeField("tScaleW", t.scaleW, { min: 0.05, max: 1, step: 0.01, digits: 2 }))}
    ${row("Height", rangeField("tScaleH", t.scaleH, { min: 0.04, max: 0.8, step: 0.01, digits: 2 }))}
    <div class="muted">Drag sides/corners on stage to resize · corners keep aspect.</div>
    <h3>Style</h3>
    ${row("Font", fontSelect("tFont", t.font))}
    ${row("Size", rangeField("tSize", t.size, { min: 0.02, max: 0.35, step: 0.005, digits: 3 }))}
    ${row("Line gap", rangeField("tLineGap", t.lineGap, { min: 0.6, max: 3, step: 0.05, digits: 2 }))}
    ${row("Color", colorField("tColor", t.color))}
    ${row("Stroke", `${colorField("tStroke", t.stroke)}${rangeField("tStrokeW", t.strokeW, { min: 0, max: 10, step: 1 })}`)}
    <div class="row"><label><input type="checkbox" id="tShadow" ${t.shadow ? "checked" : ""}> Shadow</label>
      ${colorField("tShadowColor", t.shadowColor || "#000000")}
      <label><input type="checkbox" id="tBox" ${t.box ? "checked" : ""}> Box</label>
      ${colorField("tBoxColor", t.boxColor)}</div>
    ${row("Box alpha", rangeField("tBoxAlpha", t.boxAlpha, { min: 0, max: 1, step: 0.05, digits: 2 }))}
    ${row("Opacity", rangeField("tOpacity", t.opacity, { min: 0.1, max: 1, step: 0.05, digits: 2 }))}
    <h3>Rotate</h3>
    ${rotateControls("t", t)}
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="tStart" step="0.1" min="0" value="${t.start.toFixed(1)}"> s`)}
    ${row("Length", `<input type="number" id="tDurn" step="0.1" min="0.2" value="${t.durn.toFixed(1)}"> s`)}
    <div class="muted">Drag to move · resize like images · top handle rotates.</div>`;
  const ta = $("#tText");
  ta.value = t.text || "";
  ta.addEventListener("input", (e) => {
    t.text = String(e.target.value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    t._heightLocked = false; // new lines should grow the box, not crop
    renderOverlays();
    renderTimeline();
    setRangeNum("tScaleH", t.scaleH, 2);
  });
  ta.addEventListener("keydown", (e) => { e.stopPropagation(); });
  bindFontSelect("tFont", t, "font", () => { t._heightLocked = false; renderOverlays(); setRangeNum("tScaleH", t.scaleH, 2); });
  bindRange("tScaleW", t, "scaleW", () => {
    t.scale = t.scaleW;
    t._heightLocked = false;
    renderOverlays();
    setRangeNum("tScaleH", t.scaleH, 2);
  });
  bindRange("tScaleH", t, "scaleH", () => {
    t._heightLocked = true;
    renderOverlays();
    setRangeNum("tSize", t.size, 3);
  });
  bindRange("tSize", t, "size", () => {
    t._heightLocked = false;
    syncTextBoxFromSize(t);
    renderOverlays();
    setRangeNum("tScaleH", t.scaleH, 2);
  });
  bindRange("tLineGap", t, "lineGap", () => {
    t._heightLocked = false;
    t.scaleH = clamp(Number(t.size) * TEXT_H_FROM_SIZE, 0.05, 0.7);
    renderOverlays();
    setRangeNum("tScaleH", t.scaleH, 2);
  });
  bindColor("tColor", t, "color", renderOverlays);
  bindColor("tStroke", t, "stroke", renderOverlays);
  bindRange("tStrokeW", t, "strokeW", renderOverlays, true);
  bindCheck("tShadow", t, "shadow", renderOverlays);
  if (t.shadowColor == null) t.shadowColor = "#000000";
  bindColor("tShadowColor", t, "shadowColor", renderOverlays);
  bindCheck("tBox", t, "box", renderOverlays);
  bindColor("tBoxColor", t, "boxColor", renderOverlays);
  bindRange("tBoxAlpha", t, "boxAlpha", renderOverlays);
  bindRange("tOpacity", t, "opacity", renderOverlays);
  bindRotateControls("t", t);
  $("#tStart").onchange = (e) => { pushUndo(); t.start = Math.max(0, +e.target.value || 0); refresh(); };
  $("#tDurn").onchange = (e) => { pushUndo(); t.durn = Math.max(0.2, +e.target.value || 1); refresh(); };
}

function renderImagePanel(box, im) {
  if (!im) return;
  if (im.rotate == null) im.rotate = 0;
  const sw = $("#stage").clientWidth || 1, sh = $("#stage").clientHeight || 1;
  ensureBoxSize(im, sw, sh, (im.w || 16) / (im.h || 9));
  box.innerHTML = `
    <div class="name">🖼 ${im.name}</div>
    <h3>Layout</h3>
    ${row("Width", rangeField("iScaleW", im.scaleW, { min: 0.03, max: MAX_BOX_SCALE, step: 0.01, digits: 2 }))}
    ${row("Height", rangeField("iScaleH", im.scaleH, { min: 0.03, max: MAX_BOX_SCALE, step: 0.01, digits: 2 }))}
    ${row("Opacity", rangeField("iOpacity", im.opacity, { min: 0.1, max: 1, step: 0.05, digits: 2 }))}
    <h3>Rotate</h3>
    ${rotateControls("i", im)}
    ${cornerControls("i", im)}
    ${borderControls("i", im)}
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="iStart" step="0.1" min="0" value="${im.start.toFixed(1)}"> s`)}
    ${row("Length", `<input type="number" id="iDurn" step="0.1" min="0.2" value="${im.durn.toFixed(1)}"> s`)}
    <div class="muted">Drag to move · side handles stretch · corners keep aspect · top handle rotates.</div>`;
  bindRange("iScaleW", im, "scaleW", () => { im.scale = im.scaleW; renderOverlays(); });
  bindRange("iScaleH", im, "scaleH", renderOverlays);
  bindRange("iOpacity", im, "opacity", renderOverlays);
  bindRotateControls("i", im);
  bindCornerControls("i", im, renderOverlays);
  bindBorderControls("i", im);
  $("#iStart").onchange = (e) => { pushUndo(); im.start = Math.max(0, +e.target.value || 0); refresh(); };
  $("#iDurn").onchange = (e) => { pushUndo(); im.durn = Math.max(0.2, +e.target.value || 1); refresh(); };
}

function renderSubPanel(box, e) {
  if (!e) return;
  const st = state.subs.style;
  box.innerHTML = `
    <div class="name">💬 Subtitle</div>
    <textarea id="sText" rows="3" placeholder="Enter for a new line"></textarea>
    <h3>Timing</h3>
    ${row("Start", `<input type="number" id="sStart" step="0.1" min="0" value="${e.start.toFixed(1)}"> s`)}
    ${row("Length", `<input type="number" id="sDurn" step="0.1" min="0.2" value="${e.durn.toFixed(1)}"> s`)}
    <div class="row">
      <button class="btn sm" id="sAdd">+ Add at playhead</button>
      <button class="btn sm" id="sImport">Import .srt</button>
    </div>
    <h3>Style (all subtitles)</h3>
    ${row("Font", fontSelect("sFont", st.font))}
    ${row("Size", rangeField("sSize", st.size, { min: 0.02, max: 0.15, step: 0.005, digits: 3 }))}
    ${row("Color", colorField("sColor", st.color))}
    ${row("Stroke", `${colorField("sStroke", st.stroke)}${rangeField("sStrokeW", st.strokeW, { min: 0, max: 8, step: 1 })}`)}
    <div class="row"><label><input type="checkbox" id="sShadow" ${st.shadow ? "checked" : ""}> Shadow</label>
      ${colorField("sShadowColor", st.shadowColor || "#000000")}
      <label><input type="checkbox" id="sBox" ${st.box ? "checked" : ""}> Box</label>
      ${colorField("sBoxColor", st.boxColor)}</div>
    ${row("Box alpha", rangeField("sBoxAlpha", st.boxAlpha, { min: 0, max: 1, step: 0.05, digits: 2 }))}
    ${row("Position", rangeField("sY", st.y, { min: 0.5, max: 0.97, step: 0.01, digits: 2 }))}
    <div class="muted">Bengali and other complex scripts render correctly on export (libass + HarfBuzz). Use a Bangla-capable font like Nirmala UI.</div>`;
  const sTa = $("#sText");
  sTa.value = String(e.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  sTa.addEventListener("input", (ev) => {
    e.text = String(ev.target.value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    renderTimeline();
    subPreviewTick();
  });
  sTa.addEventListener("keydown", (ev) => { ev.stopPropagation(); });
  $("#sStart").onchange = (ev) => { pushUndo(); e.start = Math.max(0, +ev.target.value || 0); refresh(); };
  $("#sDurn").onchange = (ev) => { pushUndo(); e.durn = Math.max(0.2, +ev.target.value || 1); refresh(); };
  $("#sAdd").onclick = addSub;
  $("#sImport").onclick = importSrt;
  bindFontSelect("sFont", st, "font", subPreviewTick);
  bindRange("sSize", st, "size", subPreviewTick);
  bindColor("sColor", st, "color", subPreviewTick);
  bindColor("sStroke", st, "stroke", subPreviewTick);
  bindRange("sStrokeW", st, "strokeW", subPreviewTick, true);
  bindCheck("sBox", st, "box", subPreviewTick);
  bindColor("sBoxColor", st, "boxColor", subPreviewTick);
  bindRange("sBoxAlpha", st, "boxAlpha", subPreviewTick);
  bindCheck("sShadow", st, "shadow", subPreviewTick);
  if (st.shadowColor == null) st.shadowColor = "#000000";
  bindColor("sShadowColor", st, "shadowColor", subPreviewTick);
  bindRange("sY", st, "y", subPreviewTick);
}

/* ---------- edits ---------- */

function splitMediaItem(arr, i, type) {
  const item = arr[i];
  if (!item) return false;
  if (itemLaneLocked(type, i)) return false;
  const spd = item.speed || 1;
  const start = item.offset != null ? item.offset : 0;
  const len = type === "clip" ? clipLen(item) : itemLen(item);
  if (state.t <= start + 0.05 || state.t >= start + len - 0.05) return false;
  const local = state.t - start;
  const cutSrc = item.in + local * spd;
  if (cutSrc < item.in + 0.05 || cutSrc > item.out - 0.05) return false;
  pushUndo();
  const right = JSON.parse(JSON.stringify(item));
  right.in = cutSrc;
  right.offset = state.t;
  if (type === "clip") {
    right.trans = { ...(item.trans || { type: "none", dur: 0.5 }) };
    item.trans = { type: "none", dur: 0.5 };
  }
  if (type === "music" || type === "pip") right.uid = uid();
  item.out = cutSrc;
  arr.splice(i + 1, 0, right);
  state.sel = { type, i: i + 1 };
  return true;
}

function splitTimedItem(arr, i, type) {
  const item = arr[i];
  if (!item) return false;
  if (itemLaneLocked(type, i)) return false;
  const start = Number(item.start) || 0;
  const durn = Math.max(0.05, Number(item.durn) || 0);
  if (state.t <= start + 0.05 || state.t >= start + durn - 0.05) return false;
  pushUndo();
  const right = JSON.parse(JSON.stringify(item));
  right.start = state.t;
  right.durn = start + durn - state.t;
  item.durn = state.t - start;
  arr.splice(i + 1, 0, right);
  state.sel = { type, i: i + 1 };
  return true;
}

function splitAtPlayhead() {
  // Prefer the selected item — never silently cut Video when something else is selected.
  const sel = state.sel;
  if (sel) {
    let ok = false;
    if (sel.type === "clip") ok = splitMediaItem(state.clips, sel.i, "clip");
    else if (sel.type === "pip") ok = splitMediaItem(state.pips, sel.i, "pip");
    else if (sel.type === "music") ok = splitMediaItem(state.music, sel.i, "music");
    else if (sel.type === "text") ok = splitTimedItem(state.texts, sel.i, "text");
    else if (sel.type === "shape") ok = splitTimedItem(state.shapes, sel.i, "shape");
    else if (sel.type === "image") ok = splitTimedItem(state.images, sel.i, "image");
    else if (sel.type === "sub") ok = splitTimedItem(state.subs.entries, sel.i, "sub");
    if (ok) { refresh(); return; }
    // Selection exists but playhead isn't inside it — don't fall through to Video.
    return;
  }
  // Nothing selected: split the main video under the playhead (legacy behavior).
  const loc = locate(state.t);
  if (!loc) return;
  if (itemLaneLocked("clip", loc.i)) return;
  if (splitMediaItem(state.clips, loc.i, "clip")) refresh();
}

function duplicateSelected() {
  if (!state.sel) return;
  if (itemLaneLocked(state.sel.type, state.sel.i)) return;
  pushUndo();
  const { type, i } = state.sel;
  if (type === "clip") {
    const c2 = JSON.parse(JSON.stringify(state.clips[i]));
    ensureClipOffsets();
    c2.offset = (state.clips[i].offset || 0) + clipLen(state.clips[i]);
    state.clips.splice(i + 1, 0, c2);
    state.sel = { type: "clip", i: i + 1 };
  } else if (type === "music") {
    const m2 = JSON.parse(JSON.stringify(state.music[i]));
    m2.offset += itemLen(m2);
    m2.uid = uid();
    preferOrPackTrack(state.music, m2, -1, m2.track, mediaSpan);
    state.music.splice(i + 1, 0, m2);
    state.sel = { type: "music", i: i + 1 };
  } else if (type === "text") {
    const t2 = JSON.parse(JSON.stringify(state.texts[i]));
    t2.start += t2.durn;
    preferOrPackTrack(state.texts, t2, -1, t2.track, timedSpan);
    state.texts.splice(i + 1, 0, t2);
    state.sel = { type: "text", i: i + 1 };
  } else if (type === "shape") {
    const s2 = JSON.parse(JSON.stringify(state.shapes[i]));
    s2.start += s2.durn;
    preferOrPackTrack(state.shapes, s2, -1, s2.track, timedSpan);
    state.shapes.splice(i + 1, 0, s2);
    state.sel = { type: "shape", i: i + 1 };
  } else if (type === "image") {
    const i2 = JSON.parse(JSON.stringify(state.images[i]));
    i2.start += i2.durn;
    preferOrPackTrack(state.images, i2, -1, i2.track, timedSpan);
    state.images.splice(i + 1, 0, i2);
    state.sel = { type: "image", i: i + 1 };
  } else if (type === "sub") {
    const s2 = JSON.parse(JSON.stringify(state.subs.entries[i]));
    s2.start += s2.durn;
    state.subs.entries.splice(i + 1, 0, s2);
    state.sel = { type: "sub", i: i + 1 };
  } else if (type === "pip") {
    const p2 = JSON.parse(JSON.stringify(state.pips[i]));
    p2.offset += itemLen(p2);
    p2.uid = uid();
    preferOrPackTrack(state.pips, p2, -1, p2.track, mediaSpan);
    state.pips.splice(i + 1, 0, p2);
    state.sel = { type: "pip", i: i + 1 };
  }
  refresh();
}

/** In-app clipboard for timeline items (Ctrl+C / Ctrl+V). */
let itemClipboard = null;

function selectedItemRef() {
  if (!state.sel) return null;
  const { type, i } = state.sel;
  const map = {
    clip: state.clips, music: state.music, pip: state.pips,
    text: state.texts, shape: state.shapes, image: state.images,
    sub: state.subs.entries,
  };
  const arr = map[type];
  if (!arr || !arr[i]) return null;
  return { type, i, item: arr[i] };
}

function copySelected() {
  const ref = selectedItemRef();
  if (!ref) return;
  itemClipboard = { type: ref.type, item: JSON.parse(JSON.stringify(ref.item)) };
}

function pasteClipboard() {
  if (!itemClipboard || !itemClipboard.item) return;
  const type = itemClipboard.type;
  // Don't paste onto a locked lane of that type if selection is locked; still allow paste as new item
  pushUndo();
  const item = JSON.parse(JSON.stringify(itemClipboard.item));
  const t0 = Math.max(0, state.t);
  if (type === "clip") {
    ensureClipOffsets();
    item.offset = t0;
    state.clips.push(item);
    state.sel = { type: "clip", i: state.clips.length - 1 };
  } else if (type === "music") {
    item.offset = t0;
    item.uid = uid();
    assignPackedTrack(state.music, item, -1, mediaSpan);
    state.music.push(item);
    state.sel = { type: "music", i: state.music.length - 1 };
  } else if (type === "pip") {
    item.offset = t0;
    item.uid = uid();
    assignPackedTrack(state.pips, item, -1, mediaSpan);
    state.pips.push(item);
    state.sel = { type: "pip", i: state.pips.length - 1 };
  } else if (type === "text") {
    item.start = t0;
    assignPackedTrack(state.texts, item, -1, timedSpan);
    state.texts.push(item);
    state.sel = { type: "text", i: state.texts.length - 1 };
  } else if (type === "shape") {
    item.start = t0;
    assignPackedTrack(state.shapes, item, -1, timedSpan);
    state.shapes.push(item);
    state.sel = { type: "shape", i: state.shapes.length - 1 };
  } else if (type === "image") {
    item.start = t0;
    assignPackedTrack(state.images, item, -1, timedSpan);
    state.images.push(item);
    state.sel = { type: "image", i: state.images.length - 1 };
  } else if (type === "sub") {
    item.start = t0;
    state.subs.entries.push(item);
    state.subs.entries.sort((a, b) => a.start - b.start);
    const ni = state.subs.entries.indexOf(item);
    state.sel = { type: "sub", i: Math.max(0, ni) };
  } else {
    return;
  }
  refresh();
}

function deleteSelected() {
  if (!state.sel) return;
  if (itemLaneLocked(state.sel.type, state.sel.i)) return;
  pushUndo();
  const { type, i } = state.sel;
  if (type === "clip") state.clips.splice(i, 1);         // ripple: main track is sequential
  else if (type === "music") { getAudio(state.music[i]).pause(); state.music.splice(i, 1); }
  else if (type === "text") state.texts.splice(i, 1);
  else if (type === "shape") state.shapes.splice(i, 1);
  else if (type === "image") state.images.splice(i, 1);
  else if (type === "sub") state.subs.entries.splice(i, 1);
  else if (type === "pip") {
    const p = state.pips[i];
    if (pipVideoCache[p.uid]) { releaseMediaEl(pipVideoCache[p.uid]); delete pipVideoCache[p.uid]; }
    state.pips.splice(i, 1);
  }
  state.sel = null;
  activeClip = -1;
  state.t = clamp(state.t, 0, totalDur());
  refresh();
}

/** Grab the current preview frame and add it to the media library as an image. */
async function captureScreenshotToBin() {
  const status = $("#exportStatus");
  const src = pickScreenshotSource();
  if (!src) {
    alert("Nothing to capture — place the playhead on a video, overlay, or image.");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = src.w;
  canvas.height = src.h;
  try {
    canvas.getContext("2d").drawImage(src.el, 0, 0, src.w, src.h);
  } catch (err) {
    alert("Could not read this frame (browser security). Try another clip.");
    return;
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    alert("Screenshot failed.");
    return;
  }
  const stamp = fmt(state.t).replace(/:/g, "-");
  const file = new File([blob], `Snapshot ${stamp}.png`, { type: "image/png" });
  if (status) status.textContent = "Saving screenshot…";
  try {
    const j = await uploadOneFile(file);
    if (!j.ok || !j.item) {
      alert(j.error || "Could not save screenshot.");
      return;
    }
    rememberBin(j.item, "image");
    if (status) status.textContent = "Screenshot added to media";
    setTimeout(() => {
      if (status && status.textContent === "Screenshot added to media") status.textContent = "";
    }, 2200);
  } catch (err) {
    alert(String(err && err.message || err));
    if (status) status.textContent = "";
  }
}

function pickScreenshotSource() {
  // Prefer selected pip video if it's the active selection.
  if (state.sel && state.sel.type === "pip") {
    const p = state.pips[state.sel.i];
    const el = p && getPipVideo(p);
    if (el && el.videoWidth > 1) return { el, w: el.videoWidth, h: el.videoHeight };
  }
  // Main clip under the playhead (or currently loaded).
  if (video && video.videoWidth > 1 && video.readyState >= 2) {
    return { el: video, w: video.videoWidth, h: video.videoHeight };
  }
  // Visible image overlay under the playhead.
  const ov = [...document.querySelectorAll("#ovLayer .ovImage")].find((el) => {
    const im = state.images[+el.dataset.i];
    return im && state.t >= im.start - 1e-6 && state.t <= im.start + (im.durn || 0) + 1e-6;
  });
  const node = ov && ov.querySelector("img");
  if (node && node.naturalWidth > 1) {
    return { el: node, w: node.naturalWidth, h: node.naturalHeight };
  }
  return null;
}

/* ---------- auto silence removal ---------- */

async function autoSilence(c) {
  const minS = parseFloat(prompt("Remove pauses longer than (seconds):", "0.6") || "0");
  if (!minS || minS <= 0) return;
  $("#exportStatus").textContent = "Analyzing audio…";
  const r = await fetch(`/api/silence?mid=${c.mid}&min=${minS}&db=-35`);
  const j = await r.json();
  $("#exportStatus").textContent = "";
  if (!j.ok) { alert(j.error || "Analysis failed."); return; }
  const pad = 0.12;
  const silences = j.silences
    .map(([a, b]) => [Math.max(a + pad, c.in), Math.min(b - pad, c.out)])
    .filter(([a, b]) => b - a > 0.05 && b > c.in && a < c.out);
  if (!silences.length) { alert("No silent sections found in this clip."); return; }
  const removed = silences.reduce((s, [a, b]) => s + (b - a), 0);
  if (!confirm(`${silences.length} silent section(s) found — ${removed.toFixed(1)}s of pauses.\nCut them out?`)) return;
  pushUndo();
  const segments = [];
  let pos = c.in;
  for (const [a, b] of silences) {
    if (a > pos + 0.08) segments.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (c.out > pos + 0.08) segments.push([pos, c.out]);
  if (!segments.length) { alert("Everything would be removed — aborting."); undoStack.pop(); return; }
  const idx = state.clips.indexOf(c);
  const pieces = segments.map(([a, b], n) => {
    const p = JSON.parse(JSON.stringify(c));
    p.in = a; p.out = b;
    p.trans = n === segments.length - 1 ? { ...c.trans } : { type: "none", dur: 0.5 };
    return p;
  });
  state.clips.splice(idx, 1, ...pieces);
  state.sel = { type: "clip", i: idx };
  refresh();
  $("#exportStatus").textContent = `Removed ${removed.toFixed(1)}s of silence (${segments.length} segments kept).`;
}

/* ---------- refresh ---------- */

function refresh() {
  gcMediaCaches();
  renderTimeline();
  renderInspector();
  renderOverlays();
  updateTimeLabel();
  syncPreview(state.playing);
  renderUserGuides();
  updateUndoButtons();
  renderBin();
  $("#exportBtn").disabled = !canExport();
  $("#zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
}

/* ---------- timeline gestures ---------- */

function timelineX(e) {
  const rect = $("#timeline").getBoundingClientRect();
  return e.clientX - rect.left - 10;
}

$("#timeline").addEventListener("mousedown", (e) => {
  const handle = e.target.closest(".handle");
  const block = e.target.closest(".block");
  if (handle && block) {
    const type = block.dataset.type, i = +block.dataset.i;
    if (itemLaneLocked(type, i)) { state.sel = { type, i }; refresh(); return; }
    const item = { clip: state.clips, music: state.music, pip: state.pips, text: state.texts, shape: state.shapes, image: state.images, sub: state.subs.entries }[type][i];
    if (type === "clip") ensureClipOffsets();
    state.sel = { type, i };
    pushUndo();
    gesture = {
      kind: "trim-" + handle.dataset.h, type, i, startX: e.clientX,
      origIn: item.in, origOut: item.out, origOffset: item.offset ?? item.start ?? 0, origDurn: item.durn ?? 0,
    };
    refresh();
  } else if (block) {
    const type = block.dataset.type, i = +block.dataset.i;
    state.sel = { type, i };
    if (itemLaneLocked(type, i)) { refresh(); return; }
    const item = { clip: state.clips, music: state.music, pip: state.pips, text: state.texts, shape: state.shapes, image: state.images, sub: state.subs.entries }[type][i];
    if (type === "clip") ensureClipOffsets();
    gesture = {
      kind: "move-" + type, type, i, startX: e.clientX, startY: e.clientY,
      origOffset: item.offset ?? item.start ?? 0, moved: false, undoDone: false,
    };
    refresh();
  } else {
    gesture = { kind: "scrub" };
    setT(timelineX(e) / pps);
  }
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!gesture) return;
  if (gesture.kind === "tl-resize") {
    state.tlH = clamp(gesture.origH + (e.clientY - gesture.startY), 120, 520);
    applyLaneHeights();
    return;
  }
  if (gesture.kind === "place-guide-h") {
    const { y } = stageNormFromEvent(e);
    gesture.y = y;
    renderGuideLayer([], [], { axis: "h", val: y });
    return;
  }
  if (gesture.kind === "place-guide-v") {
    const { x } = stageNormFromEvent(e);
    gesture.x = x;
    renderGuideLayer([], [], { axis: "v", val: x });
    return;
  }
  if (gesture.kind === "move-guide-h") {
    const { y } = stageNormFromEvent(e);
    gesture.y = y;
    if (state.canvas.guides.h[gesture.index] != null) {
      state.canvas.guides.h[gesture.index] = +clamp(y, 0, 1).toFixed(4);
    }
    renderGuideLayer([], [], pointerOverRulerBand(e, "h") || !pointerOverStage(e) ? { axis: "h", val: y } : null);
    return;
  }
  if (gesture.kind === "move-guide-v") {
    const { x } = stageNormFromEvent(e);
    gesture.x = x;
    if (state.canvas.guides.v[gesture.index] != null) {
      state.canvas.guides.v[gesture.index] = +clamp(x, 0, 1).toFixed(4);
    }
    renderGuideLayer([], [], pointerOverRulerBand(e, "v") || !pointerOverStage(e) ? { axis: "v", val: x } : null);
    return;
  }
  if (gesture.kind === "lane-resize") {
    const h = clamp(gesture.origH + (e.clientY - gesture.startY), 28, 160);
    state.laneH[gesture.laneId] = Math.round(h);
    const head = document.querySelector(`#tlHeads .laneHead[data-lane="${gesture.laneId}"]`);
    const lane = document.querySelector(`#lanes .lane[data-lane="${gesture.laneId}"]`);
    if (head) head.style.height = h + "px";
    if (lane) lane.style.height = h + "px";
    return;
  }
  if (gesture.kind === "move-overlay") {
    const rect = gesture.rect;
    const arr = { text: state.texts, image: state.images, pip: state.pips, shape: state.shapes }[gesture.type];
    const it = arr[gesture.i];
    if (!it) return;
    const dx = (e.clientX - (gesture.originClientX ?? e.clientX)) / Math.max(rect.width, 1);
    const dy = (e.clientY - (gesture.originClientY ?? e.clientY)) / Math.max(rect.height, 1);
    const ox = gesture.startX != null ? gesture.startX : it.x;
    const oy = gesture.startY != null ? gesture.startY : it.y;
    applyItemPos(it, ox + dx, oy + dy);
    snapItemToGuides(it, gesture.type, gesture.i);
    renderOverlays();
    return;
  }
  if (gesture.kind === "move-main") {
    const c = state.clips[activeClip];
    if (!c) return;
    ensureClipLayout(c);
    const rect = gesture.rect;
    const dx = (e.clientX - (gesture.originClientX ?? e.clientX)) / Math.max(rect.width, 1);
    const dy = (e.clientY - (gesture.originClientY ?? e.clientY)) / Math.max(rect.height, 1);
    const ox = gesture.startX != null ? gesture.startX : c.x;
    const oy = gesture.startY != null ? gesture.startY : c.y;
    applyItemPos(c, ox + dx, oy + dy);
    layoutVideo();
    snapItemToGuides(c, "clip", activeClip);
    layoutVideo();
    return;
  }
  if (gesture.kind === "pane-left") {
    const w = clamp(gesture.startW + (e.clientX - gesture.startX), 160, 480);
    state.leftPane = w;
    applyPaneWidths();
    return;
  }
  if (gesture.kind === "pane-right") {
    const w = clamp(gesture.startW - (e.clientX - gesture.startX), 220, 520);
    state.rightPane = w;
    applyPaneWidths();
    return;
  }
  if (gesture.kind === "scale-overlay") {
    const arr = { pip: state.pips, image: state.images, shape: state.shapes, text: state.texts }[gesture.type];
    const it = arr[gesture.i];
    if (!it) return;
    const rect = gesture.rect;
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    resizeByHandle(it, gesture.corner, mx, my, gesture.start, {
      sourceAspect: gesture.type === "pip" || gesture.type === "image",
    });
    snapResizeToGuides(it, gesture.corner, gesture.start, gesture.type, gesture.i);
    if (gesture.type === "text") {
      const corner = gesture.corner.length === 2;
      if (corner) {
        // Uniform scale — font tracks box.
        it._heightLocked = false;
        syncTextSizeFromBox(it);
      } else if (gesture.corner === "n" || gesture.corner === "s") {
        // User set frame height — keep it and fit text inside.
        it._heightLocked = true;
      } else {
        // Width-only: allow height to reflow for wrapped lines.
        it._heightLocked = false;
      }
    }
    renderOverlays();
    const wId = gesture.type === "pip" ? "pScaleW"
      : gesture.type === "shape" ? "shScaleW"
      : gesture.type === "text" ? "tScaleW"
      : "iScaleW";
    const hId = gesture.type === "pip" ? "pScaleH"
      : gesture.type === "shape" ? "shScaleH"
      : gesture.type === "text" ? "tScaleH"
      : "iScaleH";
    syncSizeInputs(it, wId, hId);
    if (gesture.type === "text") setRangeNum("tSize", it.size, 3);
    return;
  }
  if (gesture.kind === "scale-main") {
    const c = state.clips[activeClip];
    if (!c) return;
    ensureClipLayout(c);
    const rect = gesture.rect;
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    resizeByHandle(c, gesture.corner, mx, my, gesture.start, { sourceAspect: true });
    layoutVideo();
    snapResizeToGuides(c, gesture.corner, gesture.start, "clip", activeClip);
    // Snap can break AR — re-apply source aspect for corner drags.
    if (gesture.corner && gesture.corner.length === 2 && c.w && c.h) {
      const stage = $("#stage");
      const sw = stage.clientWidth || 1, sh = stage.clientHeight || 1;
      const aspect = (c.w / Math.max(c.h, 1e-6)) * sh / sw;
      const cur = c.scaleW / Math.max(c.scaleH, 1e-6);
      if (Math.abs(cur - aspect) > 0.002) {
        c.scaleH = clamp(c.scaleW / aspect, 0.05, MAX_BOX_SCALE);
        c.scale = c.scaleW;
        layoutVideo();
      }
    }
    syncSizeInputs(c, "cScaleW", "cScaleH");
    return;
  }
  if (gesture.kind === "rotate-overlay") {
    const arr = { pip: state.pips, image: state.images, text: state.texts, shape: state.shapes }[gesture.type];
    const it = arr[gesture.i];
    if (!it) return;
    const ang = Math.atan2(e.clientY - gesture.cy, e.clientX - gesture.cx) * 180 / Math.PI;
    it.rotate = applyRotateSnap(gesture.origRotate + (ang - gesture.startAngle));
    renderOverlays();
    const rotInp = $("#pRot") || $("#iRot") || $("#tRot") || $("#shRot");
    if (rotInp) {
      const id = rotInp.id;
      setRangeNum(id, Math.round(it.rotate));
    }
    return;
  }
  if (gesture.kind === "rotate-main") {
    const c = state.clips[activeClip];
    if (!c) return;
    const ang = Math.atan2(e.clientY - gesture.cy, e.clientX - gesture.cx) * 180 / Math.PI;
    c.rotate = applyRotateSnap(gesture.origRotate + (ang - gesture.startAngle));
    layoutVideo();
    setRangeNum("cRot", Math.round(normDeg(c.rotate)));
    return;
  }
  const dx = (e.clientX - (gesture.startX || 0)) / pps;
  if (gesture.kind === "scrub") {
    setT(timelineX(e) / pps);
  } else if (["move-music", "move-pip", "move-text", "move-shape", "move-image", "move-sub"].includes(gesture.kind)) {
    const arr = { music: state.music, pip: state.pips, text: state.texts, shape: state.shapes, image: state.images, sub: state.subs.entries }[gesture.type];
    const it = arr[gesture.i];
    if (!it) return;
    const movedFar = Math.abs(e.clientX - gesture.startX) > 4 || Math.abs(e.clientY - (gesture.startY || 0)) > 4;
    if (!gesture.undoDone && movedFar) { pushUndo(); gesture.undoDone = true; }
    const key = gesture.type === "music" || gesture.type === "pip" ? "offset" : "start";
    const dur = timelineItemDur(gesture.type, it);
    it[key] = snapBlock(gesture.origOffset + dx, dur, gesture.type, gesture.i);
    if (gesture.type === "pip" || gesture.type === "music" || gesture.type === "text"
      || gesture.type === "shape" || gesture.type === "image") {
      const prefix = gesture.type === "pip" ? "pip-"
        : gesture.type === "music" ? "music-"
        : gesture.type === "text" ? "text-"
        : gesture.type === "shape" ? "shape-"
        : "image-";
      const pool = gesture.type === "pip" ? state.pips
        : gesture.type === "music" ? state.music
        : gesture.type === "text" ? state.texts
        : gesture.type === "shape" ? state.shapes
        : state.images;
      const dy = e.clientY - (gesture.startY || 0);
      // PiP dragged onto a Video lane → convert back to main clip on mouseup
      if (gesture.type === "pip") {
        const vidHit = trackUnderPoint(e.clientX, e.clientY, "video-");
        const lid = laneIdUnderPoint(e.clientX, e.clientY);
        if (vidHit && vidHit.kind === "track") {
          gesture.convertToClip = vidHit.track;
        } else if (lid && lid.startsWith("video-")) {
          gesture.convertToClip = +lid.slice(6);
        } else {
          delete gesture.convertToClip;
        }
      }
      if (gesture.convertToClip == null) {
        const hit = trackUnderPoint(e.clientX, e.clientY, prefix);
        if (hit && hit.kind === "track") {
          if (it.track !== hit.track) it.track = hit.track;
        } else if (Math.abs(dy) > 28) {
          const alone = pool.every((x, idx) => idx === gesture.i || x.track !== it.track);
          if (!alone) it.track = nextTrackId(pool);
        }
      }
    }
    renderTimeline(); overlayTick();
  } else if (gesture.kind === "move-clip") {
    const dy = e.clientY - (gesture.startY || 0);
    if (Math.abs(e.clientX - gesture.startX) > 4 || Math.abs(dy) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    if (!gesture.undoDone) { pushUndo(); gesture.undoDone = true; }
    const c = state.clips[gesture.i];
    if (!c) return;
    ensureClipOffsets();
    ensureClipTracks();
    c.offset = snapBlock(gesture.origOffset + dx, clipLen(c), "clip", gesture.i);
    // Vertical: Video lane = retrack; Overlay lane = convert to PiP on mouseup
    const hit = trackUnderPoint(e.clientX, e.clientY, "video-");
    const pipHit = trackUnderPoint(e.clientX, e.clientY, "pip-");
    const ownId = videoLaneId(clipTrack(c));
    const lid = laneIdUnderPoint(e.clientX, e.clientY);
    if (pipHit && pipHit.kind === "track") {
      gesture.convertToPip = pipHit.track;
    } else if (lid && lid.startsWith("pip-")) {
      gesture.convertToPip = +lid.slice(4);
    } else if (lid && (lid.startsWith("text-") || lid.startsWith("shape-") || lid.startsWith("image-"))) {
      gesture.convertToPip = nextTrackId(state.pips);
    } else {
      delete gesture.convertToPip;
      if (hit && hit.kind === "track") {
        c.track = hit.track;
      } else if (lid !== ownId && Math.abs(dy) > 24) {
        c.track = nextTrackId(state.clips);
      }
    }
    renderTimeline();
  } else if (gesture.kind === "trim-l" || gesture.kind === "trim-r") {
    const arr = { clip: state.clips, music: state.music, pip: state.pips, text: state.texts, shape: state.shapes, image: state.images, sub: state.subs.entries }[gesture.type];
    const item = arr[gesture.i];
    if (!item) return;
    if (gesture.type === "text" || gesture.type === "shape" || gesture.type === "image" || gesture.type === "sub") {
      if (gesture.kind === "trim-l") {
        const end = gesture.origOffset + gesture.origDurn;
        const ns = clamp(snap(gesture.origOffset + dx, gesture.type, gesture.i, [end]), 0, end - 0.2);
        item.durn = end - ns;
        item.start = ns;
      } else {
        const start = gesture.origOffset;
        const ne = Math.max(start + 0.2, snap(gesture.origOffset + gesture.origDurn + dx, gesture.type, gesture.i, [start]));
        item.durn = ne - start;
      }
    } else {
      const spd = item.speed || 1;
      const origLen = (gesture.origOut - gesture.origIn) / spd;
      if (gesture.kind === "trim-l") {
        const right = gesture.origOffset + origLen;
        let newOff = snap(gesture.origOffset + dx, gesture.type, gesture.i, [right]);
        newOff = clamp(newOff, 0, right - 0.1 / spd);
        const deltaT = newOff - gesture.origOffset;
        item.offset = newOff;
        item.in = clamp(gesture.origIn + deltaT * spd, 0, gesture.origOut - 0.1);
      } else {
        const left = gesture.origOffset;
        let newEnd = snap(left + origLen + dx, gesture.type, gesture.i, [left]);
        newEnd = Math.max(left + 0.1 / spd, newEnd);
        item.out = clamp((newEnd - left) * spd + gesture.origIn, gesture.origIn + 0.1, item.dur);
      }
    }
    renderTimeline();
  }
});

document.addEventListener("mouseup", (e) => {
  if (!gesture) return;
  if (gesture.kind === "place-guide-h" || gesture.kind === "place-guide-v"
    || gesture.kind === "move-guide-h" || gesture.kind === "move-guide-v") {
    commitGuideGesture(e);
    return;
  }
  const wasEdit = gesture.kind !== "scrub" && gesture.kind !== "lane-resize";
  const wasOverlay = gesture.kind === "move-overlay" || gesture.kind === "scale-overlay" || gesture.kind === "rotate-overlay"
    || gesture.kind === "move-main" || gesture.kind === "scale-main" || gesture.kind === "rotate-main";
  const wasPane = gesture.kind === "pane-left" || gesture.kind === "pane-right";
  if (wasPane) {
    document.querySelectorAll(".paneGrip").forEach((g) => g.classList.remove("dragging"));
    persistPanes();
  }
  if (gesture.kind === "lane-resize") {
    document.querySelectorAll(".laneResize.dragging").forEach((g) => g.classList.remove("dragging"));
  }
  // Finish clip ↔ overlay conversions after the drag
  if (gesture.kind === "move-clip" && gesture.convertToPip != null && gesture.moved) {
    const i = gesture.i;
    const track = gesture.convertToPip;
    if (state.clips[i]) clipToPip(i, { track, keepLayout: false });
  } else if (gesture.kind === "move-pip" && gesture.convertToClip != null && gesture.undoDone) {
    const i = gesture.i;
    const track = gesture.convertToClip;
    if (state.pips[i]) pipToClip(i, { track, fullFrame: false });
  }
  gesture = null;
  clearCanvasGuides();
  clearTlGuide();
  if (wasOverlay) { renderInspector(); layoutVideo(); return; }
  if (wasEdit && !wasPane) {
    state.t = clamp(state.t, 0, totalDur());
    refresh();
  }
});

function setLeftHidden(hidden) {
  state.leftHidden = !!hidden;
  applyPaneWidths();
  persistPanes();
  layoutVideo();
  renderOverlays();
}
function setRightHidden(hidden) {
  state.rightHidden = !!hidden;
  applyPaneWidths();
  persistPanes();
}

function applyPaneWidths() {
  document.documentElement.style.setProperty("--left-pane", state.leftPane + "px");
  document.documentElement.style.setProperty("--right-pane", state.rightPane + "px");
  document.body.classList.toggle("left-pane-hidden", !!state.leftHidden);
  document.body.classList.toggle("right-pane-hidden", !!state.rightHidden);
  const el = $("#edgeToggleLeft");
  const er = $("#edgeToggleRight");
  if (el) {
    el.textContent = state.leftHidden ? "›" : "‹";
    el.title = state.leftHidden ? "Show media pane" : "Hide media pane";
  }
  if (er) {
    er.textContent = state.rightHidden ? "‹" : "›";
    er.title = state.rightHidden ? "Show inspector" : "Hide inspector";
  }
}

function initPaneWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem("vePanes") || "{}");
    if (saved.left) state.leftPane = clamp(+saved.left, 160, 480);
    if (saved.right) state.rightPane = clamp(+saved.right, 220, 520);
    if (saved.leftHidden != null) state.leftHidden = !!saved.leftHidden;
    if (saved.rightHidden != null) state.rightHidden = !!saved.rightHidden;
  } catch (e) {}
  applyPaneWidths();
}

function persistPanes() {
  localStorage.setItem("vePanes", JSON.stringify({
    left: state.leftPane, right: state.rightPane,
    leftHidden: state.leftHidden, rightHidden: state.rightHidden,
  }));
}

/* ---------- save / load ---------- */

async function saveProject() {
  const project = {
    canvas: state.canvas, clips: state.clips, music: state.music, pips: state.pips,
    texts: state.texts, shapes: state.shapes, images: state.images, subs: state.subs, fonts: state.fonts, bin: state.bin,
    trackH: state.trackH, tlH: state.tlH,
    laneH: state.laneH, laneFlags: state.laneFlags,
  };
  const r = await fetch("/api/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  const j = await r.json();
  if (j.ok) $("#exportStatus").textContent = "Saved: " + j.path.split(/[\\/]/).pop();
  else if (j.error) alert(j.error);
}

async function loadProject() {
  const r = await fetch("/api/load");
  const j = await r.json();
  if (!j.ok) { if (j.error) alert(j.error); return; }
  pushUndo();
  const p = j.project || {};
  state.canvas = { preset: "auto", w: 1920, h: 1080, mode: "fit", bg: "#000000", lut: null, guides: { v: [], h: [] }, guideColor: "#22d3ee", showRulers: true, ...(p.canvas || {}) };
  ensureCanvasGuides();
  applyGuideColor();
  applyRulerVisibility();
  state.clips = (p.clips || []).map((c) => {
    const out = {
      adj: { ...DEFAULT_ADJ }, trans: { type: "none", dur: 0.5 },
      x: 0.5, y: 0.5, scale: 1, scaleW: 1, scaleH: 1,
      ...c,
    };
    if (c.scaleW == null) out.scaleW = out.scale != null ? out.scale : 1;
    if (c.scaleH == null) out.scaleH = out.scaleW;
    out.scale = out.scaleW;
    if (typeof out.track !== "number") out.track = 0;
    return out;
  });
  ensureClipOffsets();
  ensureClipTracks();
  state.music = ensurePackedTracks((p.music || []).map((m) => ({ uid: m.uid || uid(), ...m })), mediaSpan);
  state.pips = ensurePackedTracks((p.pips || []).map((x, k) => {
    const out = {
      border: false, borderColor: "#ffffff", borderW: 4, rotate: 0, cornerRadius: 0,
      ...x, uid: x.uid || uid() + k,
    };
    if (out.scaleW == null) out.scaleW = out.scale != null ? out.scale : 0.28;
    if (out.scaleH == null) out.scaleH = scaleHForAspect(out.scaleW, out.w, out.h);
    out.scale = out.scaleW;
    return out;
  }), mediaSpan);
  state.texts = ensurePackedTracks((p.texts || []).map((x) => {
    const out = { rotate: 0, shadowColor: "#000000", ...x };
    if (out.size == null) out.size = 0.08;
    if (out.scaleH == null) out.scaleH = clamp(Number(out.size) * 1.4, 0.04, 0.7);
    if (out.scaleW == null) out.scaleW = 0.55;
    if (out.shadowColor == null) out.shadowColor = "#000000";
    out.scale = out.scaleW;
    return out;
  }), timedSpan);
  state.shapes = ensurePackedTracks((p.shapes || []).map((x) => ({
    kind: "rect", fill: true, color: "#5eead4", border: true, borderColor: "#ffffff", borderW: 3,
    lineStyle: "solid",
    opacity: 1, x: 0.5, y: 0.5, scaleW: 0.28, scaleH: 0.18, rotate: 0, start: 0, durn: 5,
    ...x,
  })), timedSpan);
  state.images = ensurePackedTracks((p.images || []).map((x) => {
    const out = {
      border: false, borderColor: "#ffffff", borderW: 4, rotate: 0, cornerRadius: 0,
      ...x,
    };
    if (out.scaleW == null) out.scaleW = out.scale != null ? out.scale : 0.2;
    if (out.scaleH == null) out.scaleH = scaleHForAspect(out.scaleW, out.w, out.h);
    out.scale = out.scaleW;
    return out;
  }), timedSpan);
  if (p.trackH) state.trackH = clamp(+p.trackH || 1, 0.7, 2.5);
  if (p.tlH) state.tlH = clamp(+p.tlH || 200, 120, 520);
  state.laneH = p.laneH || {};
  state.laneFlags = p.laneFlags || {};
  if (p.subs) state.subs = { style: { ...state.subs.style, ...(p.subs.style || {}) }, entries: p.subs.entries || [] };
  state.fonts = p.fonts || [];
  state.bin = p.bin || [];
  refreshFontFaces();
  for (const [mid, media] of Object.entries(j.media || {})) {
    for (const c of state.clips) if (c.mid === mid) { c.w = media.width || c.w; c.h = media.height || c.h; c.has_audio = media.has_audio; }
    for (const b of state.bin) if (b.mid === mid || b.path === media.path) {
      b.mid = mid; b.width = media.width || b.width; b.height = media.height || b.height; b.has_audio = media.has_audio;
    }
  }
  const seen = new Set(state.bin.map((b) => b.path));
  const harvest = (arr, kind) => {
    for (const it of arr) {
      if (it.path && !seen.has(it.path)) {
        seen.add(it.path);
        state.bin.push({
          mid: it.mid, kind, name: it.name, path: it.path, duration: it.dur || it.duration || 0,
          width: it.w, height: it.h, has_audio: it.has_audio,
        });
      }
    }
  };
  harvest(state.clips, "video");
  harvest(state.pips, "video");
  harvest(state.music, "audio");
  harvest(state.images, "image");
  state.sel = null;
  state.t = 0;
  activeClip = -1;
  delete video.dataset.mid;
  if (j.missing && j.missing.length) alert("Missing files skipped:\n" + j.missing.join("\n"));
  refresh();
}

/* ---------- export ---------- */

let exportTimer = null;

const DEFAULT_EXPORT = { format: "mp4", resolution: "original", quality: "medium", fps: "30" };

function loadExportSettings() {
  try {
    return { ...DEFAULT_EXPORT, ...JSON.parse(localStorage.getItem("veExport") || "{}") };
  } catch (e) {
    return { ...DEFAULT_EXPORT };
  }
}
function saveExportSettings(s) {
  localStorage.setItem("veExport", JSON.stringify(s));
}

function openExportModal() {
  if (!canExport() || exportTimer) return;
  const s = loadExportSettings();
  $("#exFormat").value = s.format || "mp4";
  $("#exRes").value = s.resolution || "original";
  $("#exQuality").value = s.quality || "medium";
  $("#exFps").value = s.fps || "30";
  updateExportHint();
  $("#exportModal").hidden = false;
}

function updateExportHint() {
  const fmt = $("#exFormat").value;
  const q = $("#exQuality").value;
  const res = $("#exRes").value;
  const bits = [];
  if (fmt === "webm") bits.push("WebM is great for web; some players prefer MP4");
  if (res !== "original") bits.push(res + "p shrinks the frame");
  if (q === "small") bits.push("Small quality prioritizes file size");
  if (q === "high") bits.push("High quality keeps more detail");
  $("#exHint").textContent = bits.length
    ? bits.join(" · ") + "."
    : "MP4 works everywhere. Lower resolution and Small quality shrink file size.";
}

async function doExport() {
  if (!canExport() || exportTimer) return;
  pause();
  const settings = {
    format: $("#exFormat").value,
    resolution: $("#exRes").value,
    quality: $("#exQuality").value,
    fps: $("#exFps").value,
  };
  saveExportSettings(settings);

  // Keep the modal open with a clear message while the native Save dialog is up.
  const goBtn = $("#exportGo");
  const cancelBtn = $("#exportCancel");
  if (goBtn) goBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  $("#exHint").textContent = "Save dialog is open — pick a folder and filename (check the taskbar if you don’t see it).";
  $("#exportStatus").textContent = "Choose where to save…";

  const baseName = (state.clips[0] && state.clips[0].name)
    || (state.images[0] && state.images[0].name)
    || "export";
  const suggest = String(baseName).replace(/\.[^.]+$/, "") + "_export." + (settings.format === "webm" ? "webm" : "mp4");

  let pick;
  try {
    const res = await fetch(
      `/api/pick-export?format=${encodeURIComponent(settings.format)}&name=${encodeURIComponent(suggest)}`
    );
    pick = await res.json();
  } catch (err) {
    if (goBtn) goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    updateExportHint();
    $("#exportStatus").textContent = "";
    alert("Could not open the save dialog. Restart the server from a normal terminal (python server.py), then try again.");
    return;
  }

  if (goBtn) goBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;
  updateExportHint();

  if (!pick || !pick.ok || !pick.path) {
    $("#exportStatus").textContent = "";
    return;
  }

  $("#exportModal").hidden = true;
  $("#exportStatus").textContent = "Preparing text…";
  const [frameW, frameH] = previewCanvasSize();
  const texts = await Promise.all(state.texts.map(async (t) => {
    try {
      const png = await rasterizeText(t, frameW, frameH);
      return png ? { ...t, _png: png, _rasterH: frameH } : t;
    } catch (err) {
      console.warn("Text raster failed; exporting with subtitle renderer instead.", err);
      return t;
    }
  }));
  const project = {
    canvas: state.canvas,
    clips: state.clips,
    music: state.music,
    pips: state.pips,
    texts,
    shapes: state.shapes,
    images: state.images,
    subs: state.subs,
    export: settings,
    exportPath: pick.path,
  };
  $("#exportStatus").textContent = "Starting export…";
  let j;
  try {
    const r = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    });
    j = await r.json();
  } catch (err) {
    $("#exportStatus").textContent = "";
    $("#exportModal").hidden = false;
    alert("Export request failed.");
    return;
  }
  if (!j.ok) {
    if (j.cancelled) { $("#exportStatus").textContent = ""; $("#exportModal").hidden = false; return; }
    alert(j.error || "Export failed.");
    $("#exportStatus").textContent = "";
    $("#exportModal").hidden = false;
    return;
  }
  $("#exportBar").classList.add("on");
  $("#exportBtn").disabled = true;
  $("#exportStatus").textContent = "Exporting… 0%";
  exportTimer = setInterval(async () => {
    const p = await (await fetch("/api/progress?job=" + j.job)).json();
    if (p.state === "running") {
      $("#exportFill").style.width = p.pct + "%";
      $("#exportStatus").textContent = `Exporting… ${Math.round(p.pct)}%`;
    } else {
      clearInterval(exportTimer);
      exportTimer = null;
      $("#exportBtn").disabled = false;
      $("#exportBar").classList.remove("on");
      $("#exportFill").style.width = "0";
      if (p.state === "done") {
        const name = p.dest.split(/[\\/]/).pop();
        $("#exportStatus").innerHTML = `Done: <a id="revealLink">${name}</a>`;
        $("#revealLink").onclick = () => fetch("/api/reveal?path=" + encodeURIComponent(p.dest));
      } else {
        $("#exportStatus").textContent = "";
        alert(p.error || "Export failed.");
      }
    }
  }, 500);
}

/* ---------- wiring ---------- */

$("#addText").onclick = addText;
$("#addShape").onclick = (e) => {
  e.stopPropagation();
  toggleShapeMenu();
};
document.querySelectorAll("#shapeMenu [data-shape]").forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    toggleShapeMenu(false);
    addShape(btn.dataset.shape);
  };
});
document.addEventListener("click", (e) => {
  const menu = $("#shapeMenu");
  if (!menu || menu.hidden) return;
  if (e.target.closest("#shapeMenu") || e.target.closest("#addShape")) return;
  menu.hidden = true;
});
$("#importBtn").onclick = importToBin;
bindOsFileDrop();
document.querySelectorAll(".mediaTabs .tab").forEach((btn) => {
  btn.onclick = () => {
    state.binFilter = btn.dataset.filter;
    document.querySelectorAll(".mediaTabs .tab").forEach((t) => t.classList.toggle("on", t === btn));
    renderBin();
  };
});
$("#playBtn").onclick = () => (state.playing ? pause() : play());
$("#splitBtn").onclick = splitAtPlayhead;
$("#dupBtn").onclick = duplicateSelected;
$("#deleteBtn").onclick = deleteSelected;
$("#shotBtn").onclick = () => { captureScreenshotToBin(); };
const bindPaneToggle = (id, which) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.onclick = (e) => {
    e.stopPropagation();
    if (which === "left") setLeftHidden(!state.leftHidden);
    else setRightHidden(!state.rightHidden);
  };
};
bindPaneToggle("edgeToggleLeft", "left");
bindPaneToggle("edgeToggleRight", "right");
$("#exportBtn").onclick = openExportModal;
$("#exportCancel").onclick = () => { $("#exportModal").hidden = true; };
$("#exportGo").onclick = doExport;
$("#exportModal").addEventListener("click", (e) => {
  if (e.target === $("#exportModal")) $("#exportModal").hidden = true;
});
["exFormat", "exRes", "exQuality", "exFps"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", updateExportHint);
});
$("#undoBtn").onclick = undo;
$("#redoBtn").onclick = redo;
$("#saveBtn").onclick = saveProject;
$("#loadBtn").onclick = loadProject;
$("#zoomIn").onclick = () => { state.zoom = clamp(state.zoom * 1.35, 0.3, 8); refresh(); };
$("#zoomOut").onclick = () => { state.zoom = clamp(state.zoom / 1.35, 0.3, 8); refresh(); };
$("#tlGrip").addEventListener("mousedown", (e) => {
  gesture = { kind: "tl-resize", startY: e.clientY, origH: state.tlH };
  e.preventDefault();
});

$("#leftGrip").addEventListener("mousedown", (e) => {
  if (e.target.closest(".paneEdgeBtn")) return;
  if (state.leftHidden) { setLeftHidden(false); return; }
  gesture = { kind: "pane-left", startX: e.clientX, startW: state.leftPane };
  e.currentTarget.classList.add("dragging");
  e.preventDefault();
});
$("#rightGrip").addEventListener("mousedown", (e) => {
  if (e.target.closest(".paneEdgeBtn")) return;
  if (state.rightHidden) { setRightHidden(false); return; }
  gesture = { kind: "pane-right", startX: e.clientX, startW: state.rightPane };
  e.currentTarget.classList.add("dragging");
  e.preventDefault();
});

// Stage click must NOT toggle playback — users click the frame to select/reposition.
// Play/pause stays on the transport button and Space.
$("#tlScroll").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  state.zoom = clamp(state.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.3, 8);
  refresh();
}, { passive: false });

function parseDrop(e) {
  let raw = "";
  try {
    raw = e.dataTransfer.getData("application/x-ve-media") || e.dataTransfer.getData("text/plain") || "";
  } catch (err) {
    raw = "";
  }
  if (!raw && pendingBinDrag) return { ...pendingBinDrag };
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}
$("#tlScroll").addEventListener("dragover", (e) => {
  // WebView2 often omits custom MIME types from dataTransfer.types — trust pendingBinDrag.
  const types = e.dataTransfer ? [...(e.dataTransfer.types || [])] : [];
  const ok = pendingBinDrag
    || types.includes("text/plain")
    || types.includes("application/x-ve-media")
    || types.includes("Files");
  if (!ok) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  $("#tlScroll").classList.add("dropTarget");
});
$("#tlScroll").addEventListener("dragleave", (e) => {
  if (e.currentTarget.contains(e.relatedTarget)) return;
  $("#tlScroll").classList.remove("dropTarget");
});
$("#tlScroll").addEventListener("drop", (e) => {
  $("#tlScroll").classList.remove("dropTarget");
  // OS files from Explorer — handled by document drop (importOsFileList).
  const types = e.dataTransfer ? [...(e.dataTransfer.types || [])] : [];
  if (types.includes("Files") && e.dataTransfer.files && e.dataTransfer.files.length) {
    return;
  }
  const data = parseDrop(e);
  pendingBinDrag = null;
  if (!data) return;
  e.preventDefault();
  dropBinAtPoint(data, e.clientX, e.clientY);
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); }
  else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
  else if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelected(); }
  else if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard(); }
  else if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); }
  else if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveProject(); }
  else if (e.code === "Space") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if (e.key === "s" || e.key === "S") splitAtPlayhead();
  else if (e.key === "ArrowLeft") setT(state.t - (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === "ArrowRight") setT(state.t + (e.shiftKey ? 1 : 1 / 30));
});

window.addEventListener("resize", () => { renderTimeline(); layoutVideo(); renderOverlays(); });

video.addEventListener("error", () => {
  if (video.dataset.mid) $("#exportStatus").textContent = "Preview can't play this format (export still works).";
});

/* ---------- track header controls ---------- */
$("#tlHeads").addEventListener("click", (e) => {
  const btn = e.target.closest(".laneBtn");
  if (!btn) return;
  e.stopPropagation();
  const head = btn.closest(".laneHead");
  if (!head || !head.dataset.lane) return;
  const id = head.dataset.lane;
  const f = laneFlags(id);
  const act = btn.dataset.act;
  if (act === "lock") f.lock = !f.lock;
  else if (act === "hide") f.hide = !f.hide;
  else if (act === "mute") f.mute = !f.mute;
  renderTimeline();
  renderOverlays();
  applyClipFX();
  musicSync();
  pipSync();
});

$("#tlHeads").addEventListener("mousedown", (e) => {
  const rz = e.target.closest(".laneResize");
  if (!rz) return;
  e.preventDefault();
  e.stopPropagation();
  const id = rz.dataset.lane;
  const kind = rz.dataset.kind || "overlay";
  rz.classList.add("dragging");
  gesture = {
    kind: "lane-resize",
    laneId: id,
    startY: e.clientY,
    origH: laneHeight(id, kind),
  };
});

(function syncTlScroll() {
  const scroll = $("#tlScroll");
  const heads = $("#tlHeads");
  if (!scroll || !heads) return;
  let lock = false;
  scroll.addEventListener("scroll", () => {
    if (lock) return;
    lock = true;
    heads.scrollTop = scroll.scrollTop;
    lock = false;
  });
})();

$("#thIn").onclick = () => { state.trackH = clamp(state.trackH * 1.2, 0.7, 2.5); renderTimeline(); };
$("#thOut").onclick = () => { state.trackH = clamp(state.trackH / 1.2, 0.7, 2.5); renderTimeline(); };

initPaneWidths();
initStageRulers();
initRulerMenu();
refresh();
paintStageRulers();
renderUserGuides();
