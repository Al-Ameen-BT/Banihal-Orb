'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { slackBotsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { BotFieldGrid } from '@/components/BotFormFields';
import type { SlackBot, SlackBotField, BotFieldType } from '@/lib/schemas';

const STATUS_CFG: Record<string, { dot: string; text: string; label: string }> = {
  CONNECTED:    { dot: 'bg-emerald-500', text: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Connected' },
  DISCONNECTED: { dot: 'bg-slate-400',   text: 'text-slate-600 bg-slate-100 border-slate-200',      label: 'Disconnected' },
  ERROR:        { dot: 'bg-red-500',     text: 'text-red-700 bg-red-50 border-red-100',              label: 'Error' },
};
const FIELD_TYPES: BotFieldType[] = ['TEXT', 'TEXTAREA', 'NUMBER', 'SELECT', 'CHECKBOX', 'USER_EMAIL'];

function StatusPill({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG['DISCONNECTED']!;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === 'CONNECTED' ? 'animate-pulse-soft' : ''}`} />
      {cfg.label}
    </span>
  );
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-brand' : 'bg-slate-200'}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-[4px]'}`} />
    </button>
  );
}

// ─── Add bot drawer ──────────────────────────────────────────────────────────
function AddBotDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [error, setError] = useState('');

  const createMut = useMutation({
    mutationFn: () => slackBotsApi.create({
      name: name.trim(), description: description.trim() || null,
      botToken: botToken.trim(), appToken: appToken.trim() || null,
      webhookUrl: webhookUrl.trim() || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['slack-bots'] }); onClose(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add the bot.'),
  });

  return (
    <DrawerShell title="Add Slack Bot" onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        <Field label="Bot name" required><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Incident Triage Bot" className="input" /></Field>
        <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input resize-none" placeholder="What this bot does…" /></Field>
        <Field label="Bot User OAuth token (xoxb-)" required>
          <input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="xoxb-…" className="input font-mono text-xs" />
          <p className="text-xs text-slate-400 mt-1">Used to connect + health-check via Slack auth.test.</p>
        </Field>
        <Field label="App-level token (xapp-) — optional">
          <input value={appToken} onChange={(e) => setAppToken(e.target.value)} placeholder="xapp-…" className="input font-mono text-xs" />
          <p className="text-xs text-slate-400 mt-1">Enables Socket Mode so Slack messages are bridged to the assistant.</p>
        </Field>
        <Field label="Incoming Webhook URL — optional">
          <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="input font-mono text-xs" />
          <p className="text-xs text-slate-400 mt-1">Tickets assigned to this bot are posted into the webhook&apos;s channel with all form details.</p>
        </Field>
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-2.5">{error}</p>}
      </div>
      <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3">
        <GlowButton onClick={() => { if (!name.trim() || botToken.trim().length < 10) { setError('Name and a bot token are required.'); return; } setError(''); createMut.mutate(); }} disabled={createMut.isPending} loading={createMut.isPending}>Add Bot</GlowButton>
        <GlowButton variant="ghost" onClick={onClose} disabled={createMut.isPending}>Cancel</GlowButton>
      </div>
    </DrawerShell>
  );
}

