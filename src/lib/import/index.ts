/**
 * A reusable CSV import: describe the fields once, and the same preview,
 * mapping, validation and error reporting work for every import type.
 *
 * ```ts
 * const preview = previewCsv(text);                                  // delimiter, headers, rows, warnings
 * const mapping = suggestMapping(spec, preview.headers);             // field -> column index
 * const issues = mappingIssues(spec, mapping);                       // unmapped required fields
 * const result = applyMapping(spec, preview.headers, preview.rows, mapping);
 * if (issues.length === 0 && result.rows.length > 0) commit(result.rows.map((r) => r.data));
 * ```
 *
 * The parser and the RFC 4180 rules are `integrations/_shared/csv.ts`; the
 * column matching is `integrations/_shared/columns.ts`; the template writer is
 * `export/csv.ts`. Nothing here is a second implementation of any of them.
 */

export type { FieldParse, ImportField, ImportFieldDescriptor, ImportSpec, TextFieldOptions, NumberFieldOptions, DateFieldOptions, EnumFieldOptions, RegistrationFieldOptions } from "./spec";
export { textField, numberField, integerField, dateField, enumField, booleanField, registrationField, parseNumberText, parseDateText, templateCsv } from "./spec";

export type { CsvDelimiter, CsvPreview, PreviewCsvOptions } from "./parse";
export { previewCsv, detectDelimiter, looksLikeHeaderRow, delimiterName, DELIMITERS, MAX_PREVIEW_ROWS } from "./parse";

export type { ColumnMapping, MappedRow, MappingError, ApplyResult, ApplyMappingOptions } from "./mapping";
export { suggestMapping, applyMapping, mappingIssues, MAX_IMPORT_ROWS } from "./mapping";
