// ─── Excel export ─────────────────────────────────────────────────────────────
// One writer for every .xlsx the app produces. Columns are passed in, so the caller
// (today: the ticket report's field picker) decides what ends up in the sheet.
//
// LIBRARY CHOICE — deliberate, please don't "simplify" it to `xlsx`:
//   • `xlsx` / SheetJS: the npm-published 0.18.5 carries known prototype-pollution
//     and ReDoS advisories whose fixes ship only on the vendor's own CDN. `npm audit`
//     flags it, which is not a thing to hand a customer of a security product.
//   • `exceljs`: 21.8 MB unpacked to write a spreadsheet we never read back.
//   • `write-excel-file`: MIT, maintained, write-only, and the smallest of the three.
//
// The import is DYNAMIC so the library is code-split out of the main bundle: only a
// user who actually clicks Download pays for it.
//
// `/universal` rather than `/browser`: it only produces a Blob, with no download
// mechanics or worker-path resolution of its own to survive Next's bundler. Saving
// the Blob is four lines we already write in three other places.

/** Cell types write-excel-file understands. Anything else is coerced to a string. */
type CellValue = string | number | boolean | Date | null;

export interface XlsxColumn<T> {
  header: string;
  /** Pull the cell value out of a row. Return null for an empty cell. */
  value: (row: T) => CellValue;
  /** Column width in characters. Defaults to something readable for the header. */
  width?: number;
}

/**
 * Build and download an .xlsx.
 *
 * Cell types are decided per COLUMN from its first non-null value, not per cell.
 * write-excel-file rejects a cell whose `value` disagrees with its `type`, and a
 * column that is a Date on row 1 and a string on row 2 would either throw mid-export
 * or land in Excel as text — losing the date sorting that is the whole reason to
 * emit .xlsx rather than CSV. So the column picks one type and coerces every cell to
 * it, emitting null where a row cannot honour it.
 */
export async function exportXlsx<T>(fileName: string, columns: XlsxColumn<T>[], rows: T[]): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/universal');

  const cols = columns.map((col) => {
    const sample = rows.map(col.value).find((v) => v !== null && v !== undefined);
    const type = sample instanceof Date ? Date
      : typeof sample === 'number' ? Number
      : typeof sample === 'boolean' ? Boolean
      : String;

    return {
      header: col.header,
      width: col.width ?? Math.max(12, Math.min(col.header.length + 4, 40)),
      cell: (row: T) => {
        const v = col.value(row);
        if (v === null || v === undefined || v === '') return null;
        if (type === Date) return v instanceof Date ? { type: Date, value: v, format: 'yyyy-mm-dd hh:mm' } : null;
        if (type === Number) return typeof v === 'number' ? { type: Number, value: v } : null;
        if (type === Boolean) return typeof v === 'boolean' ? { type: Boolean, value: v } : null;
        return { type: String, value: v instanceof Date ? v.toISOString() : String(v) };
      },
    };
  });

  // The library's generics cannot see through a column list assembled at runtime;
  // the per-cell coercion above is what actually guarantees each cell matches.
  const blob = await writeXlsxFile(rows, { columns: cols as never }).toBlob();

  const name = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