// ─── Manage bot drawer (settings / form / orgs) ──────────────────────────────
function ManageBotDrawer({ botId, onClose }: { botId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'settings' | 'form' | 'orgs'>('settings');
  const { data: bot } = useQuery<SlackBot>({
    queryKey: ['slack-bot', botId],
    queryFn: () => slackBotsApi.get(botId).then((r) => r.data as SlackBot),
    refetchInterval: 10_000,
  });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['slack-bot', botId] }); qc.invalidateQueries({ queryKey: ['slack-bots'] }); };

  return (
    <DrawerShell title={bot ? bot.name : 'Bot'} onClose={onClose} wide>
      {!bot ? <div className="p-8 text-sm text-slate-400">Loading…</div> : (
        <>
          <div className="px-6 pt-4 flex items-center gap-2">
            <StatusPill status={bot.status} />
            {bot.teamName && <span className="text-xs text-slate-400">· {bot.teamName}</span>}
            {bot.lastError && <span className="text-xs text-red-500 truncate">· {bot.lastError}</span>}
          </div>
          <div className="px-6 pt-3 flex gap-1 border-b border-slate-100">
            {(['settings', 'form', 'orgs'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm font-semibold capitalize border-b-2 -mb-px transition-colors cursor-pointer ${tab === t ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {t === 'form' ? 'Ticket Form' : t === 'orgs' ? 'Organizations' : 'Settings'}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {tab === 'settings' && <SettingsTab bot={bot} onChange={invalidate} onDeleted={onClose} />}
            {tab === 'form' && <FormBuilder bot={bot} onChange={invalidate} />}
            {tab === 'orgs' && <OrgsTab bot={bot} onChange={invalidate} />}
          </div>
        </>
      )}
    </DrawerShell>
  );
}

function SettingsTab({ bot, onChange, onDeleted }: { bot: SlackBot; onChange: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description ?? '');
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  const saveMut = useMutation({
    mutationFn: () => slackBotsApi.update(bot.id, {
      name: name.trim(), description: description.trim() || null,
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
    }),
    onSuccess: () => { setBotToken(''); setAppToken(''); setWebhookUrl(''); onChange(); },
    onError: (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the bot.', 'error'),
  });
  const toggleMut = useMutation({
    mutationFn: () => (bot.enabled ? slackBotsApi.disconnect(bot.id) : slackBotsApi.connect(bot.id)),
    onSuccess: onChange,
  });
  const deleteMut = useMutation({
    mutationFn: () => slackBotsApi.remove(bot.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['slack-bots'] }); onDeleted(); },
  });
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const keyMut = useMutation({
    mutationFn: () => slackBotsApi.generateApiKey(bot.id),
    onSuccess: (r) => { setNewApiKey((r.data as { apiKey: string }).apiKey); onChange(); },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-xl bg-slate-50 ring-1 ring-slate-200/70 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{bot.enabled ? 'Connected' : 'Disconnected'}</p>
          <p className="text-xs text-slate-500 mt-0.5">Toggle to connect / disconnect the bot from Slack.</p>
        </div>
        <Toggle on={bot.enabled} onClick={() => toggleMut.mutate()} disabled={toggleMut.isPending} />
      </div>

      <Field label="Bot name"><input value={name} onChange={(e) => setName(e.target.value)} className="input" /></Field>
      <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input resize-none" /></Field>
      <Field label={`Bot token (${bot.botTokenHint})`}><input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="Leave blank to keep current" className="input font-mono text-xs" /></Field>
      <Field label={`App token (${bot.appTokenSet ? 'set' : 'not set'})`}><input value={appToken} onChange={(e) => setAppToken(e.target.value)} placeholder="Leave blank to keep current" className="input font-mono text-xs" /></Field>
      <Field label={`Incoming Webhook URL (${bot.webhookSet ? 'set' : 'not set'})`}>
        <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/… — leave blank to keep current" className="input font-mono text-xs" />
        <p className="text-xs text-slate-400 mt-1">New bot tickets are posted into this webhook&apos;s channel with the form details.</p>
      </Field>

      {/* AD-automation machine API key — delivers temp passwords into the app. */}
      <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-3.5 space-y-2">
        <p className="text-sm font-semibold text-slate-900">AD credential API key</p>
        <p className="text-xs text-slate-500">The bot&apos;s AD automation uses this key to POST temporary passwords to <span className="font-mono">/api/ad-ingest/deliver</span>. Shown once — store it in the automation.</p>
        {newApiKey ? (
          <div className="rounded-lg bg-slate-900 text-slate-100 font-mono text-xs px-3 py-2 flex items-center gap-2 break-all">
            <span className="flex-1">{newApiKey}</span>
            <button type="button" onClick={() => navigator.clipboard?.writeText(newApiKey)} className="text-brand-200 hover:text-white cursor-pointer flex-shrink-0">Copy</button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">{bot.apiKeySet ? <>Key set · <span className="font-mono">{bot.apiKeyHint}</span></> : 'No key generated yet.'}</p>
        )}
        <GlowButton variant="secondary" className="py-1.5 px-4 text-sm" onClick={() => keyMut.mutate()} disabled={keyMut.isPending} loading={keyMut.isPending}>
          {bot.apiKeySet ? 'Rotate API key' : 'Generate API key'}
        </GlowButton>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <GlowButton onClick={() => saveMut.mutate()} disabled={saveMut.isPending} loading={saveMut.isPending}>Save Changes</GlowButton>
        <button type="button" onClick={async () => { if (await confirm({ title: 'Delete bot', message: <>&ldquo;{bot.name}&rdquo; and its form fields and org assignments will be removed.</>, confirmText: 'Delete', variant: 'danger' })) deleteMut.mutate(); }}
          className="ml-auto text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer">Delete bot</button>
      </div>
    </div>
  );
}

// ─── Form builder: field list + editor (left) · live org-form preview (right) ──
const slugKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

function FormBuilder({ bot, onChange }: { bot: SlackBot; onChange: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const fields = [...(bot.formFields ?? [])].sort((a, b) => a.order - b.order);
  const [editing, setEditing] = useState<SlackBotField | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<BotFieldType>('TEXT');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState('');
  const [placeholder, setPlaceholder] = useState('');
  const [helpText, setHelpText] = useState('');
  // Live preview state — lets the admin try the form exactly as the org-admin will.
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});

  function reset() {
    setEditing(null); setShowEditor(false); setLabel(''); setKey(''); setKeyTouched(false);
    setType('TEXT'); setRequired(false); setOptions(''); setPlaceholder(''); setHelpText('');
  }
  function load(f: SlackBotField) {
    setEditing(f); setShowEditor(true); setLabel(f.label); setKey(f.key); setKeyTouched(true);
    setType(f.type); setRequired(f.required); setOptions((f.options ?? []).join(', '));
    setPlaceholder(f.placeholder ?? ''); setHelpText(f.helpText ?? '');
  }

  const payload = () => ({
    key: key.trim(), label: label.trim(), type, required,
    options: type === 'SELECT' ? options.split(',').map((s) => s.trim()).filter(Boolean) : null,
    placeholder: placeholder.trim() || null,
    helpText: helpText.trim() || null,
    // New fields land at the end; edits keep their slot.
    order: editing ? editing.order : (fields.length ? Math.max(...fields.map((f) => f.order)) + 1 : 0),
  });
  const saveMut = useMutation({
    mutationFn: () => (editing ? slackBotsApi.updateField(bot.id, editing.id, payload()) : slackBotsApi.addField(bot.id, payload())),
    onSuccess: () => { reset(); onChange(); },
    onError: (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the field.', 'error'),
  });
  const delMut = useMutation({ mutationFn: (id: string) => slackBotsApi.deleteField(bot.id, id), onSuccess: onChange });
  // ⇅ reorder: swap order values with the neighbor (normalized to sorted indexes).
  const moveMut = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const a = fields[index]; const b = fields[index + dir];
      if (!a || !b) return;
      await Promise.all([
        slackBotsApi.updateField(bot.id, a.id, { order: index + dir }),
        slackBotsApi.updateField(bot.id, b.id, { order: index }),
      ]);
    },
    onSuccess: onChange,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
      {/* Left: field list + editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">Fields shown to org-admins when this bot is the assignee.</p>
          {!showEditor && (
            <button type="button" onClick={() => { reset(); setShowEditor(true); }}
              className="text-xs font-semibold text-brand hover:text-brand-700 cursor-pointer">+ Add field</button>
          )}
        </div>

        <div className="space-y-1.5">
          {fields.length === 0 && <p className="text-sm text-slate-400 py-2">No fields yet — add the first one.</p>}
          {fields.map((f, i) => (
            <div key={f.id} className={`flex items-center gap-2 rounded-lg ring-1 px-3 py-2 ${editing?.id === f.id ? 'ring-brand/50 bg-brand-50/40' : 'ring-slate-200'}`}>
              <div className="flex flex-col -my-1">
                <button type="button" aria-label="Move up" disabled={i === 0 || moveMut.isPending} onClick={() => moveMut.mutate({ index: i, dir: -1 })}
                  className="text-slate-300 hover:text-slate-600 disabled:opacity-30 cursor-pointer leading-none text-[10px] py-0.5">▲</button>
                <button type="button" aria-label="Move down" disabled={i === fields.length - 1 || moveMut.isPending} onClick={() => moveMut.mutate({ index: i, dir: 1 })}
                  className="text-slate-300 hover:text-slate-600 disabled:opacity-30 cursor-pointer leading-none text-[10px] py-0.5">▼</button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 truncate">{f.label} {f.required && <span className="text-red-500">*</span>}</p>
                <p className="text-[11px] text-slate-400 truncate">{f.key} · {f.type}{f.options?.length ? ` · ${f.options.join(', ')}` : ''}</p>
              </div>
              <button type="button" onClick={() => load(f)} className="text-xs font-semibold text-brand hover:text-brand-700 cursor-pointer">Edit</button>
              <button type="button" onClick={async () => { if (await confirm({ title: 'Delete field', message: <>Remove the &ldquo;{f.label}&rdquo; field from this bot&rsquo;s form?</>, confirmText: 'Delete', variant: 'danger' })) delMut.mutate(f.id); }}
                className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer">Delete</button>
            </div>
          ))}
        </div>

        {showEditor && (
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-4 space-y-3">
            <p className="text-sm font-semibold text-slate-900">{editing ? `Edit "${editing.label}"` : 'New field'}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label">
                <input value={label} className="input !py-1.5 text-sm"
                  onChange={(e) => { setLabel(e.target.value); if (!editing && !keyTouched) setKey(slugKey(e.target.value)); }} />
              </Field>
              <Field label="Key (a-z0-9_)">
                <input value={key} disabled={!!editing} className="input !py-1.5 text-sm font-mono disabled:opacity-60"
                  onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); }} />
              </Field>
              <Field label="Type">
                <select value={type} onChange={(e) => setType(e.target.value as BotFieldType)} className="input !py-1.5 text-sm">
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Placeholder">
                <input value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} maxLength={160} className="input !py-1.5 text-sm" placeholder="Shown inside the empty input" />
              </Field>
            </div>
            {type === 'SELECT' && (
              <Field label="Options (comma-separated)">
                <input value={options} onChange={(e) => setOptions(e.target.value)} className="input !py-1.5 text-sm" placeholder="Low, Medium, High" />
              </Field>
            )}
            <Field label="Help text">
              <input value={helpText} onChange={(e) => setHelpText(e.target.value)} maxLength={300} className="input !py-1.5 text-sm" placeholder="Short guidance shown under the field" />
            </Field>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-brand" />
              <span className="text-sm text-slate-700">Required</span>
            </label>
            <div className="flex items-center gap-2">
              <GlowButton className="py-1.5 px-4 text-sm" disabled={saveMut.isPending} loading={saveMut.isPending}
                onClick={() => { if (!label.trim() || !key.trim()) { toast('Label and key are required.', 'error'); return; } saveMut.mutate(); }}>
                {editing ? 'Save field' : 'Add field'}
              </GlowButton>
              <GlowButton variant="ghost" className="py-1.5 px-4 text-sm" onClick={reset}>Cancel</GlowButton>
            </div>
          </div>
        )}
      </div>

      {/* Right: live preview — exactly what the org-admin sees */}
      <div className="rounded-xl ring-1 ring-slate-200 overflow-hidden lg:sticky lg:top-0">
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-700">Live preview — org-admin ticket form</p>
          <StatusPill status={bot.status} />
        </div>
        <div className="p-4 space-y-4 bg-white">
          <div>
            <p className="text-[11px] font-medium text-slate-500 mb-1">Bot</p>
            <div className="input !py-1.5 text-sm text-slate-700 bg-slate-50 pointer-events-none">{bot.name}</div>
          </div>
          <BotFieldGrid fields={bot.formFields ?? []} values={previewValues}
            onChange={(k, v) => setPreviewValues((p) => ({ ...p, [k]: v }))} />
          <GlowButton className="w-full py-1.5 text-sm opacity-60 pointer-events-none">Create ticket</GlowButton>
          <p className="text-[10px] text-slate-400 text-center -mt-2">Preview only — inputs are interactive, nothing is submitted.</p>
        </div>
      </div>
    </div>
  );
}

function OrgsTab({ bot, onChange }: { bot: SlackBot; onChange: () => void }) {
  const assigned = new Set(bot.orgIds ?? []);
  const { data: customers = [] } = useQuery<{ id: string; name: string; slug: string }[]>({
    queryKey: ['slack-bot-customers'],
    queryFn: () => slackBotsApi.customers().then((r) => (r.data as { customers: { id: string; name: string; slug: string }[] }).customers),
    staleTime: 60_000,
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? slackBotsApi.assignOrg(bot.id, id) : slackBotsApi.unassignOrg(bot.id, id)),
    onSuccess: onChange,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 mb-2">Only assigned organizations can select this bot as a ticket assignee.</p>
      {customers.map((c) => {
        const on = assigned.has(c.id);
        return (
          <div key={c.id} className="flex items-center justify-between rounded-lg ring-1 ring-slate-200 px-3 py-2">
            <div className="min-w-0"><p className="text-sm font-medium text-slate-800 truncate">{c.name}</p><p className="text-[11px] text-slate-400">{c.slug}</p></div>
            <Toggle on={on} onClick={() => toggleMut.mutate({ id: c.id, on: !on })} disabled={toggleMut.isPending} />
          </div>
        );
      })}
      {customers.length === 0 && <p className="text-sm text-slate-400">No organizations found.</p>}
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────
function DrawerShell({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className={`relative ml-auto w-full ${wide ? 'max-w-3xl' : 'max-w-md'} h-full bg-white shadow-2xl flex flex-col`}>
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 truncate">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </motion.aside>
    </div>
  );
}
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function SlackBotsPage() {
  const [adding, setAdding] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);

  const { data: bots = [], isLoading } = useQuery<SlackBot[]>({
    queryKey: ['slack-bots'],
    queryFn: () => slackBotsApi.list().then((r) => (r.data as { bots: SlackBot[] }).bots),
    refetchInterval: 10_000, // live status
  });
  const connected = bots.filter((b) => b.status === 'CONNECTED').length;

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="bots.view">
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1100px] mx-auto space-y-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }} className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm text-slate-500 mb-1">Platform</p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Slack Bots</h1>
                <p className="mt-1 text-sm text-slate-500">Connect Slack bots to the assistant, track live status, and maintain each bot&apos;s ticket form — {connected} of {bots.length} connected.</p>
              </div>
              <GlowButton onClick={() => setAdding(true)}>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" /></svg>
                Add Bot
              </GlowButton>
            </motion.div>

            {isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-40 rounded-xl" />)}</div>
            ) : bots.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">No Slack bots yet</p>
                <p className="text-xs text-slate-400 mb-4">Add a bot with its Slack token to connect it and build its ticket form.</p>
                <GlowButton onClick={() => setAdding(true)}>Add First Bot</GlowButton>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {bots.map((b) => (
                  <button key={b.id} type="button" onClick={() => setManageId(b.id)}
                    className={`card p-5 text-left flex flex-col gap-3 hover:shadow-card-hover hover:-translate-y-0.5 transition-all cursor-pointer ${b.enabled ? '' : 'opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900 leading-snug truncate">{b.name}</p>
                      <StatusPill status={b.status} />
                    </div>
                    {b.description && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{b.description}</p>}
                    <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-auto pt-2 border-t border-slate-100">
                      <span>{b.fieldCount} form field{b.fieldCount === 1 ? '' : 's'}</span>
                      <span>· {b.orgCount} org{b.orgCount === 1 ? '' : 's'}</span>
                      {b.teamName && <span className="ml-auto truncate">{b.teamName}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      <AnimatePresence>{adding && <AddBotDrawer onClose={() => setAdding(false)} />}</AnimatePresence>
      <AnimatePresence>{manageId && <ManageBotDrawer botId={manageId} onClose={() => setManageId(null)} />}</AnimatePresence>
    </RoleGuard>
  );
}
