import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { AlertTriangle, Check } from 'lucide-react';
import { suggestKeyNav, keepActiveVisible } from '../utils/suggestMenu';

// Same identity rule as the server's normalizeItemName: case/space-insensitive
export const vendorNameKey = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Pick-a-vendor field shared by every form that names an outside party — the
// inward "Received From" and the outward "To". The vendor list is FIXED and
// maintained by admins, so the box only filters that list; it never creates
// a vendor. `value` is the text in the box and `vendorId` is set only once
// that text IS a vendor from the list (picked, or typed exactly). Any edit
// un-picks until the text matches again. Suggestions are positioned off the
// input's own rect since the menu is position:fixed. Focusing the empty
// field lists every vendor right away instead of waiting for typing.
export default function VendorPicker({
  value, vendorId, onChange,
  placeholder = 'Start typing to search the vendor list…',
  // Shown under the box while the text isn't a listed vendor
  hint = 'Not in the vendor list — pick one of the suggestions, or ask an admin to add it under Admin → Vendors.',
}) {
  // `active` = vendor highlighted with ↓/↑ (-1 = none; Enter picks it)
  const [suggest, setSuggest] = useState({ list: [], rect: null, q: null, active: -1 });
  const close = () => setSuggest({ list: [], rect: null, q: null, active: -1 });
  const timer = useRef(null);
  const seq = useRef(0);
  const menuRef = useRef(null);
  useEffect(() => { keepActiveVisible(menuRef.current); }, [suggest.active]);
  // Latest props for the async search callback, so a stale closure never
  // overwrites what the user has typed since
  const latest = useRef({ value, vendorId, onChange });
  latest.current = { value, vendorId, onChange };

  const search = (q, rect) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const mySeq = ++seq.current;
      try {
        const list = await api.searchVendors(q.trim());
        if (mySeq !== seq.current) return;
        setSuggest({ list, rect, q: q.trim(), active: -1 });
        // Typed the full name of a known vendor → treat it as picked
        const exact = list.find(v => vendorNameKey(v.name) === vendorNameKey(q));
        const cur = latest.current;
        if (exact && !cur.vendorId && vendorNameKey(cur.value) === vendorNameKey(exact.name))
          cur.onChange({ name: cur.value, vendorId: exact.id });
      } catch { /* vendor search is best-effort; typing still works */ }
    }, q.trim() ? 200 : 0);
  };

  // A pre-filled name with no id (an older pass being edited) is resolved
  // against the list once, silently — no menu opens until the field is
  // focused.
  useEffect(() => {
    if (!value?.trim() || vendorId) return;
    let cancelled = false;
    api.searchVendors(value.trim()).then(list => {
      if (cancelled) return;
      const exact = list.find(v => vendorNameKey(v.name) === vendorNameKey(value));
      const cur = latest.current;
      if (exact && !cur.vendorId && vendorNameKey(cur.value) === vendorNameKey(exact.name))
        cur.onChange({ name: exact.name, vendorId: exact.id });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  const pick = (v) => {
    onChange({ name: v.name, vendorId: v.id });
    close();
  };

  const text = value || '';

  return (
    <>
      <div className="input-wrap">
        <input className="form-input" value={text}
          onChange={e => {
            onChange({ name: e.target.value, vendorId: '' });
            search(e.target.value, e.target.getBoundingClientRect());
          }}
          onFocus={e => search(e.target.value, e.target.getBoundingClientRect())}
          onBlur={() => setTimeout(close, 150)}
          onKeyDown={e => suggestKeyNav(e, {
            count: suggest.rect ? suggest.list.length : 0,
            active: suggest.active,
            setActive: (n) => setSuggest(s => ({ ...s, active: n })),
            pick: (n) => pick(suggest.list[n]),
            close,
          })}
          placeholder={placeholder} />
        {vendorId ? (
          <span className="input-affix" style={{ pointerEvents: 'none', color: 'var(--green)' }} title="From the vendor list"><Check size={15} /></span>
        ) : text.trim() ? (
          <span className="input-affix" style={{ pointerEvents: 'none', color: 'var(--orange)' }} title="Not in the vendor list"><AlertTriangle size={15} /></span>
        ) : null}
      </div>
      {text.trim() && !vendorId && hint && (
        <div className="form-hint" style={{ color: 'var(--orange)' }}>{hint}</div>
      )}
      {suggest.rect && (suggest.list.length > 0 || suggest.q) && (
        <div
          ref={menuRef}
          className="suggest-menu"
          style={{
            top: Math.min(suggest.rect.bottom + 2, window.innerHeight - 370),
            left: Math.min(suggest.rect.left, window.innerWidth - 340),
            width: Math.max(suggest.rect.width, 300),
            // The whole vendor list is shown (scrollable), not a page of it
            maxHeight: 360,
          }}
        >
          {suggest.list.length > 0 && (
            <div className="suggest-item" style={{ cursor: 'default', padding: '6px 12px', background: 'var(--bg3)' }}>
              <span className="suggest-meta">
                {suggest.list.length} vendor{suggest.list.length !== 1 ? 's' : ''}{suggest.q ? ` matching “${suggest.q}”` : ' on the list'} — scroll or keep typing
              </span>
            </div>
          )}
          {suggest.list.length === 0 ? (
            <div className="suggest-item" style={{ cursor: 'default' }}>
              <span className="suggest-name" style={{ color: 'var(--text3)' }}>No vendor matches “{suggest.q}”</span>
              <span className="suggest-meta">Only vendors on the admin list can be used</span>
            </div>
          ) : suggest.list.map((v, n) => (
            <button type="button" key={v.id} tabIndex={-1}
              className={`suggest-item${n === suggest.active ? ' active' : ''}`}
              onMouseDown={e => { e.preventDefault(); pick(v); }}>
              <span className="suggest-name">{v.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
