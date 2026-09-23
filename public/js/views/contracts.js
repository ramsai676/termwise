import { api, h, toast, date, when, money, daysText, urgency } from '../common.js';

const KIND = {
  deadline: ['Deadline', 'blue'],
  milestone: ['Milestone', 'blue'],
  recurring: ['Recurring', ''],
  playbook: ['If it happens', ''],
  after_exit: ['After exit', ''],
  right: ['Your right', 'green'],
  risk: ['Risk', 'red']
};

// ---------- list ----------

export async function contracts(ctx) {
  const list = await api('GET', '/api/contracts');
  return h('div',
    h('div.page-head',
      h('div', h('h1', 'Contracts'), h('div.sub', `${list.length} of ${ctx.me.plan.contracts} on the ${ctx.me.plan.name} plan`)),
      h('span.spacer'),
      ctx.can('manage') ? h('button.btn.primary', { onclick: () => openUpload(ctx) }, 'Add contract') : null
    ),
    list.length
      ? h('div.card', h('table.grid',
          h('thead', h('tr', h('th', 'Contract'), h('th', 'You are'), h('th', 'Term'), h('th', 'Next action'), h('th', 'To review'))),
          h('tbody', list.map((c) => h('tr.click', { onclick: () => ctx.go(`/app/contracts/${c.id}`) },
            h('td', h('b', c.title), h('div.small.muted', `${c.counterparty || 'Counterparty not found'} · added ${date(c.uploadedAt)} by ${c.uploadedBy || 'unknown'}`)),
            h('td', c.perspective ? h('span.pill.blue', c.perspective) : h('span.pill.amber', 'Not set')),
            h('td.nowrap.small', c.term ? `${date(c.term.start)} to ${date(c.term.end)}` : h('span.muted', 'Not stated'), c.term?.autoRenews ? h('div.muted', 'renews itself') : null),
            h('td.small', c.next ? [c.next.title, h('div', h(`span.pill.${urgency(c.next.daysLeft)}`, `${date(c.next.due)}, ${daysText(c.next.daysLeft)}`))] : h('span.muted', 'Nothing dated')),
            h('td', c.unreviewed ? h('span.pill.amber', `${c.unreviewed} findings`) : h('span.pill.green', 'All reviewed'))
          )))
        ))
      : h('div.card.empty', h('h3', 'No contracts yet'), h('p', 'Paste a contract or drop in a text file to get started.'))
  );
}

// ---------- upload ----------

export function openUpload(ctx) {
  let parties = [];
  let chosen = null;
  const err = h('div.err');
  const title = h('input', { type: 'text', placeholder: 'Managed hosting with Stratus Nine', 'aria-label': 'Title' });
  const text = h('textarea', { rows: 12, placeholder: 'Paste the full text of the contract here', 'aria-label': 'Contract text' });
  const file = h('input.hidden', { type: 'file', accept: '.txt,.md,text/plain' });
  const drop = h('div.drop', { onclick: () => file.click() }, 'Drop a .txt file here or click to choose one. For PDF or Word, copy the text and paste it below.');
  const choose = h('div');
  const save = h('button.btn.primary', { disabled: true }, 'Add to workspace');
  const read = h('button.btn', {}, 'Read contract');

  const load = async (f) => {
    if (!f) return;
    if (f.size > 600_000) { err.textContent = 'That file is too large.'; return; }
    text.value = await f.text();
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    read.click();
  };
  file.addEventListener('change', () => load(file.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); });

  read.addEventListener('click', async () => {
    err.textContent = '';
    try {
      const p = await api('POST', '/api/preview', { text: text.value });
      parties = p.parties;
      chosen = null;
      save.disabled = !parties.length ? false : true;
      choose.replaceChildren(
        h('div.field', h('label', 'Which side are you?'),
          parties.length
            ? h('div.choice', parties.map((x) => h('button', {
                type: 'button',
                onclick: (e) => {
                  chosen = x.role;
                  choose.querySelectorAll('.choice button').forEach((b) => b.classList.remove('on'));
                  e.currentTarget.classList.add('on');
                  save.disabled = false;
                }
              }, h('b', x.role), x.name)))
            : h('div.hint', 'No named parties found in the opening paragraph. Findings will be listed without saying who they bind, and you can still review each one.'),
          h('div.hint', `${p.clauses} clauses, ${p.findings} terms found.`))
      );
    } catch (e) { err.textContent = e.message; }
  });

  save.addEventListener('click', async () => {
    err.textContent = '';
    save.disabled = true;
    try {
      const r = await api('POST', '/api/contracts', { title: title.value, text: text.value, perspective: chosen });
      close();
      toast('Contract added. Review the findings next.');
      ctx.go(`/app/contracts/${r.id}`);
    } catch (e) {
      save.disabled = false;
      if (e.upgrade) err.replaceChildren(e.message + ' ', h('a', { href: '/app/billing', onclick: close }, 'See plans'));
      else err.textContent = e.message;
    }
  });

  const overlay = h('div.overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.card.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add contract' },
      h('h2', 'Add a contract'),
      h('div.field', h('label', 'Title'), title),
      drop, file,
      h('div.field', text),
      choose,
      err,
      h('div.actions', h('button.btn.ghost', { onclick: () => close() }, 'Cancel'), read, save)
    )
  );
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  title.focus();
}

