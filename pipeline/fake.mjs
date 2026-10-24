// Fake data: shows realistic fake values in place of the personal data a page
// renders (names, initials, emails, phones, message text, tags), so a take on a
// live account never shows a real contact. Used by driver.mjs. App-independent:
// a target's `fake` option says which elements hold what; emails and phones
// are also found by pattern anywhere on the page.
//
// It changes only what the recorder's Chrome displays. It never types, fires
// input events or saves, and a faked <input> gets its real value back the
// moment it is focused, so an app that saves on blur cannot save a fake value.
//
// The same real value always gets the same fake one (a hash of the value and
// `seed`), so a contact keeps one name across the list, the header and the
// details panel, and across takes.
//
// target option:
//   "fake": {
//     "names":    ["<selector>", ...],  text is a person's name
//     "initials": ["<selector>", ...],  avatar initials, follow the faked name
//     "messages": ["<selector>", ...],  free text: message bodies, previews
//     "tags":     ["<selector>", ...],  tag chips
//     "inputs":   { "<selector>": "name|first|last|email|phone", ... },
//     "text":     ["email", "phone"],   swap these patterns anywhere
//     "seed":     "any string"          changes every fake value; optional
//   }

export const FAKE_KEYS = new Set(['names', 'initials', 'messages', 'tags', 'inputs', 'text', 'seed']);
export const FAKE_TEXT = new Set(['email', 'phone']);
export const FAKE_INPUT_KINDS = new Set(['name', 'first', 'last', 'email', 'phone']);

// throws on a malformed `fake` block; returns it with defaults filled in
export function normaliseFake(fake) {
  if (!fake) return null;
  const bad = Object.keys(fake).filter((k) => !FAKE_KEYS.has(k) && !k.startsWith('//'));
  if (bad.length) throw new Error(`target fake: unknown key(s) ${bad.join(', ')} (known: ${[...FAKE_KEYS].join(', ')})`);
  const text = fake.text ?? [];
  const badText = text.filter((k) => !FAKE_TEXT.has(k));
  if (badText.length) throw new Error(`target fake.text takes ${[...FAKE_TEXT].join(', ')}; got ${badText.join(', ')}`);
  const inputs = Object.fromEntries(Object.entries(fake.inputs ?? {}).filter(([k]) => !k.startsWith('//')));
  const badKinds = Object.values(inputs).filter((k) => !FAKE_INPUT_KINDS.has(k));
  if (badKinds.length) throw new Error(`target fake.inputs kinds are ${[...FAKE_INPUT_KINDS].join(', ')}; got ${badKinds.join(', ')}`);
  return {
    names: fake.names ?? [],
    initials: fake.initials ?? [],
    messages: fake.messages ?? [],
    tags: fake.tags ?? [],
    inputs,
    text,
    seed: String(fake.seed ?? ''),
  };
}

