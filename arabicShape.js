// arabicShape.js — manual Arabic contextual letter-shaping.
//
// SUPERSEDED: financePdf.js no longer uses this file. PDF generation now
// goes through pdfRenderer.js (headless Chromium via Puppeteer), which
// lets a real browser engine shape and reorder Arabic text instead of
// doing it by hand here — see pdfRenderer.js's file header for why. This
// module is kept in the repo (unused) rather than deleted, in case some
// other part of the project still imports it directly; if nothing does,
// it's safe to remove in a future cleanup.
//
// THE ROOT CAUSE this file fixes: pdfkit draws each character by looking it
// up in the font's cmap and painting that one glyph — it has no OpenType
// shaping engine (no GSUB), so it never applies a font's 'init'/'medi'/
// 'fina' substitution rules. Handed plain logical Arabic text, every letter
// is drawn in its bare/isolated form, which is exactly the "الحروف تظهر
// منفصلة" (disconnected letters) bug. Browsers/Word don't have this problem
// because they run a real shaping engine (HarfBuzz) before drawing; pdfkit
// does not, so the substitution has to happen ourselves, character by
// character, before the text ever reaches pdfkit.
//
// The fix is the same one every non-shaping-aware renderer needs (this is
// what libraries like arabic-reshaper implement): before drawing, replace
// each Arabic letter with the correct pre-joined "presentation form"
// character for its position in the word (isolated/initial/medial/final).
// Those presentation-form characters are ordinary Unicode codepoints (in
// the Arabic Presentation Forms-A/B blocks) with their own dedicated,
// already-joined glyph — no shaping needed to draw them correctly, cmap
// lookup is enough.
//
// JOIN_TABLE below was generated from Unicode's own character names
// (e.g. "ARABIC LETTER BEH INITIAL FORM") and then filtered to keep only
// the codepoints that actually exist in assets/fonts/Tajawal-Regular.ttf's
// cmap (checked with fontTools) — every codepoint this file can produce is
// confirmed drawable by the bundled font. Isolated position deliberately
// reuses the base codepoint (0x06xx) rather than a presentation-forms
// "isolated form" codepoint: this specific font has no separate isolated
// glyphs in its cmap (only initial/medial/final + the base letter), which
// matches how these fonts are normally built — the base codepoint's glyph
// IS the isolated shape. Do not add/edit codepoints here without
// re-verifying them against the actual font file, or Arabic text will
// silently fall back to tofu/boxes for any codepoint missing from the font.
const JOIN_TABLE = {
  0x0621: { type: "none", forms: {} }, // HAMZA
  0x0622: { type: "right", forms: { final: 0xFE82 } }, // ALEF WITH MADDA ABOVE
  0x0623: { type: "right", forms: { final: 0xFE84 } }, // ALEF WITH HAMZA ABOVE
  0x0624: { type: "right", forms: { final: 0xFE86 } }, // WAW WITH HAMZA ABOVE
  0x0625: { type: "right", forms: { final: 0xFE88 } }, // ALEF WITH HAMZA BELOW
  0x0626: { type: "dual", forms: { final: 0xFE8A, initial: 0xFE8B, medial: 0xFE8C } }, // YEH WITH HAMZA ABOVE
  0x0627: { type: "right", forms: { final: 0xFE8E } }, // ALEF
  0x0628: { type: "dual", forms: { final: 0xFE90, initial: 0xFE91, medial: 0xFE92 } }, // BEH
  0x0629: { type: "right", forms: { final: 0xFE94 } }, // TEH MARBUTA
  0x062A: { type: "dual", forms: { final: 0xFE96, initial: 0xFE97, medial: 0xFE98 } }, // TEH
  0x062B: { type: "dual", forms: { final: 0xFE9A, initial: 0xFE9B, medial: 0xFE9C } }, // THEH
  0x062C: { type: "dual", forms: { final: 0xFE9E, initial: 0xFE9F, medial: 0xFEA0 } }, // JEEM
  0x062D: { type: "dual", forms: { final: 0xFEA2, initial: 0xFEA3, medial: 0xFEA4 } }, // HAH
  0x062E: { type: "dual", forms: { final: 0xFEA6, initial: 0xFEA7, medial: 0xFEA8 } }, // KHAH
  0x062F: { type: "right", forms: { final: 0xFEAA } }, // DAL
  0x0630: { type: "right", forms: { final: 0xFEAC } }, // THAL
  0x0631: { type: "right", forms: { final: 0xFEAE } }, // REH
  0x0632: { type: "right", forms: { final: 0xFEB0 } }, // ZAIN
  0x0633: { type: "dual", forms: { final: 0xFEB2, initial: 0xFEB3, medial: 0xFEB4 } }, // SEEN
  0x0634: { type: "dual", forms: { final: 0xFEB6, initial: 0xFEB7, medial: 0xFEB8 } }, // SHEEN
  0x0635: { type: "dual", forms: { final: 0xFEBA, initial: 0xFEBB, medial: 0xFEBC } }, // SAD
  0x0636: { type: "dual", forms: { final: 0xFEBE, initial: 0xFEBF, medial: 0xFEC0 } }, // DAD
  0x0637: { type: "dual", forms: { final: 0xFEC2, initial: 0xFEC3, medial: 0xFEC4 } }, // TAH
  0x0638: { type: "dual", forms: { final: 0xFEC6, initial: 0xFEC7, medial: 0xFEC8 } }, // ZAH
  0x0639: { type: "dual", forms: { final: 0xFECA, initial: 0xFECB, medial: 0xFECC } }, // AIN
  0x063A: { type: "dual", forms: { final: 0xFECE, initial: 0xFECF, medial: 0xFED0 } }, // GHAIN
  0x0641: { type: "dual", forms: { final: 0xFED2, initial: 0xFED3, medial: 0xFED4 } }, // FEH
  0x0642: { type: "dual", forms: { final: 0xFED6, initial: 0xFED7, medial: 0xFED8 } }, // QAF
  0x0643: { type: "dual", forms: { final: 0xFEDA, initial: 0xFEDB, medial: 0xFEDC } }, // KAF
  0x0644: { type: "dual", forms: { final: 0xFEDE, initial: 0xFEDF, medial: 0xFEE0 } }, // LAM
  0x0645: { type: "dual", forms: { final: 0xFEE2, initial: 0xFEE3, medial: 0xFEE4 } }, // MEEM
  0x0646: { type: "dual", forms: { final: 0xFEE6, initial: 0xFEE7, medial: 0xFEE8 } }, // NOON
  0x0647: { type: "dual", forms: { final: 0xFEEA, initial: 0xFEEB, medial: 0xFEEC } }, // HEH
  0x0648: { type: "right", forms: { final: 0xFEEE } }, // WAW
  0x0649: { type: "right", forms: { final: 0xFEF0 } }, // ALEF MAKSURA
  0x064A: { type: "dual", forms: { final: 0xFEF2, initial: 0xFEF3, medial: 0xFEF4 } }, // YEH
  0x067E: { type: "dual", forms: { final: 0xFB57, initial: 0xFB58, medial: 0xFB59 } }, // PEH
  0x06A4: { type: "dual", forms: { final: 0xFB6B, initial: 0xFB6C, medial: 0xFB6D } }, // VEH
};

