import { api, h } from '../common.js';

// A console that talks to Termwise's MCP endpoint the way a voice assistant
// does: JSON-RPC over Streamable HTTP with a bearer key. The left side is the
// conversation, the right side is the protocol traffic, unedited.
//
// Choosing which tool a sentence means is the assistant's job (Alexa+ does it
// with its own language model). Here a small keyword router stands in for that
// step, and says so on screen. Everything after the choice is the real server.

const SAMPLES = [
  'What contract deadlines are coming up?',
  'How much renews by default in the next 90 days?',
  'Why is the hosting deadline on the 16th of October?',
  'Give the hosting renewal to Priya.',
  'Is our audit trail intact?'
];

// utterance -> { name, arguments }
export function route(u) {
  const s = u.toLowerCase();
  const days = (() => {
    const m = s.match(/next\s+(\d{1,3})\s+days?/);
    if (m) return Number(m[1]);
    if (/this month|30 days/.test(s)) return 30;
    if (/this quarter|three months/.test(s)) return 90;
    return null;
  })();
  if (/audit|tamper|intact|verify/.test(s)) return { name: 'verify_audit_trail', arguments: {} };
  if (/how much|worth|exposure|renews? by default|money/.test(s)) return { name: 'renewal_exposure', arguments: days ? { days } : {} };
  const give = s.match(/(?:give|assign)\s+(?:the\s+)?(.+?)\s+to\s+([a-z][a-z .'-]+?)[.?!]*$/);
  if (give) {
    const [, what, person] = give;
    return { name: 'assign_obligation', arguments: { contract: what, obligation: what, person } };
  }
  if (/\b(done|sent|completed?|finished)\b/.test(s)) {
    return { name: 'complete_obligation', arguments: { contract: u, obligation: u, note: u } };
  }
  if (/why|explain|where .* come from|how .* (worked out|calculated)/.test(s)) return { name: 'explain_deadline', arguments: { contract: u, obligation: u } };
  if (/which contracts|list .*contracts|what contracts do we have/.test(s)) return { name: 'list_contracts', arguments: {} };
  if (/what does .* (hold|owe)|obligations (in|for|under)/.test(s)) return { name: 'contract_obligations', arguments: { contract: u } };
  return { name: 'upcoming_deadlines', arguments: days ? { days } : {} };
}

export async function assistant(ctx) {
  let key = sessionStorage.getItem('tw_console_key');
  let rpcId = 0;
  const chat = h('div.console-chat');
  const wire = h('div.console-wire');
  const input = h('input', { type: 'text', placeholder: 'Ask about your contracts', 'aria-label': 'Question' });
  const speak = h('input', { type: 'checkbox', id: 'speak' });
  const status = h('span.small.muted');

  const post = async (method, params) => {
    const body = { jsonrpc: '2.0', id: ++rpcId, method, params };
    wire.append(h('div.wire-out', h('div.wire-label', `→ ${method}`), h('pre', JSON.stringify(body, null, 2))));
    const res = await fetch('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const shown = JSON.parse(JSON.stringify(data));
    if (shown.result?.tools) shown.result.tools = shown.result.tools.map((t) => ({ name: t.name, title: t.title, annotations: t.annotations }));
    wire.append(h('div.wire-in', h('div.wire-label', `← ${res.status}`), h('pre', JSON.stringify(shown, null, 2).slice(0, 2400))));
    wire.scrollTop = wire.scrollHeight;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const connect = async () => {
    const init = await post('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'termwise-console', version: '1.0.0' } });
    const tools = await post('tools/list', {});
    status.textContent = `Connected: ${init.result.serverInfo.title}, protocol ${init.result.protocolVersion}, ${tools.result.tools.length} tools`;
  };

  const ask = async (u) => {
    if (!u.trim()) return;
    chat.append(h('div.bubble.me', u));
    const choice = route(u);
    chat.append(h('div.router', `Router picked ${choice.name}`));
    chat.scrollTop = chat.scrollHeight;
    try {
      const r = await post('tools/call', choice);
      const said = r.result?.content?.[0]?.text || r.error?.message || 'No answer.';
      chat.append(h(`div.bubble.them${r.result?.isError ? '.err' : ''}`, said));
      if (speak.checked && 'speechSynthesis' in window) {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(said));
      }
    } catch (e) {
      chat.append(h('div.bubble.them.err', e.message));
    }
    chat.scrollTop = chat.scrollHeight;
  };

  const start = async () => {
    try {
      if (!key) {
        const r = await api('POST', '/api/keys', { name: 'Assistant console', role: ctx.can('work') ? 'member' : 'viewer' });
        key = r.key;
        sessionStorage.setItem('tw_console_key', key);
      }
      await connect();
      gate.classList.add('hidden');
      panes.classList.remove('hidden');
      input.focus();
    } catch (e) {
      // Most often the key was revoked. Say so where the person is looking.
      sessionStorage.removeItem('tw_console_key');
      const had = !!key;
      key = null;
      gate.replaceChildren(
        h('div.assume', { style: { background: 'var(--red-2)', color: 'var(--red)' } },
          had ? `The server refused this console's key: ${e.message}` : e.message),
        ctx.can('manage') ? h('button.btn.primary', { onclick: start }, 'Create a new key and connect') : null);
    }
  };

  const gate = h('div.card.pad',
    h('p', 'The console connects to this workspace\'s MCP endpoint with a key of its own, which appears under Settings, Connect a voice assistant, and can be revoked there.'),
    ctx.can('manage') || key
      ? h('button.btn.primary', { onclick: start }, key ? 'Connect' : 'Create a key and connect')
      : h('p.muted.small', 'An admin needs to create the key.'));

  const panes = h('div.console.hidden',
    h('div.card.console-left',
      h('div.console-head', h('b', 'Conversation'), h('span.spacer'), h('label.small.row', { for: 'speak' }, speak, 'Speak answers')),
      chat,
      h('div.chips', SAMPLES.map((s) => h('button.chip', { onclick: () => ask(s) }, s))),
      h('form.row', { onsubmit: (e) => { e.preventDefault(); const v = input.value; input.value = ''; ask(v); } }, input, h('button.btn.primary', { type: 'submit' }, 'Ask')),
      h('div.hint', 'Choosing the tool from a sentence is the assistant\'s job; Alexa+ does it with its own language model. A keyword router stands in for that here. Everything after that choice is the live MCP server.')),
    h('div.card.console-right',
      h('div.console-head', h('b', 'MCP traffic'), h('span.spacer'), status),
      wire)
  );

  if (key) setTimeout(start, 0);

  return h('div',
    h('div.page-head',
      h('div', h('h1', 'Assistant'), h('div.sub', 'Ask about your contracts the way you would ask Alexa+. Answers come from the same MCP server a voice assistant connects to.'))),
    gate, panes);
}