// Runs in the page (serialised by puppeteer), so it must be self-contained.
export function installFake({ names, initials, messages, tags, inputs, text, seed }) {
  if (window.__demoFake) return;
  const stats = { names: 0, initials: 0, messages: 0, tags: 0, emails: 0, phones: 0, inputs: 0 };
  window.__demoFake = stats;

  const FIRST = ['Jane', 'Marcus', 'Priya', 'Tom', 'Lena', 'Owen', 'Grace', 'Diego', 'Hannah', 'Sam', 'Nora', 'Eli',
    'Maya', 'Ben', 'Ava', 'Leo', 'Chloe', 'Ravi', 'Zoe', 'Noah', 'Iris', 'Caleb', 'Mia', 'Jonah', 'Ella', 'Theo',
    'Ruby', 'Isaac', 'Lucy', 'Adam'];
  const LAST = ['Cooper', 'Reed', 'Shah', 'Alvarez', 'Brooks', 'Patel', 'Kim', 'Santos', 'Wells', 'Turner', 'Quinn',
    'Foster', 'Lopez', 'Carter', 'Morgan', 'Hayes', 'Bennett', 'Nguyen', 'Ross', 'Murphy', 'Price', 'Ward', 'Ellis',
    'Gray', 'Diaz', 'Hughes', 'Long', 'Fisher', 'Hart', 'Stone'];
  const MESSAGES = ['Hi! Is the 3pm slot still open tomorrow?', 'Thanks, that works for me.',
    'Can you send over the updated quote?', 'Got it, see you Thursday.', 'Perfect, I just booked a time.',
    'Could we move the call to Friday?', 'Yes, please add me to the list.', 'Great, thanks for the quick reply!',
    'What time do you open on Saturday?', 'Sounds good, talk soon.', 'Do you have any availability next week?',
    'Just checking in on my order.', 'That would be great, thank you!', 'Can I bring a colleague along?',
    'Is there a discount for annual plans?', 'Received, thanks!'];
  const TAGS = ['Lead', 'Customer', 'VIP', 'Follow up', 'Webinar', 'Trial', 'Newsletter', 'Event', 'Partner', 'Renewal'];

  // FNV-1a: stable across pages and takes
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (const ch of seed + '\u0000' + s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return h;
  };
  const fakeName = (real) => { const h = hash(real); return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`; };
  const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  // 555-0100..0199 is reserved for fiction in North America
  const AREA = ['212', '312', '415', '512', '617', '702', '206', '303', '404', '305'];
  const fakePhone = (real) => `+1 (${pick(AREA, real)}) 555-01${String((hash(real) >>> 9) % 100).padStart(2, '0')}`;
  const fakeEmail = (real) => fakeName(real).toLowerCase().replace(' ', '.') + '@example.com';
  const pick = (list, real) => list[hash(real) % list.length];

  const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g;
  const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
  const isPhone = (m) => m.replace(/\D/g, '').length >= 9; // keeps dates and times
  const TIME_OR_DATE = /^(\d{1,2}:\d{2}(\s?[ap]m)?|\w{3} \d{1,2}(, \d{4})?|\d+[smhdw]|today|yesterday)$/i;

  const realInitials = new Map(); // real initials -> fake, filled as names are swapped
  const seenNames = new Map(); // real name -> fake, so the same name elsewhere is swapped too
  const set = new WeakMap(); // text node -> the value we gave it
  const join = (list) => list.join(', ');
  const SEL = { initials: join(initials), messages: join(messages), tags: join(tags), names: join(names) };
  const inside = (el, key) => SEL[key] && el.closest(SEL[key]);

  const patterns = (v) => {
    let out = v;
    if (text.includes('email')) out = out.replace(EMAIL, (m) => { stats.emails++; return fakeEmail(m); });
    if (text.includes('phone')) out = out.replace(PHONE, (m) => (isPhone(m) ? (stats.phones++, fakePhone(m)) : m));
    return out;
  };
  const swapName = (real) => {
    const fake = fakeName(real);
    seenNames.set(real, fake);
    realInitials.set(initialsOf(real), initialsOf(fake));
    stats.names++;
    return fake;
  };

  // initials take the fake name shown in the same row or card, whichever of
  // the two renders first
  const initialsNear = (el) => {
    if (!SEL.names) return null;
    for (let a = el.parentElement, i = 0; a && i < 8; a = a.parentElement, i++) {
      const nameEl = a.querySelector(SEL.names);
      if (!nameEl) continue;
      const w = document.createTreeWalker(nameEl, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = n.nodeValue.trim();
        if (!/\p{L}/u.test(t) || nameEl.querySelector(SEL.initials)?.contains(n)) continue;
        return initialsOf(set.get(n) === n.nodeValue ? t : seenNames.get(t) ?? fakeName(t));
      }
      return null;
    }
    return null;
  };

  const swap = (n) => {
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) return;
    if (set.get(n) === n.nodeValue) return;
    const raw = n.nodeValue;
    const v = raw.trim();
    if (!v) return;
    let next = raw;
    if (inside(el, 'initials')) {
      if (/^[A-Za-z]{1,3}$/.test(v)) {
        next = initialsNear(el) ?? realInitials.get(v.toUpperCase()) ?? initialsOf(fakeName(v));
        stats.initials++;
      }
    } else if (inside(el, 'messages')) {
      if (/[A-Za-z]{2}/.test(v) && !TIME_OR_DATE.test(v)) { next = pick(MESSAGES, v); stats.messages++; }
    } else if (inside(el, 'tags')) {
      if (/[A-Za-z]/.test(v)) { next = pick(TAGS, v); stats.tags++; }
    } else if (inside(el, 'names')) {
      const p = patterns(raw);
      if (p !== raw) next = p;
      else if (/\p{L}/u.test(v)) next = raw.replace(v, swapName(v));
    } else if (seenNames.has(v)) {
      next = raw.replace(v, seenNames.get(v));
      stats.names++;
    } else {
      next = patterns(raw);
    }
    if (next !== raw) n.nodeValue = next;
    set.set(n, n.nodeValue);
  };
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return swap(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) swap(n);
  };

  // inputs: the app re-renders their value, so re-apply each frame
  const real = new WeakMap(); // input -> its real value
  const faked = new WeakMap(); // input -> the fake we showed
  // a first or last name field follows a full name already swapped on the page
  const fromSeen = (v, i) => {
    for (const [r, f] of seenNames) if (r.split(/\s+/)[i] === v) return f.split(' ')[i];
    return null;
  };
  const fakeFor = (kind, v) => {
    if (kind === 'first' || kind === 'last') {
      const seen = fromSeen(v, kind === 'first' ? 0 : 1);
      if (seen) return seen;
    }
    const name = fakeName(v);
    return { name, first: name.split(' ')[0], last: name.split(' ')[1], email: fakeEmail(v), phone: fakePhone(v) }[kind];
  };
  const inputSel = Object.keys(inputs);
  const tickInputs = () => {
    for (const sel of inputSel) {
      for (const el of document.querySelectorAll(sel)) {
        const input = el.matches('input, textarea') ? el : el.querySelector('input, textarea');
        if (!input || !input.value || document.activeElement === input) continue;
        if (faked.get(input) === input.value) continue;
        real.set(input, input.value);
        const fake = fakeFor(inputs[sel], input.value);
        input.value = fake;
        faked.set(input, fake);
        stats.inputs++;
      }
    }
    requestAnimationFrame(tickInputs);
  };
  // give a focused input its real value back, so a save-on-blur saves the real one
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (real.has(t) && faked.get(t) === t.value) { t.value = real.get(t); faked.delete(t); }
  }, true);

  const start = () => {
    walk(document.body);
    // callbacks run before the next paint, so no frame shows a real value
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') swap(r.target);
        else r.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    if (inputSel.length) requestAnimationFrame(tickInputs);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}