// Lam-Alef is a MANDATORY ligature in Arabic orthography — لا/لأ/لإ/لآ are
// always drawn as one joined shape, never as two separate letters, so this
// substitution runs before the general per-letter pass below. Both
// isolated and final ligature codepoints are confirmed present in the
// bundled font.
const LAM = 0x0644;
const LAM_ALEF = {
  0x0622: { isolated: 0xFEF5, final: 0xFEF6 }, // لآ
  0x0623: { isolated: 0xFEF7, final: 0xFEF8 }, // لأ
  0x0625: { isolated: 0xFEF9, final: 0xFEFA }, // لإ
  0x0627: { isolated: 0xFEFB, final: 0xFEFC }, // لا
};

// Arabic combining marks (tashkeel/diacritics) — invisible to the joining
// chain: a letter followed by a diacritic still joins to whatever comes
// after the diacritic, exactly as if the diacritic weren't there.
const TRANSPARENT = new Set([
  0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0618, 0x0619, 0x061A,
  0x064B, 0x064C, 0x064D, 0x064E, 0x064F, 0x0650, 0x0651, 0x0652, 0x0653, 0x0654, 0x0655,
  0x0656, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065C, 0x065D, 0x065E, 0x065F, 0x0670,
  0x06D6, 0x06D7, 0x06D8, 0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
  0x06E3, 0x06E4, 0x06E7, 0x06E8, 0x06EA, 0x06EB, 0x06EC, 0x06ED,
]);

function canJoinForward(cp) {
  const info = JOIN_TABLE[cp];
  return !!info && info.type === "dual";
}
function canJoinBackward(cp) {
  const info = JOIN_TABLE[cp];
  return !!info && (info.type === "dual" || info.type === "right");
}

