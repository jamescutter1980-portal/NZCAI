/**
 * RFC 4180 line parsing.
 *
 * A leaf module with no imports and no side effects, so tests and loaders can
 * use it without the loader's CLI running on import - `epc-load.ts` calls
 * `main()` at the top level, so importing a helper from it would have started a
 * bulk load and then exited the process.
 *
 * Note this is for real CSV. The VOA rating lists are asterisk-delimited
 * despite the .csv extension and are split in `voa-load.ts`.
 */

/** Splits one CSV line. Handles quoted fields and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}