// ---------- detail ----------

export async function contractDetail(ctx, id) {
  const [doc, members] = await Promise.all([api('GET', `/api/contracts/${id}`), ctx.members()]);
  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  // Unnumbered text at the top is the preamble whatever its heading says.
  const clauseOf = (f) => (f.clause.number ? `§${f.clause.number}` : Number(f.clause.id.slice(1)) <= 2 ? 'Preamble' : f.clause.label.slice(0, 28));
  const reviews = doc.state.findings;
  const focusKey = new URLSearchParams(location.search).get('item');

  const docPane = renderDocument(doc, reviews);
  const flash = (fids) => {
    const marks = fids.flatMap((fid) => [...docPane.querySelectorAll(`mark[data-f~="${fid}"]`)]);
    if (!marks.length) return;
    // Scroll the document pane only, never the page, so the card that was
    // clicked stays where the reader left it.
    docPane.scrollTo({ top: marks[0].offsetTop - docPane.clientHeight / 3, behavior: 'smooth' });
    marks.forEach((m) => { m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash'); });
    setTimeout(() => marks.forEach((m) => m.classList.remove('flash')), 1800);
  };

  const reload = () => ctx.go(location.pathname + location.search, true);

  const ours = doc.schedule.items.filter((i) => i.appliesToUs !== false);
  const theirs = doc.schedule.items.filter((i) => i.appliesToUs === false);

  const itemCard = (it) => {
    const [kindLabel, kindTone] = KIND[it.kind] || [it.kind, ''];
    const done = it.status !== 'open';
    const note = h('textarea.hidden', { rows: 2, placeholder: 'What was done? This goes in the audit log.', style: { minHeight: '56px', fontFamily: 'var(--sans)', fontSize: '13px' } });
    const act = async (patch, msg) => {
      try { await api('PATCH', `/api/contracts/${id}/items/${encodeURIComponent(it.key)}`, patch); toast(msg); reload(); } catch (e) { toast(e.message, 'error'); }
    };
    const closeBtn = (status, label) => h('button.btn.small', {
      onclick: () => {
        if (note.classList.contains('hidden')) { note.classList.remove('hidden'); note.focus(); note.dataset.status = status; return; }
        act({ status: note.dataset.status || status, note: note.value }, 'Saved');
      }
    }, label);

    return h(`div.card.item${done ? '.done' : ''}`, { id: `item-${it.key}`, dataset: { key: it.key } },
      h('div.it-head',
        h(`span.pill.${kindTone}`, kindLabel),
        h(`span.pill.${it.severity}`, it.severity),
        it.status === 'done' ? h('span.pill.green', 'Done') : it.status === 'not_applicable' ? h('span.pill', 'Not applicable') : null,
        h('span.spacer'),
        it.due ? h(`span.it-due.pill.${urgency(it.daysLeft)}`, `${date(it.due)} · ${daysText(it.daysLeft)}`) : it.trigger ? h('span.small.muted', `When: ${it.trigger.toLowerCase()}`) : null
      ),
      h('div.it-title', it.title),
      it.consequence ? h('div.it-body', it.consequence) : null,
      it.missed ? h('div.assume', `Missed: the notice window for the ${date(it.missed.renewsOn)} renewal closed on ${date(it.missed.deadline)}.`) : null,
      (it.assumptions || []).filter((a) => !it.missed || !a.startsWith('The notice window')).map((a) => h('div.assume', a)),
      h('div.chips', it.citations.map((fid) => {
        const f = byId.get(fid);
        if (!f) return null;
        const rej = reviews[fid]?.decision === 'rejected';
        return h(`button.chip${rej ? '.rej' : ''}`, { title: f.quote, onclick: () => flash([fid]) }, `${clauseOf(f)} ${f.label.toLowerCase()}`);
      })),
      it.basedOnRejected ? h('div.assume', 'Built on a finding someone rejected. It is left out of the register.') : null,
      it.note ? h('div.it-body', h('b', 'Note: '), it.note) : null,
      ctx.can('work') && it.kind !== 'risk'
        ? h('div.it-actions',
            h('select', {
              'aria-label': 'Owner',
              onchange: (e) => act({ owner: e.target.value || null }, 'Owner updated')
            }, h('option', { value: '' }, 'No owner'), members.map((m) => h('option', { value: m.userId, selected: it.owner?.id === m.userId }, m.name))),
            done
              ? h('button.btn.small', { onclick: () => act({ status: 'open' }, 'Reopened') }, 'Reopen')
              : [closeBtn('done', 'Mark done'), closeBtn('not_applicable', 'Not applicable')],
            it.confirmed ? null : h('button.btn.small.primary', { onclick: () => act({ confirm: true }, 'Confirmed') }, 'Confirm'),
            note)
        : null,
      h('div.it-meta',
        it.confirmed ? `Confirmed by ${it.confirmed.by}, ${when(it.confirmed.at)}` : 'Not yet confirmed by a person',
        it.history?.length ? ` · ${it.history.length} change${it.history.length === 1 ? '' : 's'} in the audit trail` : '')
    );
  };

  const findingCard = (f) => {
    const r = reviews[f.id];
    const reason = h('input.hidden', { type: 'text', placeholder: 'Why is this wrong?' });
    const decide = async (decision) => {
      if (decision === 'rejected' && reason.classList.contains('hidden')) { reason.classList.remove('hidden'); reason.focus(); return; }
      try { await api('POST', `/api/contracts/${id}/findings/${f.id}`, { decision, reason: reason.value }); toast(decision === 'confirmed' ? 'Confirmed' : 'Rejected'); reload(); } catch (e) { toast(e.message, 'error'); }
    };
    const binds = f.subject === 'either' ? 'Both parties' : f.subject ? `${f.subject}${f.appliesToUs ? ' (you)' : ''}` : 'Not stated';
    return h(`div.card.finding${r ? '.' + r.decision : ''}`,
      h('div.row',
        h('b', f.label),
        h('button.chip', { onclick: () => flash([f.id]) }, clauseOf(f)),
        h('span.spacer'),
        r ? h(`span.pill.${r.decision === 'confirmed' ? 'green' : 'red'}`, r.decision) : h('span.pill.amber', 'to review')),
      h('div.q', f.quote),
      f.kind !== 'fact' ? h('div.small.muted', `Binds: ${binds}`) : null,
      r?.reason ? h('div.small', h('b', 'Rejected because: '), r.reason) : null,
      r ? h('div.it-meta', `${r.decision === 'confirmed' ? 'Confirmed' : 'Rejected'} by ${r.by}, ${when(r.at)}`) : null,
      ctx.can('work')
        ? h('div.it-actions',
            r?.decision !== 'confirmed' ? h('button.btn.small.primary', { onclick: () => decide('confirmed') }, 'Correct') : null,
            r?.decision !== 'rejected' ? h('button.btn.small.danger', { onclick: () => decide('rejected') }, 'Wrong') : null,
            reason)
        : null
    );
  };

  const panes = {
    ours: h('div.items', ours.length ? ours.map(itemCard) : h('p.muted', 'Nothing binds you in this contract that Termwise could find.')),
    findings: h('div.items', doc.findings.length ? doc.findings.map(findingCard) : h('p.muted', 'No terms found.')),
    theirs: h('div.items', theirs.length ? theirs.map(itemCard) : h('p.muted', 'Nothing here binds only the other side.'))
  };
  const unreviewed = doc.findings.filter((f) => !reviews[f.id]).length;
  const tabBtns = {};
  const pane = h('div');
  const show = (k) => {
    Object.entries(tabBtns).forEach(([x, b]) => b.classList.toggle('on', x === k));
    pane.replaceChildren(panes[k]);
  };
  const tabs = h('div.tabs',
    tabBtns.ours = h('button', { onclick: () => show('ours') }, `Your obligations (${ours.length})`),
    tabBtns.findings = h('button', { onclick: () => show('findings') }, `Findings${unreviewed ? ` (${unreviewed} to review)` : ''}`),
    tabBtns.theirs = h('button', { onclick: () => show('theirs') }, `Their side (${theirs.length})`)
  );
  show('ours');

  // Clicking highlighted text opens the findings it came from.
  docPane.addEventListener('click', (e) => {
    const m = e.target.closest('mark');
    if (!m) return;
    show('findings');
    const first = m.dataset.f.split(' ')[0];
    const idx = doc.findings.findIndex((f) => f.id === first);
    panes.findings.children[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  const persp = h('div.persp',
    h('span.muted', 'Reading as'),
    doc.parties.length
      ? doc.parties.map((p) => h(`button.btn.small${p.role === doc.perspective ? '.primary' : ''}`, {
          disabled: !ctx.can('manage') || p.role === doc.perspective,
          title: p.name,
          onclick: async () => {
            try { await api('POST', `/api/contracts/${id}/perspective`, { perspective: p.role }); toast(`Now reading as ${p.role}`); reload(); } catch (e) { toast(e.message, 'error'); }
          }
        }, p.role))
      : h('span.pill.amber', 'No parties found')
  );

  const t = doc.schedule.term;
  const head = h('div.page-head',
    h('div',
      h('div.small', h('a', { href: '/app/contracts' }, 'Contracts'), ' / '),
      h('h1', doc.title),
      h('div.sub', [
        doc.counterparty ? `With ${doc.counterparty}` : null,
        t ? `${date(t.start)} to ${date(t.end)}${t.autoRenews ? ', renews itself' : ''}` : 'Term not stated',
        doc.schedule.annualValue ? `${money(doc.schedule.annualValue.amount, doc.schedule.annualValue.currency)} a year` : null
      ].filter(Boolean).join(' · '))
    ),
    h('span.spacer'),
    persp,
    ctx.can('manage') ? h('button.btn.danger.small', { onclick: () => confirmErase(ctx, doc) }, 'Erase') : null
  );

  const layout = h('div', head, h('div.detail',
    h('div.card',
      h('div.doc-head',
        h('span', `Source text · ${doc.clauses.length} clauses`),
        h('span.spacer'),
        h('span.hash', { title: `SHA-256 of the stored text: ${doc.textHash}` }, `sha256 ${doc.textHash.slice(0, 12)}`)),
      docPane),
    h('div', tabs, pane)
  ));

  if (focusKey) {
    setTimeout(() => {
      const el = layout.querySelector(`#item-${CSS.escape(focusKey)}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.style.boxShadow = '0 0 0 2px var(--accent)';
        const it = doc.schedule.items.find((x) => x.key === focusKey);
        if (it) flash(it.citations);
      }
    }, 150);
  }
  return layout;
}

// Builds the document as text nodes with <mark> around each finding span.
// Spans overlap (the renewal and notice terms often share a sentence), so the
// text is cut at every span boundary and each piece lists every finding that
// covers it.
function renderDocument(doc, reviews) {
  const pre = h('div.doc');
  const cuts = new Set([0, doc.text.length]);
  for (const f of doc.findings) { cuts.add(f.span.start); cuts.add(f.span.end); }
  const points = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const piece = doc.text.slice(a, b);
    const cover = doc.findings.filter((f) => f.span.start <= a && f.span.end >= b);
    if (!cover.length) { pre.append(document.createTextNode(piece)); continue; }
    const allRejected = cover.every((f) => reviews[f.id]?.decision === 'rejected');
    pre.append(h(`mark${allRejected ? '.rejected' : ''}`, { dataset: { f: cover.map((f) => f.id).join(' ') }, title: cover.map((f) => f.label).join(', ') }, piece));
  }
  return pre;
}

function confirmErase(ctx, doc) {
  const reason = h('input', { type: 'text', placeholder: 'For example: contract ended, retention period over' });
  const err = h('div.err');
  const overlay = h('div.overlay', { onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h('div.card.modal',
      h('h2', `Erase "${doc.title}"?`),
      h('p', 'The contract text, its findings and all review notes are deleted for good. The audit trail keeps a record that it was erased, with the SHA-256 of the text, but none of the text itself.'),
      h('div.field', h('label', 'Reason (goes in the audit trail)'), reason),
      err,
      h('div.actions',
        h('button.btn.ghost', { onclick: () => overlay.remove() }, 'Cancel'),
        h('button.btn.danger', {
          onclick: async () => {
            try {
              await api('DELETE', `/api/contracts/${doc.id}`, { reason: reason.value });
              overlay.remove();
              toast('Contract erased');
              ctx.go('/app/contracts');
            } catch (e) { err.textContent = e.message; }
          }
        }, 'Erase contract')))
  );
  document.body.append(overlay);
  reason.focus();
}