// Converts logical Arabic text into the correctly-joined presentation-form
// text a non-shaping renderer (pdfkit) needs — this must run BEFORE bidi
// reordering (see financePdf.js), since shaping depends on logical (not
// visual) neighbours. Non-Arabic characters (digits, Latin, punctuation,
// spaces) and unrecognized codepoints are copied through unchanged.
function reshapeArabic(input) {
  const str = String(input ?? "");
  const chars = Array.from(str); // iterate by Unicode code point, not UTF-16 unit
  const out = [];

  function prevSignificant(idx) {
    for (let j = idx - 1; j >= 0; j--) {
      const cp = chars[j].codePointAt(0);
      if (TRANSPARENT.has(cp)) continue;
      return cp;
    }
    return null;
  }
  function nextSignificant(idx) {
    for (let j = idx + 1; j < chars.length; j++) {
      const cp = chars[j].codePointAt(0);
      if (TRANSPARENT.has(cp)) continue;
      return cp;
    }
    return null;
  }

  let i = 0;
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0);

    // Lam-Alef ligature: consumes two input characters, emits one glyph.
    if (cp === LAM && i + 1 < chars.length) {
      const ligature = LAM_ALEF[chars[i + 1].codePointAt(0)];
      if (ligature) {
        const prevCp = prevSignificant(i);
        const joinsFromPrev = prevCp !== null && canJoinForward(prevCp);
        out.push(String.fromCodePoint(joinsFromPrev ? ligature.final : ligature.isolated));
        i += 2;
        continue;
      }
    }

    const info = JOIN_TABLE[cp];
    if (!info || info.type === "none" || TRANSPARENT.has(cp)) {
      out.push(chars[i]);
      i += 1;
      continue;
    }

    const prevCp = prevSignificant(i);
    const nextCp = nextSignificant(i);
    const joinsFromPrev = prevCp !== null && canJoinForward(prevCp);
    const joinsToNext = info.type === "dual" && nextCp !== null && canJoinBackward(nextCp);

    let form;
    if (joinsFromPrev && joinsToNext) form = "medial";
    else if (!joinsFromPrev && joinsToNext) form = "initial";
    else if (joinsFromPrev && !joinsToNext) form = "final";
    else form = "isolated";

    const targetCp = form === "isolated" ? cp : (info.forms[form] !== undefined ? info.forms[form] : cp);
    out.push(String.fromCodePoint(targetCp));
    i += 1;
  }

  return out.join("");
}

// ---------------------------------------------------------------------
// Visual (bidi) reordering — replaces the previous bidi-js dependency.
//
// WHY THIS EXISTS: bidi-js was listed in package.json but was missing
// from package-lock.json, so on any host that installs with `npm ci`
// (Render, Railway, Docker, most CI/CD) it never actually got installed.
// financePdf.js's require("bidi-js") then silently failed (caught on
// purpose, to avoid crashing the export), which skipped reordering
// entirely — letters were still correctly joined by reshapeArabic()
// above, but left in logical (reading) order instead of the visual
// left-to-right order pdfkit needs to draw them in. The result: joined
// glyphs whose connectors don't line up with their neighbours (looks
// disconnected) and whose reading direction starts from the left. This
// function removes that dependency risk by doing the (small amount of)
// reordering pdfkit's Arabic reports actually need, in plain JS.
//
// Text is split into runs of two kinds:
//   - "ar"  Arabic letters/punctuation — read right-to-left, so the
//           run's character order is reversed (logical -> visual).
//   - "ltr" digits, Latin letters, and the punctuation that glues them
//           together (dates, times, amounts, reference codes) — always
//           read left-to-right even inside an Arabic sentence, so their
//           internal order is left untouched.
// The runs themselves are then reversed as a sequence, since the whole
// document is a right-to-left paragraph: whatever was read first
// (logically first) must end up drawn last (visually rightmost).
function isArabicChar(cp) {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}
function isKeepOrderChar(cp) {
  return (
    (cp >= 0x0030 && cp <= 0x0039) || // 0-9
    (cp >= 0x0660 && cp <= 0x0669) || // Arabic-Indic digits
    (cp >= 0x0041 && cp <= 0x005a) || // A-Z
    (cp >= 0x0061 && cp <= 0x007a) || // a-z
    cp === 0x002e || cp === 0x002c || cp === 0x003a || // . , :
    cp === 0x002b || cp === 0x002d || cp === 0x002f || cp === 0x0025 // + - / %
  );
}

function reorderVisual(shapedText) {
  const chars = Array.from(String(shapedText ?? ""));
  if (!chars.length) return shapedText;

  const runs = [];
  let current = null;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    let cls;
    if (isKeepOrderChar(cp)) cls = "ltr";
    else if (isArabicChar(cp)) cls = "ar";
    else cls = current ? current.cls : "ar"; // spaces/neutrals join the run they're inside

    if (current && current.cls === cls) current.text += ch;
    else {
      current = { cls, text: ch };
      runs.push(current);
    }
  }

  return runs
    .reverse()
    .map((r) => (r.cls === "ar" ? Array.from(r.text).reverse().join("") : r.text))
    .join("");
}

module.exports = { reshapeArabic, reorderVisual };
