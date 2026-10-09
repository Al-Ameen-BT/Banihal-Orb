import clsx from 'clsx';

export function Shimmer({ className }: { className?: string }) {
  return <div className={clsx('shimmer rounded-md', className)} />;
}

export function ShimmerCard() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-card p-5 space-y-3">
      <Shimmer className="h-3 w-20" />
      <Shimmer className="h-8 w-28" />
      <Shimmer className="h-3 w-32" />
    </div>
  );
}

export function ShimmerRow() {
  return (
    <div className="flex items-center gap-4 px-5 py-4 border-b border-slate-100 last:border-0">
      <Shimmer className="h-4 w-32" />
      <Shimmer className="h-4 w-48 flex-1" />
      <Shimmer className="h-4 w-20" />
    </div>
  );
}
