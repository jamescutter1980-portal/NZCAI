/**
 * Entry-point guard for the ingest CLIs.
 *
 * Every loader in this directory ends with `main()`, which means importing one
 * for a helper RUNS IT. That has now bitten twice: importing the CSV parser
 * from `epc-load.ts` started a bulk load, and importing the DNO name matcher
 * from `dno-boundaries.ts` printed a usage message and exited the test runner.
 *
 * `isEntryPoint(import.meta.url)` is true only when the module was the file
 * node/tsx was asked to run. Wrapping each `main()` in it fixes the whole class
 * rather than one case at a time, and leaves the helpers importable.
 *
 * A leaf module: no imports beyond node builtins, so nothing it is guarding can
 * cycle back through it.
 */

import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isEntryPoint(moduleUrl: string): boolean {
  const invoked = argv[1];
  if (!invoked) return false;
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(invoked);
  } catch {
    return false;
  }
}
