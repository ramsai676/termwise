// Shared by the landing page and the app: API calls, DOM building, formatting.

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-termwise': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.upgrade = data && data.upgrade;
    throw err;
  }
  return data;
}

// h('div.card', { onclick }, child, 'text', [more]) builds elements without
// innerHTML, so nothing from a contract can ever be parsed as markup.
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

let toastTimer;
export function toast(message, kind = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'error' ? 5200 : 3200);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function date(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function when(iso) {
  const d = new Date(iso);
  return `${date(iso)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function money(amount, currency = 'INR') {
  if (amount == null) return '';
  const n = Math.round(amount).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US');
  return currency === 'INR' ? `₹${n}` : `${currency || ''} ${n}`.trim();
}

export function daysText(n) {
  if (n == null) return '';
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

export function urgency(n) {
  if (n == null) return '';
  if (n < 0) return 'red';
  if (n <= 30) return 'amber';
  return 'green';
}

export async function startDemo(button) {
  if (button) { button.disabled = true; button.textContent = 'Opening demo...'; }
  try {
    await api('POST', '/api/auth/demo');
    location.href = '/app/overview';
  } catch (e) {
    toast(e.message, 'error');
    if (button) { button.disabled = false; button.textContent = 'Open the live demo'; }
  }
}
