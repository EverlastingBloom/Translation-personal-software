/* Reading and writing CSV/TSV files without changing anything that wasn't translated:
   every row keeps its exact original text, so the exported file only differs where lines changed. */
(function (root) {
  "use strict";

  /** Bytes of a file -> text, and whether it started with a UTF-8 BOM. */
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes); // old Excel exports
    }
    return { text, bom };
  }

  function sniffDelimiter(firstLine) {
    let best = ",", most = 0;
    for (const d of [",", ";", "\t", "|"]) {
      const n = firstLine.split(d).length - 1;
      if (n > most) { most = n; best = d; }
    }
    return best;
  }

  /** Text -> header, rows (cells + the row's original text), newline style. Blank lines are skipped. */
  function parse(text, delimiter) {
    const firstEnd = text.search(/\r?\n/);
    const newline = firstEnd >= 0 && text[firstEnd] === "\r" ? "\r\n" : "\n";
    const delim = delimiter || sniffDelimiter(firstEnd >= 0 ? text.slice(0, firstEnd) : text);
    const records = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const start = i;
      const cells = [];
      let cell = "";
      let quoted = false;
      for (;;) {
        if (i >= n) { cells.push(cell); break; }
        const c = text[i];
        if (quoted) {
          if (c === '"') {
            if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
            quoted = false; i++; continue;
          }
          cell += c; i++; continue;
        }
        if (c === '"') { quoted = true; i++; continue; }
        if (c === delim) { cells.push(cell); cell = ""; i++; continue; }
        if (c === "\r" || c === "\n") { cells.push(cell); break; }
        cell += c; i++;
      }
      const raw = text.slice(start, i);
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      if (raw.length) records.push({ cells, raw });
    }
    const head = records.shift() || { cells: [], raw: "" };
    return {
      header: head.cells, headerRaw: head.raw, rows: records, delimiter: delim, newline,
      trailingNewline: /\r?\n$/.test(text),
    };
  }

  function writeCell(v, delim) {
    v = v == null ? "" : String(v);
    return v.includes(delim) || v.includes('"') || v.includes("\n") || v.includes("\r")
      ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function writeRow(cells, delim) {
    return cells.map((c) => writeCell(c, delim)).join(delim);
  }

  const api = { decode, parse, writeRow, sniffDelimiter };
  root.CSV = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
