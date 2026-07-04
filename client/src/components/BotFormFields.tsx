'use client';

import type { SlackBotField } from '@/lib/schemas';

// Single dynamic bot-form field — the ONE renderer shared by the org-admin's
// New Ticket → Bot form and the administrator's form-builder live preview, so
// what the admin previews is exactly what the org-admin fills.
export function BotFieldInput({ field, value, onChange, disabled }: {
  field: SlackBotField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const common = { disabled, placeholder: field.placeholder ?? undefined } as const;
  let control: React.ReactNode;
  switch (field.type) {
    case 'TEXTAREA':
      control = <textarea rows={2} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className="input resize-none" {...common} />;
      break;
    case 'NUMBER':
      control = <input type="number" value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} className="input" {...common} />;
      break;
    case 'USER_EMAIL':
      control = <input type="email" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className="input" {...common} />;
      break;
    case 'SELECT':
      control = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className="input" disabled={disabled}>
          <option value="">{field.placeholder || '— Select —'}</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case 'CHECKBOX':
      control = (
        <label className={`inline-flex items-center gap-2 ${disabled ? '' : 'cursor-pointer'}`}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled}
            className="w-4 h-4 rounded border-slate-300 text-brand" />
          <span className="text-sm text-slate-600">{field.placeholder || 'Yes'}</span>
        </label>
      );
      break;
    default:
      control = <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className="input" {...common} />;
  }
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1">
        {field.label}{field.required && <span className="text-red-500"> *</span>}
      </label>
      {control}
      {field.helpText && <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{field.helpText}</p>}
    </div>
  );
}

// Ordered field grid — shared layout for the org form + builder preview.
export function BotFieldGrid({ fields, values, onChange, disabled }: {
  fields: SlackBotField[];
  values: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
  disabled?: boolean;
}) {
  if (fields.length === 0) return <p className="text-xs text-slate-400">No fields defined for this bot yet.</p>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {[...fields].sort((a, b) => a.order - b.order).map((f) => (
        <BotFieldInput key={f.id} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} disabled={disabled} />
      ))}
    </div>
  );
}
