// Target options that condition the page (target.mjs): replaceText and
// blurSelectors, and the in-page text replacer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTarget, textReplacer } from '../../target.mjs';

const writeTarget = (cfg) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-'));
  const file = path.join(dir, 'unit.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'https://example.com', ...cfg }));
  return file;
};

describe('loadTarget', () => {
  test('reads replaceText and blurSelectors', () => {
    const t = loadTarget(writeTarget({
      blurSelectors: ['.avatar'],
      replaceText: [{ from: 'Real Name', to: 'Maya Brooks' }, { from: 'RN', to: 'MB', whole: true }],
    }));
    assert.deepEqual(t.blurSelectors, ['.avatar']);
    assert.deepEqual(t.replaceText, [
      { from: 'Real Name', to: 'Maya Brooks', whole: false },
      { from: 'RN', to: 'MB', whole: true },
    ]);
  });

  test('defaults both to empty', () => {
    const t = loadTarget(writeTarget({}));
    assert.deepEqual(t.blurSelectors, []);
    assert.deepEqual(t.replaceText, []);
  });

  test('refuses a pair without a from', () => {
    assert.throws(() => loadTarget(writeTarget({ replaceText: [{ to: 'x' }] })), /replaceText\[0\]/);
  });
});

// A minimal DOM: text nodes under one element, walked in order.
function fakeDom(texts, inputs = []) {
  const root = { nodeType: 1, nodeName: 'DIV', children: [] };
  root.children = texts.map(([value, parent = 'SPAN']) => ({ nodeType: 3, nodeValue: value, parentNode: { nodeName: parent } }));
  const saved = {};
  for (const k of ['document', 'NodeFilter', 'MutationObserver', 'setInterval']) saved[k] = globalThis[k];
  globalThis.document = {
    documentElement: root,
    activeElement: null,
    addEventListener() {},
    querySelectorAll: (sel) => (sel === 'input' ? inputs : []),
    createTreeWalker(node) {
      const list = node === root ? root.children : [];
      let i = 0;
      return { nextNode: () => list[i++] ?? null };
    },
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.setInterval = () => 0; // the input re-check timer would keep the test alive
  return { nodes: root.children, inputs, restore: () => Object.assign(globalThis, saved) };
}

describe('textReplacer', () => {
  test('replaces longest first, whole-only pairs on exact text, and skips scripts', () => {
    const dom = fakeDom([['Call with Pat Lane'], ['Pat'], ['Patio'], ['PL'], ['Pat Lane', 'SCRIPT']]);
    try {
      textReplacer([
        { from: 'Pat', to: 'Maya', whole: true },
        { from: 'Pat Lane', to: 'Maya Brooks' },
        { from: 'PL', to: 'MB', whole: true },
      ]);
      assert.deepEqual(dom.nodes.map((n) => n.nodeValue), ['Call with Maya Brooks', 'Maya', 'Patio', 'MB', 'Pat Lane']);
    } finally {
      dom.restore();
    }
  });

  test('replaces input values too (a Phone field), but not passwords', () => {
    const dom = fakeDom([], [{ type: 'text', value: '+1 212 555 0100' }, { type: 'password', value: '+1 212 555 0100' }]);
    try {
      textReplacer([{ from: '+1 212 555 0100', to: '+1 805 555 0147' }]);
      assert.deepEqual(dom.inputs.map((i) => i.value), ['+1 805 555 0147', '+1 212 555 0100']);
    } finally {
      dom.restore();
    }
  });
});

describe('textReplacer input setter', () => {
  test('a value the app sets is swapped as it is set, with no frame of the real one', () => {
    const dom = fakeDom([]);
    const saved = globalThis.HTMLInputElement;
    // a stand-in input whose `value` lives on the prototype, as in a browser
    class FakeInput { constructor(type = 'text') { this.type = type; this._v = ''; } }
    Object.defineProperty(FakeInput.prototype, 'value', {
      configurable: true, enumerable: true,
      get() { return this._v; }, set(v) { this._v = v; },
    });
    globalThis.HTMLInputElement = FakeInput;
    try {
      textReplacer([{ from: '+1 212 555 0100', to: '+1 805 555 0147' }]);
      const phone = new FakeInput();
      phone.value = '+1 212 555 0100';
      assert.equal(phone._v, '+1 805 555 0147', 'the stored value was never the real one');
      const pw = new FakeInput('password');
      pw.value = '+1 212 555 0100';
      assert.equal(pw._v, '+1 212 555 0100');
    } finally {
      globalThis.HTMLInputElement = saved;
      dom.restore();
    }
  });
});

describe('textReplacer attributes', () => {
  test('initials drawn by CSS from data-name are swapped like text', () => {
    const avatar = {
      nodeType: 1, nodeName: 'DIV', attrs: { 'data-name': 'PL' },
      getAttribute(a) { return this.attrs[a] ?? null; },
      setAttribute(a, v) { this.attrs[a] = v; },
    };
    const dom = fakeDom([]);
    document.documentElement.querySelectorAll = (sel) => (sel === '[data-name]' ? [avatar] : []);
    try {
      textReplacer([{ from: 'PL', to: 'MB', whole: true }]);
      assert.equal(avatar.attrs['data-name'], 'MB');
    } finally {
      dom.restore();
    }
  });
});

