/*
 * PeraPilot — small UI toolkit: escaping, icons, modals, forms, confirm dialogs, toasts.
 * No framework. Modals are plain elements (not <dialog>) so they behave the same on every Android WebView.
 */
(function (root) {
  'use strict';
  const PP = root.PP = root.PP || {};

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    bill: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 8h6M9 12h6"/>',
    debt: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M8 13l4 4 4-4"/>',
    goal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    wallet: '<path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v11a2 2 0 002 2h15a1 1 0 001-1v-9a1 1 0 00-1-1H5a2 2 0 01-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    swap: '<path d="M7 7h13M16 3l4 4-4 4"/><path d="M17 17H4M8 13l-4 4 4 4"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v.01M18 14v.01"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
    upload: '<path d="M12 21V9M7 13l5-5 5 5M4 3h16"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 109-9 9 9 0 00-6.4 2.6L3 9"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4"/>',
    spark: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/>'
  };
  const icon = (name, cls) => `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

  /* ---------- small view helpers ---------- */
  const chip = (text, cls) => `<span class="chip ${cls || ''}">${esc(text)}</span>`;
  function bar(ratio, cls) {
    const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
    return `<div class="bar ${cls || ''}" role="presentation"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  }
  const empty = (title, text, action) => `<div class="empty"><div class="empty-ic">${icon('spark')}</div><h3>${esc(title)}</h3><p>${esc(text || '')}</p>${action || ''}</div>`;

  /* ---------- form fields ---------- */
  function attrs(o) { return Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`)).join(' '); }
  const fld = {
    text: (name, label, val, o) => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(val)}" ${attrs(Object.assign({ autocomplete: 'off' }, o))}></label>`,
    money: (name, label, val, o) => `<label class="field"><span>${label}</span><div class="input-prefix"><b>₱</b><input type="text" inputmode="decimal" name="${name}" value="${esc(val)}" placeholder="0.00" ${attrs(Object.assign({ autocomplete: 'off' }, o))}></div></label>`,
    number: (name, label, val, o) => `<label class="field"><span>${label}</span><input type="number" inputmode="numeric" name="${name}" value="${esc(val)}" ${attrs(o)}></label>`,
    date: (name, label, val, o) => `<label class="field"><span>${label}</span><input type="date" name="${name}" value="${esc(val)}" ${attrs(o)}></label>`,
    textarea: (name, label, val, o) => `<label class="field"><span>${label}</span><textarea name="${name}" rows="2" maxlength="300" ${attrs(o)}>${esc(val)}</textarea></label>`,
    select: (name, label, options, value, o) => {
      const groups = []; const map = {};
      options.forEach((op) => { const g = op.group || ''; if (!map[g]) { map[g] = []; groups.push(g); } map[g].push(op); });
      const opt = (op) => `<option value="${esc(op.value)}"${String(op.value) === String(value) ? ' selected' : ''}${op.disabled ? ' disabled' : ''}>${esc(op.label)}</option>`;
      const inner = groups.map((g) => (g ? `<optgroup label="${esc(g)}">${map[g].map(opt).join('')}</optgroup>` : map[g].map(opt).join(''))).join('');
      return `<label class="field"><span>${label}</span><select name="${name}" ${attrs(o)}>${inner}</select></label>`;
    },
    check: (name, label, checked) => `<label class="check"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}><span>${label}</span></label>`
  };

  function formValues(f) {
    const v = {};
    Array.from(f.elements).forEach((el) => {
      if (!el.name || el.disabled) return;
      if (el.type === 'checkbox') v[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) v[el.name] = el.value; }
      else v[el.name] = el.value;
    });
    return v;
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind) {
    const rootEl = document.getElementById('toast-root'); if (!rootEl) return;
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || 'ok'); t.setAttribute('role', 'status');
    t.textContent = msg; rootEl.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 5200 : 3200);
  }

  /* ---------- modals (stackable) ---------- */
  const stack = [];
  function focusFirst(el) {
    const t = el.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
    if (t && window.matchMedia && !window.matchMedia('(pointer: coarse)').matches) t.focus();
  }
  function openModal(o) {
    const rootEl = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal-backdrop"></div><div class="modal ${o.size || ''}" role="dialog" aria-modal="true" aria-label="${esc(o.title)}"><div class="modal-head"><h2>${esc(o.title)}</h2><button type="button" class="icon-btn" data-modal-close aria-label="Close">${icon('x')}</button></div><div class="modal-body">${o.body}</div></div>`;
    rootEl.appendChild(wrap);
    document.body.classList.add('modal-open');
    const m = {
      el: wrap, closed: false,
      close(result) {
        if (m.closed) return; m.closed = true;
        wrap.remove();
        const i = stack.indexOf(m); if (i >= 0) stack.splice(i, 1);
        if (!stack.length) document.body.classList.remove('modal-open');
        if (o.onClose) o.onClose(result);
      }
    };
    wrap.querySelector('.modal-backdrop').addEventListener('click', () => m.close());
    wrap.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) m.close(); });
    stack.push(m);
    setTimeout(() => { focusFirst(wrap); wrap.dataset.ready = '1'; }, 40);
    return m;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close(); });
  const closeAllModals = () => { while (stack.length) stack[stack.length - 1].close(); };

  /** A modal with a <form>. onSubmit(values, form, modal) returns errors[] to show, {cancel:true} to stay open, or nothing to close. */
  function form(o) {
    const html = `<form novalidate autocomplete="off"><div class="form-errors" role="alert" hidden></div>${o.body}<div class="form-actions"><button type="button" class="btn ghost" data-modal-close>${esc(o.cancelText || 'Cancel')}</button><button type="submit" class="btn ${o.danger ? 'danger' : 'primary'}">${esc(o.submitText || 'Save')}</button></div></form>`;
    const m = openModal({ title: o.title, body: html, size: o.size });
    const f = m.el.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (f.dataset.busy) return; // prevents double-submit => duplicate transactions
      f.dataset.busy = '1';
      const eb = f.querySelector('.form-errors'); if (eb) { eb.hidden = true; eb.innerHTML = ''; } // clear the previous attempt's errors
      const btn = f.querySelector('[type=submit]'); btn.disabled = true;
      try {
        const res = await o.onSubmit(formValues(f), f, m);
        if (Array.isArray(res) && res.length) showErrors(f, res);
        else if (!(res && res.cancel)) m.close(true);
      } catch (err) {
        console.error(err);
        showErrors(f, [err && err.message ? err.message : 'Something went wrong. Nothing was saved.']);
      } finally { delete f.dataset.busy; btn.disabled = false; }
    });
    if (o.onOpen) o.onOpen(f, m);
    return m;
  }
  function showErrors(f, errs) {
    const box = f.querySelector('.form-errors'); if (!box) return;
    box.hidden = false;
    box.innerHTML = errs.map((e) => `<div>${esc(e)}</div>`).join('');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Promise<boolean>. `typeToConfirm` makes the user type a word before the button is enabled. */
  function confirm(o) {
    return new Promise((resolve) => {
      let done = false;
      const body = `<div class="confirm-msg">${o.html ? o.message : `<p>${esc(o.message)}</p>`}</div>${o.typeToConfirm ? `<label class="field"><span>Type <strong>${esc(o.typeToConfirm)}</strong> to confirm</span><input name="typed" autocomplete="off" autocapitalize="off"></label>` : ''}<div class="form-actions"><button type="button" class="btn ghost" data-cancel>${esc(o.cancelText || 'Cancel')}</button><button type="button" class="btn ${o.danger ? 'danger' : 'primary'}" data-ok${o.typeToConfirm ? ' disabled' : ''}>${esc(o.confirmText || 'Confirm')}</button></div>`;
      const m = openModal({ title: o.title || 'Please confirm', body, size: 'sm', onClose: () => { if (!done) { done = true; resolve(false); } } });
      const ok = m.el.querySelector('[data-ok]');
      m.el.querySelector('[data-cancel]').addEventListener('click', () => m.close());
      ok.addEventListener('click', () => { if (done || ok.disabled) return; done = true; resolve(true); m.close(); });
      const typed = m.el.querySelector('[name=typed]');
      if (typed) typed.addEventListener('input', () => { ok.disabled = typed.value.trim().toLowerCase() !== String(o.typeToConfirm).toLowerCase(); });
    });
  }
  /** Informational dialog with a single OK button. */
  function notice(title, htmlMessage) {
    return new Promise((resolve) => {
      const m = openModal({ title, size: 'sm', body: `<div class="confirm-msg">${htmlMessage}</div><div class="form-actions"><button type="button" class="btn primary" data-modal-close>OK</button></div>`, onClose: resolve });
      void m;
    });
  }

  PP.UI = { esc, icon, chip, bar, empty, fld, formValues, toast, openModal, form, confirm, notice, closeAllModals, showErrors };
})(typeof self !== 'undefined' ? self : this);
