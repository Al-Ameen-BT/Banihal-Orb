'use client';

import { motion } from 'framer-motion';
import { ShimmerRow } from './Shimmer';

interface Column<T> {
  key: keyof T | string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  width?: string;
}

interface DataTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  loading,
  emptyMessage = 'No data',
}: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 4 }).map((_, i) => <ShimmerRow key={i} />)}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {columns.map((col) => (
              <th
                key={String(col.key)}
                className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-14 text-center text-sm text-slate-500">
                <div className="flex flex-col items-center gap-2.5">
                  <svg className="w-9 h-9 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                  {emptyMessage}
                </div>
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <motion.tr
                key={i}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3) }}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
              >
                {columns.map((col) => (
                  <td key={String(col.key)} className="px-5 py-3.5 text-sm text-slate-700 whitespace-nowrap">
                    {col.render ? col.render(row, i) : String(row[col.key as keyof T] ?? '—')}
                  </td>
                ))}
              </motion.tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
