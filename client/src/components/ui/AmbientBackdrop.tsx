// Subtle decorative backdrop for auth / marketing surfaces.
// Light blue wash + faint dot grid — never competes with foreground content.
export default function AmbientBackdrop() {
  return (
    <div className="fixed inset-0 -z-10 pointer-events-none overflow-hidden" aria-hidden>
      {/* Soft brand wash, top-center */}
      <div
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full opacity-60"
        style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.10) 0%, transparent 65%)' }}
      />
      {/* Faint dot grid */}
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(15,23,42,0.045) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
        }}
      />
    </div>
  );
}
