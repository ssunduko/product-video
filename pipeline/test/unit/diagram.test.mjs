// Diagrams (diagram.mjs): the spec, ranks along a flow, placement that leaves
// room for arrow labels, where arrows leave a shape, icons, and rendering steps;
// and how inserts.mjs expands a diagram into one image per step.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDiagram, ranks, place, exitPoint, iconPaths, searchIcons, renderDiagram } from '../../diagram.mjs';
import { expandDiagrams } from '../../inserts.mjs';

const FLOW = {
  nodes: [
    { id: 'a', label: 'Text', icon: 'message-square' },
    { id: 'b', label: 'Agent', icon: 'bot', step: 2 },
    { id: 'c', label: 'Calendar', icon: 'calendar-check', step: 3 },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'asks', step: 2 },
    { from: 'b', to: 'c', step: 3 },
  ],
};

describe('normaliseDiagram', () => {
  test('defaults: right flow, light theme, box shape, step 1; steps is the highest', () => {
    const d = normaliseDiagram(FLOW);
    assert.equal(d.layout, 'right');
    assert.equal(d.theme, 'light');
    assert.equal(d.nodes[0].shape, 'box');
    assert.equal(d.nodes[0].step, 1);
    assert.equal(d.steps, 3);
  });

  test('every node with x and y means a manual layout', () => {
    assert.equal(normaliseDiagram({ nodes: [{ id: 'a', x: 1, y: 2 }] }).layout, 'manual');
  });

  test('names the problem', () => {
    assert.throws(() => normaliseDiagram({ nodes: [{ label: 'x' }] }), /node 1 has no id/);
    assert.throws(() => normaliseDiagram({ nodes: [{ id: 'a' }, { id: 'a' }] }), /two nodes are called "a"/);
    assert.throws(() => normaliseDiagram({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'z' }] }), /to "z" is not a node/);
    assert.throws(() => normaliseDiagram({ nodes: [{ id: 'a', icon: 'no-such-icon' }] }), /not a Lucide icon/);
    assert.throws(() => normaliseDiagram({ nodes: [{ id: 'a', shape: 'star' }] }), /shape/);
    assert.throws(() => normaliseDiagram({ nodes: [{ id: 'a' }], layout: 'manual' }), /needs x and y/);
    assert.throws(() => normaliseDiagram({}), /nothing to draw/);
    assert.throws(() => normaliseDiagram({ chart: { type: 'pie', data: [1] } }), /bars/);
  });
});

describe('ranks', () => {
  test('longest path from a source; a cycle does not loop', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const r = ranks(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'd' }]);
    assert.deepEqual(Object.fromEntries(r), { a: 0, b: 1, c: 2, d: 1 });
  });
});

describe('place', () => {
  const area = { x: 0, y: 0, w: 2000, h: 1000 };
  const sizes = new Map([['a', { w: 200, h: 100 }], ['b', { w: 300, h: 100 }], ['c', { w: 200, h: 100 }]]);

  test('a right flow leaves each label its gap, and is centred', () => {
    const d = normaliseDiagram(FLOW);
    const pos = place(d, area, sizes, { labelW: new Map([['a>b', 400]]), minGap: 100, labelPad: 50 });
    const gapAB = (pos.get('b').x - 150) - (pos.get('a').x + 100);
    const gapBC = (pos.get('c').x - 100) - (pos.get('b').x + 150);
    assert.equal(gapAB, 450);
    assert.equal(gapBC, 100);
    const left = pos.get('a').x - 100;
    const right = pos.get('c').x + 100;
    assert.equal(left, 2000 - right);
    assert.equal(pos.fits, true);
  });

  test('says when the flow does not fit', () => {
    const pos = place(normaliseDiagram(FLOW), { x: 0, y: 0, w: 500, h: 500 }, sizes);
    assert.equal(pos.fits, false);
  });

  test('down stacks the ranks vertically; grid fills cells; manual keeps x and y', () => {
    const down = place({ ...normaliseDiagram(FLOW), layout: 'down' }, area, sizes);
    assert.ok(down.get('a').y < down.get('b').y && down.get('b').y < down.get('c').y);
    assert.equal(down.get('a').x, 1000);
    const grid = place({ ...normaliseDiagram(FLOW), layout: 'grid', columns: 2 }, area, sizes);
    assert.deepEqual(grid.get('c'), { x: 500, y: 750 });
    const manual = place(normaliseDiagram({ nodes: [{ id: 'a', x: 10, y: 20 }] }), area);
    assert.deepEqual(manual.get('a'), { x: 10, y: 20 });
  });
});

describe('exitPoint', () => {
  test('a box: on its edge plus the gap, towards the target', () => {
    assert.deepEqual(exitPoint({ x: 0, y: 0 }, { w: 100, h: 50 }, 'box', 1000, 0, 10), { x: 110, y: 0 });
    assert.deepEqual(exitPoint({ x: 0, y: 0 }, { w: 100, h: 50 }, 'box', 0, -1000, 10), { x: 0, y: -60 });
  });

  test('a circle: on its radius plus the gap', () => {
    const p = exitPoint({ x: 0, y: 0 }, { w: 50, h: 50 }, 'circle', 300, 400, 10);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - 60) < 1e-9);
  });
});

describe('icons', () => {
  test('names and old aliases both resolve; search finds by part of a name', () => {
    assert.ok(iconPaths('calendar-check').length);
    assert.ok(iconPaths('activity-square'));
    assert.equal(iconPaths('nope-nope'), null);
    assert.ok(searchIcons('calendar').includes('calendar-check'));
  });
});

describe('renderDiagram', () => {
  test('one canvas per step, the size asked for; later steps draw more', () => {
    const ink = (step) => {
      const { canvas } = renderDiagram(FLOW, { width: 640, height: 360, step });
      const px = canvas.getContext('2d').getImageData(0, 0, 640, 360).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] < 200 || px[i + 1] < 200) n++;
      return { n, w: canvas.width, h: canvas.height };
    };
    const [s1, s3] = [ink(1), ink(3)];
    assert.equal(s1.w, 640);
    assert.equal(s1.h, 360);
    assert.ok(s3.n > s1.n);
  });

  test('a bar chart alone renders', () => {
    const { canvas, steps } = renderDiagram({ chart: { type: 'bars', data: [{ label: 'A', value: 2 }, { label: 'B', value: 5 }] } }, { width: 320, height: 180 });
    assert.equal(steps, 1);
    assert.equal(canvas.width, 320);
  });
});

describe('expandDiagrams (inserts.mjs)', () => {
  test('a diagram becomes one full-frame image per step, sharing its share', () => {
    const out = expandDiagrams([{ file: 'a.jpg', share: 0.5 }, { diagram: 'd.json', share: 0.5 }], () => 2);
    assert.deepEqual(out, [
      { file: 'a.jpg', share: 0.5 },
      { diagram: 'd.json', fit: 'frame', step: 1, share: 0.25 },
      { diagram: 'd.json', fit: 'frame', step: 2, share: 0.25 },
    ]);
  });

  test('a diagram with a step stays one image', () => {
    assert.deepEqual(expandDiagrams([{ diagram: 'd.json', step: 3 }], () => 9), [{ fit: 'frame', diagram: 'd.json', step: 3 }]);
  });
});
