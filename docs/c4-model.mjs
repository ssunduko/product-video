// The C4 model of this repo, and the generator for every rendering of it.
//
//   node docs/c4-model.mjs
//     -> docs/ProductVideo-C4.mdj   StarUML project, four diagrams
//     -> docs/c4-*.puml             C4-PlantUML, one file per diagram
//     -> docs/C4.md                 the same model as tables + mermaid
//
// THIS FILE IS THE SOURCE OF TRUTH. Three renderings of one model drift the
// moment they are maintained separately, so none of the outputs is hand-edited
// — change the model here and re-run. (Reopening the .mdj in StarUML and moving
// boxes is fine and expected; re-running overwrites that layout, so if you
// rearrange something worth keeping, copy the coordinates back into place().)
//
// The .mdj is generated rather than hand-written for a second reason: its
// failure mode is a file that parses as JSON and then will not open. The
// validator at the bottom checks the invariants that actually break StarUML —
// unique _id, resolvable $ref, a _parent on everything, both ends of every edge
// present on the diagram that draws it — before anything is written.
//
// An element carries three things, and which one a rendering shows differs:
//   name   short, on the box in every rendering
//   tech   the implementing file / protocol, on the box in PlantUML and StarUML
//   doc    the full C4 description. PlantUML shows its first sentence, because a
//          C4 box wants a caption; C4.md and the StarUML Documentation panel
//          carry all of it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MDJ = path.join(HERE, 'ProductVideo-C4.mdj');
const MD = path.join(HERE, 'C4.md');

// ---- C4 palette (structurizr's defaults, so the diagrams read as C4) ----
const COLOR = {
  person: { fill: '#08427b', font: '#ffffff' },
  system: { fill: '#1168bd', font: '#ffffff' },
  external: { fill: '#999999', font: '#ffffff' },
  container: { fill: '#438dd5', font: '#ffffff' },
  // C4 gives a datastore the same blue as a container and distinguishes it by
  // shape. A UMLClassView is always a rectangle, so in StarUML the distinction
  // has to be carried by tone instead or the two read as the same thing.
  store: { fill: '#2e6da4', font: '#ffffff' },
  component: { fill: '#85bbf0', font: '#000000' },
};

const KIND_LABEL = {
  person: 'Person',
  system: 'Software System',
  external: 'External System',
  container: 'Container',
  store: 'File store',
  component: 'Component',
};

// C4-PlantUML macro per kind
const PUML_MACRO = {
  person: 'Person',
  system: 'System',
  external: 'System_Ext',
  container: 'Container',
  store: 'ContainerDb',
  component: 'Component',
};

const W = 220;
const H = 90;

let seq = 0;
const uid = (tag) => `c4-${tag}-${String(++seq).padStart(4, '0')}`;
const ref = (id) => ({ $ref: id });

const elements = [];
const push = (o) => (elements.push(o), o);

const diagrams = [];
let current = null;

// ------------------------------------------------------------- model types
function stereotype(parentId, name) {
  return push({ _type: 'UMLStereotype', _id: uid('st'), _parent: ref(parentId), name });
}

function dependency(parentId, sourceId, targetId, name) {
  return push({
    _type: 'UMLDependency',
    _id: uid('dep'),
    _parent: ref(parentId),
    name,
    source: ref(sourceId),
    target: ref(targetId),
  });
}

// ------------------------------------------------------------------- views
// A UMLClassView owns five compartments; the name compartment owns four
// labels, and both the subViews array and the named refs to them have to be
// present. StarUML re-runs its own layout when the diagram opens, so the label
// geometry only has to be sane — but the objects have to exist, or the view has
// nothing to lay out.
function classView(diagramId, model, x, y, palette, w, h) {
  const vid = uid('v');
  const ncId = uid('nc');
  const [lblSt, lblName, lblNs, lblProp] = [uid('lbl'), uid('lbl'), uid('lbl'), uid('lbl')];
  const [acId, ocId, rcId, tcId] = [uid('ac'), uid('oc'), uid('rc'), uid('tc')];

  const label = (id, text, font, top, visible) => ({
    _type: 'LabelView',
    _id: id,
    _parent: ref(ncId),
    model: ref(model._id),
    visible,
    font,
    left: x + 5,
    top,
    width: w - 10,
    height: 13,
    text,
    horizontalAlignment: 2,
    verticalAlignment: 5,
  });

  const st = model.__tech
    ? `«${KIND_LABEL[model.__kind].toLowerCase()}: ${model.__tech}»`
    : `«${KIND_LABEL[model.__kind].toLowerCase()}»`;

  const nameCompartment = {
    _type: 'UMLNameCompartmentView',
    _id: ncId,
    _parent: ref(vid),
    model: ref(model._id),
    subViews: [
      label(lblSt, st, 'Arial;11;0', y + 5, true),
      label(lblName, model.name, 'Arial;14;1', y + 20, true),
      label(lblNs, '', 'Arial;12;0', y + 35, false),
      label(lblProp, '', 'Arial;12;0', y + 35, false),
    ],
    font: 'Arial;13;0',
    left: x,
    top: y,
    width: w,
    height: 40,
    stereotypeLabel: ref(lblSt),
    nameLabel: ref(lblName),
    namespaceLabel: ref(lblNs),
    propertyLabel: ref(lblProp),
  };

  const emptyCompartment = (id, type, top) => ({
    _type: type,
    _id: id,
    _parent: ref(vid),
    model: ref(model._id),
    visible: false,
    subViews: [],
    font: 'Arial;13;0',
    left: x,
    top,
    width: w,
    height: 10,
  });

  return {
    _type: 'UMLClassView',
    _id: vid,
    _parent: ref(diagramId),
    model: ref(model._id),
    subViews: [
      nameCompartment,
      emptyCompartment(acId, 'UMLAttributeCompartmentView', y + 40),
      emptyCompartment(ocId, 'UMLOperationCompartmentView', y + 50),
      emptyCompartment(rcId, 'UMLReceptionCompartmentView', y + 60),
      emptyCompartment(tcId, 'UMLTemplateParameterCompartmentView', y + 70),
    ],
    font: 'Arial;13;0',
    fillColor: palette.fill,
    fontColor: palette.font,
    lineColor: palette.fill,
    left: x,
    top: y,
    width: w,
    height: h,
    nameCompartment: ref(ncId),
    attributeCompartment: ref(acId),
    operationCompartment: ref(ocId),
    receptionCompartment: ref(rcId),
    templateParameterCompartment: ref(tcId),
    suppressAttributes: true,
    suppressOperations: true,
    stereotypeDisplay: 'label',
    wordWrap: true,
    __box: { x, y, w, h },
    __el: model,
  };
}

function dependencyView(diagramId, model, tailView, headView) {
  const vid = uid('ev');
  const t = tailView.__box;
  const h = headView.__box;
  const mid = (a, b) => Math.round((a + b) / 2);

  const lbl = (id, text, visible, dy) => ({
    _type: 'EdgeLabelView',
    _id: id,
    _parent: ref(vid),
    model: ref(model._id),
    visible,
    font: 'Arial;11;0',
    text,
    left: mid(t.x, h.x),
    top: mid(t.y, h.y) + dy,
    width: 150,
    height: 13,
    alpha: 1.5707963267948966,
    distance: 18,
    hostEdge: ref(vid),
    edgePosition: 1,
  });

  const [nameId, stId, propId] = [uid('elbl'), uid('elbl'), uid('elbl')];

  return {
    _type: 'UMLDependencyView',
    _id: vid,
    _parent: ref(diagramId),
    model: ref(model._id),
    subViews: [
      lbl(nameId, model.name ?? '', true, 0),
      lbl(stId, '', false, 14),
      lbl(propId, '', false, 28),
    ],
    font: 'Arial;13;0',
    head: ref(headView._id),
    tail: ref(tailView._id),
    points: `${Math.round(t.x + t.w / 2)}:${Math.round(t.y + t.h / 2)};${Math.round(h.x + h.w / 2)}:${Math.round(h.y + h.h / 2)}`,
    nameLabel: ref(nameId),
    stereotypeLabel: ref(stId),
    propertyLabel: ref(propId),
  };
}

// ----------------------------------------------------------------- project
const projectId = uid('project');
const modelId = uid('model');
const profileId = uid('profile');

const project = { _type: 'Project', _id: projectId, name: 'ProductVideo — C4', ownedElements: [] };

const MODEL_DOC =
  'C4 model of the ProductVideo repo — the scripted pipeline that turns a plain-English flow ' +
  'into a narrated, branded MP4.\n\n' +
  'Levels: 1 System Context, 2 Containers, 3 Components (every container drawn).\n\n' +
  'Generated from docs/c4-model.mjs — edit that and re-run rather than editing the ' +
  'generated files.\n\n' +
  'The Express scaffold in sample-app/ (app.js, routes/, views/, bin/) is an ' +
  'untouched express-generator skeleton, not part of this system, and is deliberately ' +
  'not modelled.';

const model = push({
  _type: 'UMLModel',
  _id: modelId,
  _parent: ref(projectId),
  name: 'Demo Video Pipeline',
  documentation: MODEL_DOC,
  ownedElements: [],
});
project.ownedElements.push(model);

const profile = push({
  _type: 'UMLProfile',
  _id: profileId,
  _parent: ref(modelId),
  name: 'C4',
  ownedElements: [],
});
model.ownedElements.push(profile);

const ST = {};
for (const kind of Object.keys(KIND_LABEL)) {
  const st = stereotype(profileId, KIND_LABEL[kind].toLowerCase());
  profile.ownedElements.push(st);
  ST[kind] = st;
}

function pkg(name, documentation) {
  const p = push({
    _type: 'UMLPackage',
    _id: uid('pkg'),
    _parent: ref(modelId),
    name,
    documentation,
    ownedElements: [],
  });
  model.ownedElements.push(p);
  return p;
}

// `boundary` is what PlantUML draws around the elements this diagram owns:
// the system box at L2, the container box at L3. L1 has none.
function diagram(parent, slug, name, documentation, boundary = null) {
  const d = push({
    _type: 'UMLClassDiagram',
    _id: uid('dgm'),
    _parent: ref(parent._id),
    name,
    documentation,
    defaultDiagram: false,
    ownedViews: [],
  });
  parent.ownedElements.push(d);
  current = { slug, name, documentation, owner: parent, boundary, nodes: [], links: [] };
  diagrams.push(current);
  return d;
}

// `kind` drives the stereotype, the C4 colour, the PlantUML macro and the
// markdown table together, so the four cannot disagree.
function mk(parent, kind, name, tech, doc) {
  const el = push({
    _type: 'UMLClass',
    _id: uid('el'),
    _parent: ref(parent._id),
    name,
    stereotype: ref(ST[kind]._id),
    documentation: tech ? `Technology: ${tech}\n\n${doc}` : doc,
  });
  el.__kind = kind;
  el.__tech = tech;
  el.__doc = doc;
  parent.ownedElements.push(el);
  return el;
}

function place(dgm, el, x, y, w = W, h = H) {
  const v = classView(dgm._id, el, x, y, COLOR[el.__kind], w, h);
  dgm.ownedViews.push(v);
  current.nodes.push(el);
  return v;
}

// Only StarUML reads these coordinates — PlantUML and mermaid lay themselves
// out — so the component diagrams use a grid rather than hand-placed boxes.
function grid(dgm, els, { x = 60, y = 40, cols = 3, dx = 300, dy = 170 } = {}) {
  return els.map((el, i) => place(dgm, el, x + (i % cols) * dx, y + Math.floor(i / cols) * dy));
}

function column(dgm, els, { x = 1000, y = 40, dy = 170 } = {}) {
  return els.map((el, i) => place(dgm, el, x, y + i * dy));
}

function link(dgm, owner, fromView, toView, label, tech = '') {
  const dep = dependency(owner._id, fromView.__el._id, toView.__el._id, tech ? `${label} [${tech}]` : label);
  owner.ownedElements.push(dep);
  dgm.ownedViews.push(dependencyView(dgm._id, dep, fromView, toView));
  current.links.push({ from: fromView.__el, to: toView.__el, label, tech });
}

// ========================================================== L1 — context ==
const pkgContext = pkg(
  '1 — System Context',
  'Who uses the pipeline and what it depends on. Everything outside the one blue box is ' +
    "somebody else's software.",
);

const author = mk(pkgContext, 'person', 'Demo author', '',
  'Developer or PM. Writes the flow in plain English or as a .demo script, points it at a ' +
  'deployment with a target, and builds the video: one stage at a time from a shell, or every part ' +
  'of a video with one build command. Nothing is delivered until it passes the quality gate and ' +
  'the video-qa review.');
const viewer = mk(pkgContext, 'person', 'Viewer', '',
  'Prospect, customer or internal audience. Watches the finished MP4; never touches the pipeline.');
const system = mk(pkgContext, 'system', 'Demo Video Pipeline', 'Node.js CLI stages',
  'Turns a plain-English flow into a narrated, branded MP4. Drives a real browser, captures ' +
  'frames and input telemetry, then assembles, zooms, composites, narrates, tightens and cards ' +
  'the result. The stages run one at a time by hand, or all of them per video through the build ' +
  'orchestrator; every video is measured by the quality gate before it is called done.');
const appUnderDemo = mk(pkgContext, 'external', 'Web application under demo', 'Any web app',
  'The deployment being recorded — localhost, staging, a customer sandbox, or a third-party app ' +
  'such as claude.ai. Named by a target; may require signing in. Flows run against live data, so ' +
  'the pipeline hovers rather than clicking anything destructive.');
const chrome = mk(pkgContext, 'external', 'Google Chrome', 'Chrome + DevTools Protocol',
  'Driven by puppeteer-core on a dedicated user-data profile — one per target, so a login survives ' +
  'between takes and a video can show two signed-in users without anyone signing in on camera. ' +
  'Frames come from Page.startScreencast. The cursor in the finished video is synthesized from ' +
  'telemetry rather than recorded, so the capture needs no real cursor.');
const ffmpeg = mk(pkgContext, 'external', 'ffmpeg / ffprobe', 'Local CLI',
  'On PATH, or via FFMPEG / FFPROBE. Every encode, decode, probe and audio filter graph. The ' +
  'compositor also pipes raw RGBA through it in both directions, so no intermediate frame hits disk.');
const chromeExt = mk(pkgContext, 'external', 'Claude in Chrome extension', 'Browser extension',
  'Drives the user own Chrome, with their own session, so there is no SSO ritual and no email code ' +
  'to fill. Used before a take to turn the natural-language ask selectors in a script into concrete ' +
  'ones against the live DOM. It cannot record: it has screenshot capture but no screencast, so the ' +
  'take itself stays with the CDP driver.');
const ttsApi = mk(pkgContext, 'external', 'Text-to-speech API', 'ElevenLabs or OpenAI',
  'Chosen by DEMO_TTS, or by whichever key is set. Anthropic has no TTS API, so this is a third ' +
  'party. Keys come from the shell or .env, never a committed file. With Zep, the only network ' +
  'dependencies other than the app under demo.');

const qaAgent = mk(pkgContext, 'external', 'video-qa agent', 'Claude Code subagent',
  'Reviews a finished video: runs the quality gate, then checks every narration line against a ' +
  'still of the screen — is the thing being described on screen while it is said? — and returns ' +
  'PASS or FAIL with the fix for each defect. Read-only. Defined in .claude/agents/video-qa.md.');

const memoryAgent = mk(pkgContext, 'external', 'memory agent', 'Claude Code subagent',
  'Runs at session start when a feature source is stale: lists each online source of an app with its ' +
  'MCP tool, reads what changed, merges its features into the catalog and pushes them to Zep. Read-only on ' +
  'the sources. Defined in .claude/agents/memory.md.');
const featureSource = mk(pkgContext, 'external', 'Online feature sources', 'e.g. a Google Drive folder per app',
  'Where the features of each app are published, located by FEATURE_SOURCE_{APP} in .env. Reachable only ' +
  'as Claude tools (MCP), so the memory agent reads them, never the pipeline.');
const videoDest = mk(pkgContext, 'external', 'Video destination', 'Google Drive API v3 · HTTPS',
  'Where finished videos are published: a Google Drive folder per app, located by PUBLISH_DEST_{APP} ' +
  'in .env. Uploads run as the signed-in user (OAuth refresh token in .env).');
const jiraTickets = mk(pkgContext, 'external', 'Jira', 'Atlassian MCP',
  'The ticket each video is for (the manifest names it). Claude posts the published link there as a ' +
  'comment through the Atlassian MCP tool; the pipeline only records that it was posted.');
const zepCloud = mk(pkgContext, 'external', 'Zep Cloud', '@getzep/zep-cloud · HTTPS',
  'Searchable memory: one graph per app for feature pages, traces and manifests, one for rules and ' +
  'pipeline notes, and a thread per working session. Key in ZEP_API_KEY (.env).');

const dL1 = diagram(pkgContext, 'c4-l1-context', 'C4-L1 — System Context',
  'Level 1. The pipeline as one box, with the people who use it and the systems it depends on.');
{
  const vAuthor = place(dL1, author, 60, 60);
  const vSystem = place(dL1, system, 420, 240, 260, 110);
  const vViewer = place(dL1, viewer, 800, 60);
  const vChrome = place(dL1, chrome, 60, 460);
  const vApp = place(dL1, appUnderDemo, 60, 620);
  const vFfmpeg = place(dL1, ffmpeg, 440, 460);
  const vTts = place(dL1, ttsApi, 800, 460);
  const vExt = place(dL1, chromeExt, 800, 620);
  const vQaAgent = place(dL1, qaAgent, 440, 620);
  const vMemoryAgent = place(dL1, memoryAgent, 1160, 240);
  const vSources = place(dL1, featureSource, 1160, 460);
  const vZep = place(dL1, zepCloud, 1160, 60);
  const vDest = place(dL1, videoDest, 1160, 620);
  const vJira = place(dL1, jiraTickets, 800, 780);

  link(dL1, pkgContext, vAuthor, vSystem, 'Writes flows and runs the stages', 'CLI');
  link(dL1, pkgContext, vSystem, vExt, 'Resolves natural-language selectors before a take via');
  link(dL1, pkgContext, vExt, vApp, 'Inspects the live DOM of', 'user session');
  link(dL1, pkgContext, vSystem, vViewer, 'Delivers the finished MP4 to');
  link(dL1, pkgContext, vSystem, vChrome, 'Launches and drives', 'CDP');
  link(dL1, pkgContext, vChrome, vApp, 'Loads and interacts with', 'HTTP');
  link(dL1, pkgContext, vSystem, vFfmpeg, 'Encodes, decodes and filters via', 'child process');
  link(dL1, pkgContext, vSystem, vTts, 'Renders speech via', 'HTTPS');
  link(dL1, pkgContext, vQaAgent, vSystem, 'Reviews every video built by');
  link(dL1, pkgContext, vSystem, vZep, 'Stores feature catalogs, pages, traces and session threads in', 'HTTPS');
  link(dL1, pkgContext, vSystem, vDest, 'Publishes approved videos to', 'HTTPS');
  link(dL1, pkgContext, vAuthor, vJira, 'Posts the published link on the ticket (through Claude)', 'MCP');
  link(dL1, pkgContext, vMemoryAgent, vSources, 'Reads new and changed feature files from', 'MCP');
  link(dL1, pkgContext, vMemoryAgent, vSystem, 'Merges features and syncs memory via', 'CLI');
  link(dL1, pkgContext, vSystem, vMemoryAgent, 'Asks for a sync at session start when a source is stale');
}

// ======================================================= L2 — containers ==
const pkgContainers = pkg(
  '2 — Containers',
  'Inside the pipeline. Every stage is a separately-invoked Node CLI; the stages never call each ' +
    'other — they hand work over through the work directory. The numbers are the order they run ' +
    'in. The build orchestrator is the one thing that runs them: per part of a video, as child ' +
    'processes, before it joins the parts. There are deliberately no arrows between stages, because ' +
    'there are no calls between them.',
);

// Numbered 0 because it runs before the pipeline proper and is optional: a
// .demo can be hand-written. Renumbering 1-8 to make room would churn every
// other name for no gain.
const cAuthor = mk(pkgContainers, 'container', '0 · Author', 'author.mjs · Node.js',
  'Turns an observed walk of the app into the DSL. Reads a trace — the selectors found and the ' +
  'wait times measured — and emits the .demo and its selector sidecar together. Sizes the narration ' +
  'to each measured wait, reports any line that will not fit, and proposes a SPEEDS_MS range for ' +
  'whatever narration cannot cover. With --check it re-authors every trace in memory and fails while a ' +
  'committed script differs (pre-commit and CI). Optional: a .demo can be written by hand.');
const cScript = mk(pkgContainers, 'container', '1 · Script Compiler', 'script.mjs · Node.js',
  'Compiles a .demo flow into a normal, inspectable scenario module. Refuses to clobber a ' +
  'hand-written scenario. driver.mjs also calls it on the way in.');
const cDriver = mk(pkgContainers, 'container', '2 · Driver', 'driver.mjs · Node.js + puppeteer-core',
  'Launches Chrome, signs in if the target says to, runs the flow, and records a screencast plus ' +
  'cursor, click and narration-cue telemetry, plus the real start and end of every wait. Per ' +
  'target it records from its own Chrome profile, keeps chat widgets from loading and hides app ' +
  'banners. Closes Chrome cleanly so cookies flush.');
const cAssemble = mk(pkgContainers, 'container', '3 · Assembler', 'assemble.mjs · Node.js + ffmpeg',
  'Turns frames into raw.mp4 / cut.mp4. Applies CUTS_MS (drop) and SPEEDS_MS (keep, play fast) and ' +
  'puts the cursor and narration telemetry through the same shift, so nothing desyncs. With ' +
  'AUTO_SPEED it fast-forwards every logged wait nobody is talking over. Prints the largest ' +
  'inter-frame gaps.');
const cProject = mk(pkgContainers, 'container', '4 · Zoom Projector', 'project.mjs · Node.js',
  'Clusters clicks less than 2.5s apart into zoom regions, each carrying a focusTrack the ' +
  'compositor pans across, and writes {take}.recordly.');
const cCompose = mk(pkgContainers, 'container', '5 · Compositor', 'compose.mjs · Node.js + canvas + ffmpeg',
  'Renders every frame: eased zoom/pan, a synthesized cursor with click ripples, and a styled ' +
  'window frame. Frames stream through ffmpeg both ways; nothing hits disk.');
const cNarrate = mk(pkgContainers, 'container', '6 · Narrator', 'narrate.mjs · Node.js + ffmpeg',
  'Voices the say-cues, trims the breath off each clip, levels every clip to a common loudness, and ' +
  'mixes them onto the video. Extends the video by holding the last frame if a closing line ' +
  'overruns it.');
const cTighten = mk(pkgContainers, 'container', '7 · Tightener', 'tighten.mjs · Node.js + ffmpeg',
  'Compresses stretches that are frozen AND silent, trims the trailing run, and crossfades every ' +
  'seam. Runs after narrate because silence is only meaningful once the voice is on the timeline. ' +
  'Refuses to write if a seam lands on speech or a zoom. Always writes its output, even with ' +
  'nothing to cut, so the next stage can never pick up an earlier take.');
const cCards = mk(pkgContainers, 'container', '8 · Card Renderer', 'cards.mjs · Node.js + canvas + ffmpeg',
  'Renders branded intro/outro title cards, voices them with the same provider, and dissolves them ' +
  'on with the concat filter rather than the demuxer.');

const dFlows = mk(pkgContainers, 'store', 'Flow definitions', 'input/ + scenarios/ authored, scripts/ generated',
  'What happens on screen and what is said over it. Split by who writes it: input/ holds the ' +
  'plain-English .flow and scenarios/ the .trace.json observed from walking it, both authored and ' +
  'worth reviewing; scripts/ holds the .demo the trace generates, plus its selector sidecar, either of ' +
  'which can be deleted and rebuilt. Committed; contains no credentials.');
const dTargets = mk(pkgContainers, 'store', 'Targets & secrets', 'targets/*.json, *.local.json, .env',
  'Which deployment, and how to sign in. The .json is committed and holds no secrets; the ' +
  '.local.json and .env are gitignored. Any value may be written env:VAR_NAME and is read from the ' +
  'environment at load time. A target can also name its own Chrome profile, URLs to block, ' +
  'selectors to hide, and secrets that fill {name} placeholders in an open path.');
const dTraces = mk(pkgContainers, 'store', 'Observed traces', 'scenarios/*.trace.json',
  'What the app actually did on a real walk: the selector each step needs, the evidence for it, and ' +
  'how long every wait took. Authored, not generated — it is the only artifact here that cannot be ' +
  'rebuilt from something else, which is why it lives in scenarios/ rather than the gitignored out/. ' +
  'Also carries hazards the DSL cannot yet express, which the author writes into the script header.');
const dResolved = mk(pkgContainers, 'store', 'Selector resolutions', 'scripts/*.selectors.json',
  'What each ask description resolved to against the live DOM, plus the evidence for it. Kept ' +
  'beside the script rather than inside it, so the .demo keeps saying what you meant while the ' +
  'machine-found selector stays reviewable on its own. Keyed by intent text, so renaming a selector ' +
  'or reordering the block does not orphan a resolution.');
const dBrand = mk(pkgContainers, 'store', 'Brand assets', 'brand/',
  'StyleGuide.txt (colour and type, the source of truth), the logo, and the font files. One ' +
  'directory is the brand; there is no flag to point elsewhere.');
const dWork = mk(pkgContainers, 'store', 'Work directory', 'out/ · out/{video}/{part}/',
  'One folder per take: out/ by default, or out/{video}/{part}/ when the build orchestrator sets ' +
  'DEMO_OUT, so takes never overwrite each other. Holds frames/, frames.json, actions.json, the ' +
  'per-take cursor.json and narration.json, {take}.recordly, the MP4 at each stage (raw, cut, final, ' +
  'final-narrated, -tight, -carded) and the quality gate report with its stills. The hand-off ' +
  'between every stage.');
const dTts = mk(pkgContainers, 'store', 'TTS clip cache', 'out/tts/ · mp3',
  'One mp3 per line, keyed by provider+voice+text, plus the derived .lead.mp3 with the opening ' +
  'breath trimmed. Re-cutting or re-composing re-bills nothing; only changed lines re-render. ' +
  'Shared by every take folder.');

const cQa = mk(pkgContainers, 'container', '9 · Quality Gate', 'qa.mjs · Node.js + ffmpeg',
  'Measures what a viewer notices and a stage only warns about: two narration lines at once, a ' +
  'line off its cue, dead air, a frozen or loading screen, black frames, mismatched streams, ' +
  'loudness, and a deliverable built from a previous take. Writes a report and a still per line ' +
  'and per flagged range, and exits 1 on any failure.');
const cBuild = mk(pkgContainers, 'container', 'Build Orchestrator', 'build.mjs · Node.js + ffmpeg',
  'Builds a whole video from its manifest: records and renders every part into its own folder, ' +
  'gates each on the quality gate, trims the silence at each join by measurement, crossfades the ' +
  'parts and gates the result. Stops at the first failed gate.');
const dManifests = mk(pkgContainers, 'store', 'Video manifests', 'videos/*.json',
  'One per finished video: its parts in recording order with what must be true before each take, ' +
  'the settings every stage runs with, and how the parts join. Committed.');
const cPublish = mk(pkgContainers, 'container', 'Publisher', 'publish.mjs · Node.js + Google Drive API',
  'Publishes a finished video after final approval: only a video whose state is done, and only with ' +
  '--approved. Uploads it to the app destination (a new revision when it was published before, so the ' +
  'link stays), records the publication in the video state and prints the Jira comment for Claude to post.');
const cMemory = mk(pkgContainers, 'container', 'Memory', 'memory.mjs · Node.js + @getzep/zep-cloud',
  'Bookkeeping for project memory: finds the source of each app from .env, diffs a remote listing against ' +
  'the sync lock next to the catalog (files older than the catalog are its baseline), merges new features into ' +
  'the catalog, reports stale sources (SessionStart hook and build.mjs), and pushes changed catalog ' +
  'features, pages, traces and manifests to Zep.');
const dMemory = mk(pkgContainers, 'store', 'Project memory', 'memory/ · committed',
  'rules.md (imported by CLAUDE.md), features/{app}/data/features.json (the feature catalog, the initial set), ' +
  'features/{app}/*.md (one page per filmed feature, naming its videos), sources.json (generic: kinds ' +
  'of source; locations are in .env). A private app folder is gitignored.');
const dProfiles = mk(pkgContainers, 'store', 'Browser profiles', 'profile/, profile-*/ · gitignored',
  'Chrome user-data directories holding signed-in sessions, one per target that needs its own ' +
  'user. Signed in by hand once; a take never signs out. Sensitive: whoever has the folder has ' +
  'the session.');

const dL2 = diagram(pkgContainers, 'c4-l2-containers', 'C4-L2 — Containers',
  'Level 2. The stages inside the pipeline and the files they hand work over through.',
  { macro: 'System_Boundary', name: 'Demo Video Pipeline' });
{
  const vAuthor = place(dL2, author, 60, 40);
  const vChrome = place(dL2, chrome, 1000, 40);
  const vApp = place(dL2, appUnderDemo, 1280, 40);

  const v0 = place(dL2, cAuthor, 60, 120);
  const vTraces = place(dL2, dTraces, 1560, 380);
  const v1 = place(dL2, cScript, 60, 200);
  const v2 = place(dL2, cDriver, 340, 200);
  const v3 = place(dL2, cAssemble, 60, 360);
  const v4 = place(dL2, cProject, 340, 360);
  const v5 = place(dL2, cCompose, 620, 360);
  const v6 = place(dL2, cNarrate, 60, 520);
  const v7 = place(dL2, cTighten, 340, 520);
  const v8 = place(dL2, cCards, 620, 520);

  const vFlows = place(dL2, dFlows, 1000, 200);
  const vTargets = place(dL2, dTargets, 1280, 200);
  const vBrand = place(dL2, dBrand, 1000, 360);
  const vWork = place(dL2, dWork, 1280, 380, 220, 200);
  const vTtsCache = place(dL2, dTts, 1000, 520);
  const vResolved = place(dL2, dResolved, 1560, 200);
  const vExt = place(dL2, chromeExt, 1560, 40);

  const vFfmpeg = place(dL2, ffmpeg, 340, 700);
  const vTts = place(dL2, ttsApi, 1000, 700);

  const v9 = place(dL2, cQa, 620, 700);
  const vBuild = place(dL2, cBuild, 620, 200);
  const vManifests = place(dL2, dManifests, 1560, 560);
  const vProfiles = place(dL2, dProfiles, 1560, 720);
  const vQaAgent = place(dL2, qaAgent, 60, 860);
  const vMemory = place(dL2, cMemory, 340, 860);
  const vMemoryStore = place(dL2, dMemory, 620, 860);
  const vMemoryAgent = place(dL2, memoryAgent, 1000, 860);
  const vFeatureSource = place(dL2, featureSource, 1280, 860);
  const vZep = place(dL2, zepCloud, 1560, 860);
  const vPublish = place(dL2, cPublish, 340, 1020);
  const vDest2 = place(dL2, videoDest, 1000, 1020);
  const vJira2 = place(dL2, jiraTickets, 1280, 1020);

  link(dL2, pkgContainers, vAuthor, vFlows, 'Writes the flow');
  link(dL2, pkgContainers, vAuthor, vTargets, 'Sets the deployment and credentials');

  link(dL2, pkgContainers, vAuthor, v0, 'Runs once to generate the script', 'CLI');
  link(dL2, pkgContainers, vExt, vTraces, 'Writes what it observed and measured');
  link(dL2, pkgContainers, v0, vTraces, 'Reads the trace');
  link(dL2, pkgContainers, v0, vFlows, 'Emits the .demo');
  link(dL2, pkgContainers, v0, vResolved, 'Emits the sidecar, from the same trace');

  link(dL2, pkgContainers, v1, vFlows, 'Compiles .demo, writes the scenario');
  link(dL2, pkgContainers, v1, vResolved, 'Swaps each ask intent for its resolution');
  link(dL2, pkgContainers, vExt, vResolved, 'Writes what it found');
  link(dL2, pkgContainers, vExt, vFlows, 'Reads the ask intents');
  link(dL2, pkgContainers, vExt, vApp, 'Inspects the live DOM of', 'user session');
  link(dL2, pkgContainers, v2, v1, 'Compiles a .demo on the way in', 'import');
  link(dL2, pkgContainers, v2, vFlows, 'Loads the scenario');
  link(dL2, pkgContainers, v2, vTargets, 'Resolves app URL and credentials');
  link(dL2, pkgContainers, v2, vChrome, 'Launches and drives', 'CDP');
  link(dL2, pkgContainers, vChrome, vApp, 'Loads and interacts with', 'HTTP');
  link(dL2, pkgContainers, v2, vWork, 'Writes frames + telemetry');

  link(dL2, pkgContainers, v3, vWork, 'Frames to MP4; shifts telemetry');
  link(dL2, pkgContainers, v4, vWork, 'Clicks to zoom regions');
  link(dL2, pkgContainers, v5, vWork, 'Take + project to final.mp4');
  link(dL2, pkgContainers, v5, vBrand, 'Reads colours');

  link(dL2, pkgContainers, v6, vWork, 'Muxes narration onto the video');
  link(dL2, pkgContainers, v6, vTtsCache, 'Caches clips');
  link(dL2, pkgContainers, v6, vTts, 'Renders speech', 'HTTPS');

  link(dL2, pkgContainers, v7, vWork, 'Removes frozen + silent stretches');

  link(dL2, pkgContainers, v8, vWork, 'Joins intro/outro cards');
  link(dL2, pkgContainers, v8, vBrand, 'Reads logo, colours, fonts');
  link(dL2, pkgContainers, v8, vTtsCache, 'Caches card voice');
  link(dL2, pkgContainers, v8, vTts, 'Renders card voice', 'HTTPS');

  for (const v of [v3, v5, v6, v7, v8, v9]) link(dL2, pkgContainers, v, vFfmpeg, 'Runs', 'child process');

  link(dL2, pkgContainers, v2, vProfiles, "Records from the target's signed-in profile");
  link(dL2, pkgContainers, vAuthor, vProfiles, 'Signs in once by hand');
  link(dL2, pkgContainers, v3, vTtsCache, 'Reads line lengths for auto-speed');

  link(dL2, pkgContainers, v9, vWork, 'Measures the stage outputs; writes the report and stills');
  link(dL2, pkgContainers, v9, vTtsCache, 'Reads line lengths');
  link(dL2, pkgContainers, vQaAgent, v9, 'Runs, then reviews the stills');

  link(dL2, pkgContainers, vAuthor, vBuild, 'Runs one build per video', 'CLI');
  link(dL2, pkgContainers, vAuthor, vManifests, 'Writes the manifest');
  link(dL2, pkgContainers, vBuild, vManifests, 'Reads');
  for (const v of [v2, v3, v4, v5, v6, v7, v8, v9]) {
    link(dL2, pkgContainers, vBuild, v, 'Runs per part', 'child process');
  }
  link(dL2, pkgContainers, vBuild, vWork, 'Gives each part its own folder; writes the joined MP4');
  link(dL2, pkgContainers, vBuild, vFfmpeg, 'Measures and joins via', 'child process');

  link(dL2, pkgContainers, vMemoryAgent, vFeatureSource, 'Lists and reads', 'MCP');
  link(dL2, pkgContainers, vMemoryAgent, vMemoryStore, 'Writes the feature pages');
  link(dL2, pkgContainers, vMemoryAgent, vMemory, 'Runs diff, mark, synced, zep push', 'CLI');
  link(dL2, pkgContainers, vMemory, vMemoryStore, 'Reads sources; writes the lock');
  link(dL2, pkgContainers, vMemory, vZep, 'Pushes documents, sessions; searches', 'HTTPS');
  link(dL2, pkgContainers, vMemory, vTraces, 'Pushes traces');
  link(dL2, pkgContainers, vMemory, vManifests, 'Pushes manifests');
  link(dL2, pkgContainers, vBuild, vMemory, 'Warns on stale sources', 'import');
  link(dL2, pkgContainers, vAuthor, vPublish, 'Approves and runs after the visual review', 'CLI');
  link(dL2, pkgContainers, vPublish, vWork, 'Reads the finished MP4');
  link(dL2, pkgContainers, vPublish, vDest2, 'Uploads the video to', 'HTTPS');
  link(dL2, pkgContainers, vPublish, vMemory, 'Records the publication via', 'import');
  link(dL2, pkgContainers, vAuthor, vJira2, 'Posts the link on the ticket (through Claude)', 'MCP');
}

// ========================================== L3 · 0 — components: author ==
const pkgAuthor = pkg(
  '3.0 — Components · Author',
  'Inside author.mjs. Everything here is transcription except the budgeter, and the budgeter is the ' +
    'reason this is code rather than a prompt: it is what stops a hold being a guess.',
);

const aTrace = mk(pkgAuthor, 'component', 'Trace reader', 'author.mjs',
  'Loads the trace and refuses one without a beats array. Everything downstream is derived from this ' +
  'single file, which is what makes the .demo and the sidecar agree by construction rather than by care.');
const aRate = mk(pkgAuthor, 'component', 'Speech-rate model', 'author.mjs · CHARS_PER_SEC',
  'How long a line takes to say, at 12.5 characters per second. The first value, 15.5, was derived by ' +
  'dividing text length by the gap between cues — which silently included the pause after each line, ' +
  'so it ran fast and under-estimated every clip. Back-solved from three real overlap warnings the ' +
  'true rate is 12.0-13.7; the constant sits at the slow end deliberately, because over-estimating ' +
  'costs one fewer line while under-estimating makes two lines talk over each other.');
const aBudget = mk(pkgAuthor, 'component', 'Narration budgeter', 'author.mjs · budget()',
  'Fits as many lines as the measured wait allows, spacing them so none overlaps the next, and stops ' +
  'at a ceiling because wall-to-wall talking over a 40s wait reads worse than a visible fast-forward. ' +
  'Lines that do not fit are returned as unused rather than dropped in silence, and an uncovered ' +
  'stretch over six seconds becomes a SPEEDS_MS range.');
const aRegistry = mk(pkgAuthor, 'component', 'Selector registry', 'author.mjs · ref()',
  'Runs once per step that touches an element and feeds both outputs from that one call: the name and ' +
  'intent go to the .demo selectors block, the spec and evidence to the sidecar. Neither file is ' +
  'written independently, so they cannot drift apart. A step names an element defined once in the ' +
  "trace's selectors table, and a name the table lacks is an error, not a guess.");
const aEmit = mk(pkgAuthor, 'component', 'Step emitter', 'author.mjs · emitOne()',
  'One DSL line per trace step: say, hold, wait, type, press, click, hover, park. A waitGone pulls in the ' +
  'budgeter and labels the number measured or ESTIMATED, because a figure a reader trusts as measured ' +
  'when it was guessed is worse than no figure. An ifAppears becomes a short-timeout guard for UI ' +
  'that only shows up sometimes.');
const aHeader = mk(pkgAuthor, 'component', 'Header writer', 'author.mjs',
  'Writes the provenance line, any hazards the walk recorded, and the ready-to-paste SPEEDS_MS command. ' +
  'Hazards go in the file rather than a chat log because that is where the next person will look.');
const aProv = mk(pkgAuthor, 'component', 'Provenance stamper', 'author.mjs',
  'Takes resolvedBy and the note from the trace instead of stamping them on. It used to hardcode ' +
  'claude-in-chrome, so a hand-authored trace produced a sidecar claiming it had been resolved live — ' +
  'the one lie that makes every other entry in the file untrustworthy.');
const aWrite = mk(pkgAuthor, 'component', 'Writer', 'author.mjs',
  'Writes the .demo and derives the sidecar path by swapping the extension — the same rule script.mjs ' +
  'uses to find it, which is why the two must sit together. Unused lines and SPEEDS_MS candidates are ' +
  'printed as notes for the person running it. --check compares instead of writing: a missing, stale or ' +
  'orphaned generated script fails, line endings ignored.');

const dL3author = diagram(pkgAuthor, 'c4-l3-author',
  'C4-L3 — Components · Author (author.mjs)',
  'Level 3, container "0 · Author".',
  { macro: 'Container_Boundary', name: '0 · Author' });
{
  const [vTr, vRate, vBud, vReg, vEm, vHd, vPr, vWr] = grid(dL3author,
    [aTrace, aRate, aBudget, aRegistry, aEmit, aHeader, aProv, aWrite], { cols: 3 });
  const [vTraces, vFlows, vResolved, vExt] =
    column(dL3author, [dTraces, dFlows, dResolved, chromeExt], { dy: 150 });

  link(dL3author, pkgAuthor, vExt, vTraces, 'Observed and measured it');
  link(dL3author, pkgAuthor, vTr, vTraces, 'Reads');
  link(dL3author, pkgAuthor, vTr, vEm, 'Beats and steps to');
  link(dL3author, pkgAuthor, vTr, vHd, 'Warnings and provenance to');
  link(dL3author, pkgAuthor, vTr, vPr, 'resolvedBy and note to');
  link(dL3author, pkgAuthor, vRate, vBud, 'Line duration to');
  link(dL3author, pkgAuthor, vEm, vBud, 'Measured wait and candidate lines to');
  link(dL3author, pkgAuthor, vBud, vHd, 'SPEEDS_MS ranges to');
  link(dL3author, pkgAuthor, vEm, vReg, 'Each element step to');
  link(dL3author, pkgAuthor, vReg, vWr, 'Intents and specs to');
  link(dL3author, pkgAuthor, vEm, vWr, 'Beat lines to');
  link(dL3author, pkgAuthor, vHd, vWr, 'Header to');
  link(dL3author, pkgAuthor, vPr, vWr, 'Provenance to');
  link(dL3author, pkgAuthor, vWr, vFlows, 'Writes the .demo');
  link(dL3author, pkgAuthor, vWr, vResolved, 'Writes the sidecar');
}

// ==================================== L3 · 1 — components: script compiler ==
const pkgScript = pkg(
  '3.1 — Components · Script Compiler',
  'Inside script.mjs. A script compiles to an ordinary scenario module rather than being ' +
    'interpreted, so the output stays readable and a flow can be taken over by hand at any point.',
);

const sLexer = mk(pkgScript, 'component', 'Lexer', 'script.mjs',
  'One command per line. Strips comments, parses durations such as 2s and 1500ms, splits a ' +
  'trailing within-timeout off a command, and unquotes strings.');
const sSpec = mk(pkgScript, 'component', 'Selector spec parser', 'script.mjs',
  'Turns the button, text and css forms of a selector line into the driver spec strings. A bare ' +
  'value takes the block default, which is why a CSS id needs the css prefix.');
const sRegistry = mk(pkgScript, 'component', 'SEL registry', 'script.mjs',
  'Names in the selectors block become slugged keys on the exported SEL map, deduped so two ' +
  'similar labels cannot quietly collide on one key.');
const sHeader = mk(pkgScript, 'component', 'Header parser', 'script.mjs',
  'target, app, viewport, match, intro, outro and brand. An unknown directive is an error naming ' +
  'the file and line, not a silently ignored line.');
const sBeats = mk(pkgScript, 'component', 'Beat parser', 'script.mjs',
  'Beats of wait, click, hover, park, hold, type, press, scroll, open, login, logout, say and ' +
  'if-appears, each becoming one step in order.');
const sCodegen = mk(pkgScript, 'component', 'Code generator', 'script.mjs',
  'Emits a scenario module: the SEL map, run(d), and the header exports. Ordinary readable ' +
  'JavaScript, so the generated file is inspectable and hand-editable rather than a black box.');
const sAsk = mk(pkgScript, 'component', 'Ask resolver', 'script.mjs · selectors sidecar',
  'An ask selector parses to a sentinel spec that travels through the registry as an ordinary ' +
  'string, then gets swapped here for what the sidecar resolved it to. Anything left unresolved is ' +
  'a compile error, never a guess: a guessed selector does not fail here, it fails mid-take with ' +
  'the browser up and the recording started, which is the expensive place to fail.');
const sGuard = mk(pkgScript, 'component', 'Overwrite guard', 'script.mjs · generated marker',
  'Refuses to overwrite a scenario it did not generate; a marker in the header is what tells them ' +
  'apart. Use -o to write elsewhere.');

const dL3script = diagram(pkgScript, 'c4-l3-script-compiler',
  'C4-L3 — Components · Script Compiler (script.mjs)',
  'Level 3, container "1 · Script Compiler".',
  { macro: 'Container_Boundary', name: '1 · Script Compiler' });
{
  const [vLex, vSpec, vReg, vHead, vBeats, vAsk, vGen, vGuard] = grid(dL3script,
    [sLexer, sSpec, sRegistry, sHeader, sBeats, sAsk, sCodegen, sGuard], { cols: 3 });
  const [vAuthor, vFlows, vResolved, vExt] =
    column(dL3script, [author, dFlows, dResolved, chromeExt], { dy: 160 });

  link(dL3script, pkgScript, vSpec, vAsk, 'ask sentinels to');
  link(dL3script, pkgScript, vAsk, vResolved, 'Reads the resolution for each intent');
  link(dL3script, pkgScript, vExt, vResolved, 'Resolved it against the live app');
  link(dL3script, pkgScript, vAsk, vGen, 'Concrete selectors to');

  link(dL3script, pkgScript, vAuthor, vLex, 'Runs, or driver.mjs does', 'CLI');
  link(dL3script, pkgScript, vLex, vFlows, 'Reads the .demo');
  link(dL3script, pkgScript, vLex, vHead, 'Header lines to');
  link(dL3script, pkgScript, vLex, vSpec, 'Selector lines to');
  link(dL3script, pkgScript, vLex, vBeats, 'Beat lines to');
  link(dL3script, pkgScript, vSpec, vReg, 'Registers each spec in');
  link(dL3script, pkgScript, vReg, vBeats, 'Resolves at-name references for');
  link(dL3script, pkgScript, vHead, vGen, 'Header exports to');
  link(dL3script, pkgScript, vBeats, vGen, 'Step list to');
  link(dL3script, pkgScript, vGen, vGuard, 'Scenario source to');
  link(dL3script, pkgScript, vGuard, vFlows, 'Writes the scenario');
}

// ============================================== L3 · 2 — components: driver ==
const pkgDriver = pkg(
  '3.2 — Components · Driver',
  'Inside driver.mjs. Two of these are shared modules the other stages import as well; they are ' +
    'drawn here because this is where they are first used.',
);

const kInput = mk(pkgDriver, 'component', 'Input resolver', 'driver.mjs',
  'Reads argv. Anything not ending .mjs/.js is treated as a script and compiled; a target comes ' +
  'from --target, DEMO_TARGET, or a TARGET export on the scenario.');
const kScriptLib = mk(pkgDriver, 'component', 'Script compiler', 'script.mjs · shared',
  'Parses the .demo grammar — header directives, a selectors block, then beats — and emits a ' +
  'scenario module. The generated file is inspectable and hand-editable, so the script is a ' +
  'starting point rather than a black box.');
const kTargetLib = mk(pkgDriver, 'component', 'Target loader', 'target.mjs · shared',
  'Deep-merges the target JSON, its .local.json sidecar, .env and the DEMO_* env vars, later ' +
  'winning, and resolves env:VAR_NAME values at load time. The one place credentials are allowed ' +
  'to appear.');
const kLauncher = mk(pkgDriver, 'component', 'Chrome launcher', 'puppeteer-core',
  "Runs a real Chrome on the target's profile (profile/ unless the target names another), pinned " +
  'to --force-device-scale-factor=1 so display ' +
  'scaling cannot change the frame size. On macOS keeps --use-mock-keychain so profile cookies decrypt.');
const kAuth = mk(pkgDriver, 'component', 'Sign-in step', 'driver.mjs',
  "Fills the target's auth.selectors and waits the app out. auth.start decides whether the take " +
  'opens signed-out, with the login part of the demo, or signed-in, with the login happening ' +
  'off-camera before capture starts.');
const kPrimitives = mk(pkgDriver, 'component', 'Flow primitives', 'driver.mjs · d.*',
  'hold, waitSel, waitGone, appears, hoverSel, clickSel, type, key, wheel, open, race, login, ' +
  'logout. d.type verifies the click actually focused the element and refuses to type into the ' +
  'wrong one rather than sending text to whatever has focus. Click and hover scroll an off-screen ' +
  "element into view first; open fills {name} placeholders from the target's secrets.");
const kScreencast = mk(pkgDriver, 'component', 'Screencast recorder', 'CDP Page.startScreencast',
  'Acks every frame and writes out/frames/*.jpg plus frames.json. Gated on the take, so an ' +
  'off-camera sign-in never reaches the video.');
const kTelemetry = mk(pkgDriver, 'component', 'Input telemetry recorder', 'driver.mjs',
  'Samples synthesized pointer moves and clicks into actions.json. The cursor in the finished video ' +
  'is drawn from this, which is why the capture needs no real cursor. It also keeps the box of the ' +
  'visible part (hit-tested, so an element under a side panel is cut at its edge) of the element ' +
  'each hover, click and type acted on, with when it was the subject, for the red frame.');
const kCues = mk(pkgDriver, 'component', 'Narration cue collector', 'driver.mjs · d.say()',
  'Stamps { t, text } at wall-clock time and returns immediately — the voice plays over the visuals ' +
  'instead of the flow pausing for it. Cue times are recorded during the take precisely because ' +
  'beat length varies per run.');
const kTeardown = mk(pkgDriver, 'component', 'Teardown', 'driver.mjs',
  'Stops the screencast, writes frames.json and actions.json, and closes Chrome by its window ' +
  'rather than killing it, so unflushed session state is not lost.');

const kConditioner = mk(pkgDriver, 'component', 'Page conditioner', 'CDP Network.setBlockedURLs + injected CSS',
  "Applies the target to the page before the take: blockUrls keeps third-party widgets such as a " +
  'chat bubble from loading, and hideSelectors hides app banners on this page and every page ' +
  'loaded after it.');
const kWaits = mk(pkgDriver, 'component', 'Wait logger', 'driver.mjs · timed()',
  'Times every open, wait and wait-gone the flow makes, keeping { start, end, kind, spec }. ' +
  'Written to actions.json for the assembler to fast-forward the long ones.');

const dL3a = diagram(pkgDriver, 'c4-l3-driver', 'C4-L3 — Components · Driver (driver.mjs)',
  'Level 3, container "2 · Driver".',
  { macro: 'Container_Boundary', name: '2 · Driver' });
{
  const vAuthor = place(dL3a, author, 60, 40);
  const vInput = place(dL3a, kInput, 380, 40);
  const vScriptLib = place(dL3a, kScriptLib, 700, 40);
  const vTargetLib = place(dL3a, kTargetLib, 1020, 40);

  const vLauncher = place(dL3a, kLauncher, 380, 200);
  const vAuth = place(dL3a, kAuth, 700, 200);
  const vPrim = place(dL3a, kPrimitives, 380, 360);

  const vScreen = place(dL3a, kScreencast, 700, 360);
  const vTele = place(dL3a, kTelemetry, 700, 500);
  const vCues = place(dL3a, kCues, 700, 640);
  const vTeardown = place(dL3a, kTeardown, 380, 640);

  const vChrome = place(dL3a, chrome, 60, 360);
  const vFlows = place(dL3a, dFlows, 1020, 200);
  const vTargets = place(dL3a, dTargets, 1020, 340);
  const vWork = place(dL3a, dWork, 1020, 500, 220, 180);
  const vCond = place(dL3a, kConditioner, 60, 200);
  const vWaits = place(dL3a, kWaits, 380, 500);
  const vProfiles = place(dL3a, dProfiles, 1020, 720);

  link(dL3a, pkgDriver, vAuthor, vInput, 'Runs', 'CLI');
  link(dL3a, pkgDriver, vInput, vScriptLib, 'Compiles a .demo via');
  link(dL3a, pkgDriver, vInput, vTargetLib, 'Resolves the target via');
  link(dL3a, pkgDriver, vScriptLib, vFlows, 'Reads and writes');
  link(dL3a, pkgDriver, vTargetLib, vTargets, 'Reads');
  link(dL3a, pkgDriver, vInput, vLauncher, 'Hands the resolved flow to');
  link(dL3a, pkgDriver, vLauncher, vChrome, 'Launches', 'CDP');
  link(dL3a, pkgDriver, vLauncher, vAuth, 'Signs in first when the target says to');
  link(dL3a, pkgDriver, vAuth, vTargetLib, 'Reads selectors and credentials from');
  link(dL3a, pkgDriver, vLauncher, vPrim, 'Then runs the flow through');
  link(dL3a, pkgDriver, vPrim, vChrome, 'Drives the page', 'CDP');
  link(dL3a, pkgDriver, vPrim, vCues, 'say() stamps a cue in');
  link(dL3a, pkgDriver, vPrim, vTele, 'Every move and click samples into');
  link(dL3a, pkgDriver, vScreen, vChrome, 'Receives frames from', 'CDP');
  link(dL3a, pkgDriver, vScreen, vWork, 'Writes frames');
  link(dL3a, pkgDriver, vTeardown, vTele, 'Serialises');
  link(dL3a, pkgDriver, vTeardown, vCues, 'Serialises');
  link(dL3a, pkgDriver, vTeardown, vWork, 'Writes actions.json + frames.json');
  link(dL3a, pkgDriver, vLauncher, vProfiles, "Runs Chrome on the target's");
  link(dL3a, pkgDriver, vLauncher, vCond, 'Conditions the page via');
  link(dL3a, pkgDriver, vCond, vTargetLib, 'Reads blockUrls and hideSelectors from');
  link(dL3a, pkgDriver, vCond, vChrome, 'Blocks URLs and injects CSS', 'CDP');
  link(dL3a, pkgDriver, vPrim, vWaits, 'Every open and wait is timed by');
  link(dL3a, pkgDriver, vTeardown, vWaits, 'Serialises');
}

// =========================================== L3 · 3 — components: assembler ==
const pkgAssemble = pkg(
  '3.3 — Components · Assembler',
  'Inside assemble.mjs. The whole stage exists around one idea: there is exactly one function ' +
    'that moves a timestamp, and frames, cursor telemetry and narration cues all go through it.',
);

const aConfig = mk(pkgAssemble, 'component', 'Cut and speed config', 'CUTS_MS, SPEEDS_MS · env',
  'Two ways to shorten a take: a cut drops the frames, a speed keeps them and plays them fast. ' +
  'Reach for a speed first — a cut across an answer being written lands the viewer on a finished ' +
  'table having never seen it arrive. A reversed range, a factor at or below 1, or a cut ' +
  'overlapping a speed is rejected, because both cannot apply.');
const aWarp = mk(pkgAssemble, 'component', 'Time warp', 'assemble.mjs',
  'The single function that moves a timestamp. Ranges are applied partially when a timestamp ' +
  'falls inside one, which keeps a sped-up span in sync with itself rather than only at its far ' +
  'edge. No other stage does its own; that is what stops the picture and the voice drifting apart.');
const aFrames = mk(pkgAssemble, 'component', 'Frame selector', 'assemble.mjs',
  'Drops frames stamped earlier than the frame before them (they would push the picture behind ' +
  'the voice), drops frames inside a cut and rewrites the timestamp of the rest. Fewer than ten survivors is ' +
  'an error naming the cut rather than a two-frame video.');
const aGaps = mk(pkgAssemble, 'component', 'Gap reporter', 'assemble.mjs',
  'Prints the five largest inter-frame gaps over a second. Those are exactly where the video ' +
  'freezes, so they are the candidates for the next cut.');
const aList = mk(pkgAssemble, 'component', 'Concat list writer', 'ffmpeg concat demuxer',
  'A file and duration pair per frame, with the last frame repeated so its duration is honoured. ' +
  'Paths go in with forward slashes because the demuxer treats a backslash as an escape.');
const aEncode = mk(pkgAssemble, 'component', 'Encoder', 'ffmpeg libx264',
  'Scales to 1920x1080 with lanczos at 60fps, CRF 18.');
const aTelemetry = mk(pkgAssemble, 'component', 'Telemetry mapper', 'assemble.mjs',
  'Normalises pointer samples to 0..1 of the viewport, drops what fell inside a cut, and warps ' +
  'the rest. Nothing surviving is an error, because a silent empty cursor track is worse. The ' +
  'element boxes go through the same warp into highlights.json, a hover capped at HIGHLIGHT_HOLD_MS ' +
  'and a click ended at its release.');
const aCues = mk(pkgAssemble, 'component', 'Cue mapper', 'assemble.mjs',
  'The identical filter and warp for narration cues, and it reports how many were dropped inside ' +
  'cuts. Doing this anywhere else silently desyncs the voiceover from the picture.');

const aAuto = mk(pkgAssemble, 'component', 'Auto-speed planner', 'assemble.mjs · AUTO_SPEED',
  "Turns the driver's logged waits into speed ranges: every wait of at least AUTO_SPEED_MIN_MS " +
  'with no narration over it, clipped to start after the previous line has finished and to end ' +
  'before the next begins, so speeding the picture can never pull two lines together. Line ' +
  "lengths come from the TTS clip cache, or the author's slow estimate before narration exists. " +
  'Hand-written ranges win where they overlap.');

const dL3assemble = diagram(pkgAssemble, 'c4-l3-assembler',
  'C4-L3 — Components · Assembler (assemble.mjs)',
  'Level 3, container "3 · Assembler".',
  { macro: 'Container_Boundary', name: '3 · Assembler' });
{
  const [vCfg, vWarp, vFrames, vGaps, vList, vEnc, vTel, vCue, vAuto] = grid(dL3assemble,
    [aConfig, aWarp, aFrames, aGaps, aList, aEncode, aTelemetry, aCues, aAuto], { cols: 3 });
  const [vWork, vFfmpeg, vCache] = column(dL3assemble, [dWork, ffmpeg, dTts]);

  link(dL3assemble, pkgAssemble, vCfg, vWarp, 'Validated ranges to');
  link(dL3assemble, pkgAssemble, vWork, vFrames, 'frames.json and actions.json to');
  link(dL3assemble, pkgAssemble, vFrames, vWarp, 'Every frame timestamp through');
  link(dL3assemble, pkgAssemble, vTel, vWarp, 'Every pointer sample through');
  link(dL3assemble, pkgAssemble, vCue, vWarp, 'Every cue time through');
  link(dL3assemble, pkgAssemble, vFrames, vGaps, 'Surviving frames to');
  link(dL3assemble, pkgAssemble, vFrames, vList, 'Surviving frames to');
  link(dL3assemble, pkgAssemble, vList, vEnc, 'list.txt to');
  link(dL3assemble, pkgAssemble, vEnc, vFfmpeg, 'Runs', 'child process');
  link(dL3assemble, pkgAssemble, vEnc, vWork, 'Writes raw.mp4 or cut.mp4');
  link(dL3assemble, pkgAssemble, vTel, vWork, 'Writes cursor.json');
  link(dL3assemble, pkgAssemble, vCue, vWork, 'Writes narration.json');
  link(dL3assemble, pkgAssemble, vWork, vAuto, 'Logged waits and cues to');
  link(dL3assemble, pkgAssemble, vCache, vAuto, 'Line lengths to');
  link(dL3assemble, pkgAssemble, vAuto, vWarp, 'Unnarrated waits as sped-up ranges to');
}

// ====================================== L3 · 4 — components: zoom projector ==
const pkgProject = pkg(
  '3.4 — Components · Zoom Projector',
  'Inside project.mjs. Turns click telemetry into the zoom regions the compositor animates. The ' +
    'output is a hand-editable JSON project, and explicit regions always beat auto-zoom.',
);

const zRead = mk(pkgProject, 'component', 'Telemetry reader', 'project.mjs',
  'Takes the cursor.json beside the newest take, cut.mp4 before raw.mp4, and keeps the clicks. ' +
  'No clicks is an error rather than an empty project.');
const zCluster = mk(pkgProject, 'component', 'Click clusterer', 'project.mjs',
  'Clicks less than 2500ms apart become one region — opening a menu and picking an item is one ' +
  'move to the viewer, not two.');
const zFlutter = mk(pkgProject, 'component', 'Flutter guard', 'project.mjs',
  'Two regions that would sit less than 800ms apart are merged, so the zoom holds instead of ' +
  'bouncing out and straight back in.');
const zRegion = mk(pkgProject, 'component', 'Region builder', 'project.mjs',
  'Starts 1200ms before the first click and ends 1600ms after the last, at depth 3, with focus ' +
  'clamped to 0.08..0.92 so a corner click still frames something.');
const zTrack = mk(pkgProject, 'component', 'Focus track builder', 'project.mjs',
  'Keeps every click position in a cluster, not only the last. A merged region can span clicks ' +
  'far apart on screen, and the compositor pans across them instead of framing the final one and ' +
  'leaving the earlier ones off screen.');
const zWrite = mk(pkgProject, 'component', 'Project writer', '{take}.recordly · JSON',
  'videoPath plus the regions, and it prints each region with its focus track so the framing can ' +
  'be reviewed before composing.');

const dL3project = diagram(pkgProject, 'c4-l3-zoom-projector',
  'C4-L3 — Components · Zoom Projector (project.mjs)',
  'Level 3, container "4 · Zoom Projector".',
  { macro: 'Container_Boundary', name: '4 · Zoom Projector' });
{
  const [vRead, vClu, vFlut, vReg, vTrack, vWrite] = grid(dL3project,
    [zRead, zCluster, zFlutter, zRegion, zTrack, zWrite], { cols: 3 });
  const [vWork] = column(dL3project, [dWork]);

  link(dL3project, pkgProject, vWork, vRead, 'cursor.json to');
  link(dL3project, pkgProject, vRead, vClu, 'Clicks to');
  link(dL3project, pkgProject, vClu, vFlut, 'Candidate regions to');
  link(dL3project, pkgProject, vFlut, vReg, 'Merged clusters to');
  link(dL3project, pkgProject, vReg, vTrack, 'Each region to');
  link(dL3project, pkgProject, vTrack, vWrite, 'Regions with focus tracks to');
  link(dL3project, pkgProject, vWrite, vWork, 'Writes {take}.recordly');
}

// ========================================== L3 · 5 — components: compositor ==
const pkgCompose = pkg(
  '3.5 — Components · Compositor',
  'Inside compose.mjs. Replaces the macOS-only Recordly step by rendering every frame itself. ' +
    'Frames stream in from ffmpeg and straight back out to it, so nothing intermediate hits disk.',
);

const xArgs = mk(pkgCompose, 'component', 'Project reader', 'compose.mjs',
  'Reads {take}.recordly and the take it names, so the composite is always of the video the project ' +
  'was built from.');
const xLook = mk(pkgCompose, 'component', 'Look resolver', 'compose.mjs + brand.mjs',
  'padding, radius, shadow, background, ramp and pan timings, from the project frame block and ' +
  'overridable by NO_FRAME and PADDING. The mat the window sits on is the brand blue: it is most ' +
  'of what the viewer sees for the length of the demo, so either it carries the brand colour or ' +
  'the video does not have one.');
const xProbe = mk(pkgCompose, 'component', 'Probe', 'ffprobe',
  'Dimensions, frame rate and frame count of the take.');
const xCursorTrack = mk(pkgCompose, 'component', 'Cursor track', 'compose.mjs',
  'Splits telemetry into moves and clicks, then works out when the cursor actually left one point ' +
  'and settled on the next. A held zoom that jumps between click positions would otherwise leave ' +
  'the cursor off screen while it travels.');
const xZoomTrack = mk(pkgCompose, 'component', 'Zoom keyframe track', 'compose.mjs',
  'Four keyframes per region — ramp up, hold, hold, ramp down — interpolated with an ease-in-out ' +
  'cubic. Between regions the track sits at zoom 1, where focus is irrelevant, so interpolating ' +
  'across the gap is safe.');
const xSprites = mk(pkgCompose, 'component', 'Cursor sprites', '@napi-rs/canvas',
  'Arrow and pointing hand drawn once into sprites, then composited with a press scale and a ' +
  'click ripple. This is why the capture needs no real cursor.');
const xRender = mk(pkgCompose, 'component', 'Frame renderer', '@napi-rs/canvas',
  'Per frame: the source into its own canvas, the zoom transform clipped to the rounded window, ' +
  'the shadow, a red rectangle round the element being acted on (highlights.json; HIGHLIGHT, ' +
  'HIGHLIGHT_COLOR), then the cursor on top.');
const xDecode = mk(pkgCompose, 'component', 'Decoder pipe', 'ffmpeg rawvideo rgba',
  'Streams the take in. The decoder delivers small pipe chunks, which are reassembled into one ' +
  'reused frame buffer rather than a freshly concatenated one per frame.');
const xEncode = mk(pkgCompose, 'component', 'Encoder pipe', 'ffmpeg libx264',
  'Takes rendered frames straight back, with faststart. Backpressure is respected by waiting on ' +
  'drain rather than buffering the whole video.');

const dL3compose = diagram(pkgCompose, 'c4-l3-compositor',
  'C4-L3 — Components · Compositor (compose.mjs)',
  'Level 3, container "5 · Compositor".',
  { macro: 'Container_Boundary', name: '5 · Compositor' });
{
  const [vArgs, vLook, vProbe, vCur, vZoom, vSpr, vRen, vDec, vEnc] = grid(dL3compose,
    [xArgs, xLook, xProbe, xCursorTrack, xZoomTrack, xSprites, xRender, xDecode, xEncode],
    { cols: 3 });
  const [vWork, vBrand, vFfmpeg] = column(dL3compose, [dWork, dBrand, ffmpeg]);

  link(dL3compose, pkgCompose, vWork, vArgs, '{take}.recordly and the take to');
  link(dL3compose, pkgCompose, vLook, vBrand, 'Reads colours');
  link(dL3compose, pkgCompose, vArgs, vLook, 'Frame block to');
  link(dL3compose, pkgCompose, vArgs, vProbe, 'Take path to');
  link(dL3compose, pkgCompose, vArgs, vCur, 'Cursor telemetry to');
  link(dL3compose, pkgCompose, vArgs, vZoom, 'Zoom regions to');
  link(dL3compose, pkgCompose, vCur, vZoom, 'Leave and arrive times to');
  link(dL3compose, pkgCompose, vProbe, vDec, 'Geometry and frame rate to');
  link(dL3compose, pkgCompose, vDec, vFfmpeg, 'Runs', 'child process');
  link(dL3compose, pkgCompose, vDec, vRen, 'Raw RGBA frames to');
  link(dL3compose, pkgCompose, vZoom, vRen, 'Zoom and pan per frame to');
  link(dL3compose, pkgCompose, vSpr, vRen, 'Cursor sprites to');
  link(dL3compose, pkgCompose, vLook, vRen, 'Frame styling to');
  link(dL3compose, pkgCompose, vRen, vEnc, 'Composited frames to');
  link(dL3compose, pkgCompose, vEnc, vFfmpeg, 'Runs', 'child process');
  link(dL3compose, pkgCompose, vEnc, vWork, 'Writes final.mp4');
}

// ============================================ L3 · 6 — components: narrator ==
const pkgNarrator = pkg(
  '3.6 — Components · Narrator',
  'Inside narrate.mjs. The three loudness components are the interesting part: TTS comes back ' +
    'uneven in two different ways, and each needs a different correction applied at a different point.',
);

const nCues = mk(pkgNarrator, 'component', 'Cue file resolver', 'narrate.mjs',
  'Reads videoPath out of {take}.recordly to find the cue file belonging to the take that was ' +
  'actually composed, falling back to newest-mtime. Using another take’s cues does not error — it ' +
  'silently narrates over the wrong footage — so the project file, not the timestamp, is the authority.');
const nTts = mk(pkgNarrator, 'component', 'TTS gateway', 'tts.mjs · shared',
  'Shared with cards.mjs, which is why both stages voice a script identically. Picks the provider, ' +
  'then hits a content-addressed cache keyed by provider+voice+text before spending anything.');
const nBreath = mk(pkgNarrator, 'component', 'Breath trimmer', 'tts.mjs · ffmpeg astats',
  'TTS does not start on the word; it starts on 100-160ms at -50 to -85 dB. Cued at the file start ' +
  'that is heard as the line fading up, and normalising a breath just gives a louder breath. ' +
  'Measures RMS in 20ms windows — silenceremove decides on peaks and keeps it — and derives a ' +
  '.lead.mp3 without re-billing.');
const nMeter = mk(pkgNarrator, 'component', 'Loudness meter', 'ffmpeg ebur128',
  'Integrated LUFS per clip. Providers do not return lines at a consistent level: measured here, ' +
  '4.1 LU across one script, worst on the short lines.');
const nLevel = mk(pkgNarrator, 'component', 'Clip leveller', 'ffmpeg volume',
  'Static gain to NARRATION_PREMIX_LUFS (-20), capped at ±6 dB, applied per clip before the mix. ' +
  'Static rather than a second loudnorm, which would ride the syllables inside a line. This is the ' +
  'step that cannot be done later: a dynamic pass over the finished mix sets the level of the ' +
  'track, never of a line.');
const nOverlap = mk(pkgNarrator, 'component', 'Overlap checker', 'narrate.mjs',
  'Warns when one line runs into the next rather than letting two clips talk over each other. The ' +
  'fix is a longer hold or a shorter line, both in the script.');
const nTail = mk(pkgNarrator, 'component', 'Tail guard', 'ffmpeg tpad',
  'A screencast stops emitting frames when the page stops changing, so a closing line can outlast ' +
  'the video; the last frame is held to cover it. Past PAD_LIMIT_MS that is not a long closing line ' +
  'but the wrong cue file, and the stage throws.');
const nGraph = mk(pkgNarrator, 'component', 'Mix graph builder', 'ffmpeg filter_complex',
  'Per clip: volume, then adelay to the cue time. Then amix, apad, and the master chain — ' +
  'speechnorm to lift soft line openings, loudnorm to -16 LUFS with true peak under -1.5 dB. Both ' +
  'leave digital silence alone, so the tightener can still find the silent stretches afterwards.');
const nMux = mk(pkgNarrator, 'component', 'Muxer', 'ffmpeg',
  'Copies the video stream untouched unless the tail guard needed extra room, so the stage costs ' +
  'seconds rather than a re-render.');

const dL3b = diagram(pkgNarrator, 'c4-l3-narrator', 'C4-L3 — Components · Narrator (narrate.mjs)',
  'Level 3, container "6 · Narrator".',
  { macro: 'Container_Boundary', name: '6 · Narrator' });
{
  const vCues = place(dL3b, nCues, 60, 40);
  const vTts = place(dL3b, nTts, 380, 40);
  const vBreath = place(dL3b, nBreath, 700, 40);
  const vMeter = place(dL3b, nMeter, 380, 200);
  const vLevel = place(dL3b, nLevel, 700, 200);
  const vOverlap = place(dL3b, nOverlap, 60, 200);
  const vTail = place(dL3b, nTail, 60, 360);
  const vGraph = place(dL3b, nGraph, 380, 380);
  const vMux = place(dL3b, nMux, 380, 540);

  const vCache = place(dL3b, dTts, 1020, 40);
  const vApi = place(dL3b, ttsApi, 1020, 200);
  const vWork = place(dL3b, dWork, 1020, 380, 220, 160);
  const vFfmpeg = place(dL3b, ffmpeg, 700, 540);

  link(dL3b, pkgNarrator, vCues, vWork, 'Reads {take}.recordly + the cue file');
  link(dL3b, pkgNarrator, vCues, vTts, 'One line at a time to');
  link(dL3b, pkgNarrator, vTts, vCache, 'Hits before spending');
  link(dL3b, pkgNarrator, vTts, vApi, 'Renders a miss', 'HTTPS');
  link(dL3b, pkgNarrator, vTts, vBreath, 'Derives a trimmed clip via');
  link(dL3b, pkgNarrator, vBreath, vCache, 'Writes .lead.mp3 beside the original');
  link(dL3b, pkgNarrator, vBreath, vMeter, 'Trimmed clip to');
  link(dL3b, pkgNarrator, vMeter, vLevel, 'Integrated LUFS to');
  link(dL3b, pkgNarrator, vCues, vOverlap, 'Cue times + clip lengths to');
  link(dL3b, pkgNarrator, vCues, vTail, 'Last cue end vs video length to');
  link(dL3b, pkgNarrator, vLevel, vGraph, 'Per-clip gain to');
  link(dL3b, pkgNarrator, vTail, vGraph, 'Pad duration to');
  link(dL3b, pkgNarrator, vGraph, vMux, 'Filter graph to');
  link(dL3b, pkgNarrator, vMux, vFfmpeg, 'Runs', 'child process');
  link(dL3b, pkgNarrator, vMux, vWork, 'Writes final-narrated.mp4');
}

// =========================================== L3 · 7 — components: tightener ==
const pkgTighten = pkg(
  '3.7 — Components · Tightener',
  'Inside tighten.mjs. The damage this stage can do is silent — a faded word or a dissolved zoom ' +
    'move still produces a clean file of a plausible length — so the placement rule is checked ' +
    'rather than trusted.',
);

const tOpts = mk(pkgTighten, 'component', 'Options', 'tighten.mjs',
  'min, keep, speed, tail, xfade and the two detector floors. Every default errs toward leaving ' +
  'the video alone, because the failure mode here is squeezing too hard and that does not ' +
  'announce itself: the output is simply a video that feels rushed.');
const tDetect = mk(pkgTighten, 'component', 'Detector', 'ffmpeg freezedetect + silencedetect',
  'One pass, both filters. It reports on stderr and exits 0, so the output is read from a spawn ' +
  'rather than a throwing exec. A run still open at the end of the file is closed at the duration ' +
  'rather than dropped, because that trailing run is the one that matters most.');
const tIntersect = mk(pkgTighten, 'component', 'Dead-run intersector', 'tighten.mjs',
  'Dead means frozen AND silent. Either signal alone is wrong: a frozen screen under a narration ' +
  'line is the shot that line is playing over, and silence over a moving screen is a stretch that ' +
  'needs narrating, not cutting. Touching runs are merged so two detections do not become two seams.');
const tZoomGuard = mk(pkgTighten, 'component', 'Zoom guard', 'tighten.mjs + {take}.recordly',
  'Zoom windows are subtracted from the dead runs outright. A dead run butts right up against a ' +
  'zoom, because the zoom is triggered by a click and the screen goes still immediately after it, ' +
  'so a seam there dissolves the move and turns it into a snap.');
const tPlanner = mk(pkgTighten, 'component', 'Segment planner', 'tighten.mjs',
  'Live stretches at 1x, dead ones at up to speed, never leaving less than keep of screen time. A ' +
  'run too short to hold a seam at each end, or one saving under 0.8s, is left alone: a seam is ' +
  'never free, and shaving 0.2s off a pause does not pay for one.');
const tCheck = mk(pkgTighten, 'component', 'Placement check', 'tighten.mjs',
  'Re-verifies every seam against the detected silence and the zoom list, and refuses to write if ' +
  'one is over either. Not belt and braces: a seam on a run edge fades a narration line up from ' +
  'nothing, and nothing catches that except watching the video.');
const tRender = mk(pkgTighten, 'component', 'Renderer', 'ffmpeg xfade + acrossfade',
  'Each segment is trimmed and retimed, then dissolved into the next over a fade long enough to ' +
  'see. atempo only ever stretches silence, so the narration itself is never pitched or hurried.');

const dL3tighten = diagram(pkgTighten, 'c4-l3-tightener',
  'C4-L3 — Components · Tightener (tighten.mjs)',
  'Level 3, container "7 · Tightener".',
  { macro: 'Container_Boundary', name: '7 · Tightener' });
{
  const [vOpts, vDet, vInt, vZoom, vPlan, vChk, vRen] = grid(dL3tighten,
    [tOpts, tDetect, tIntersect, tZoomGuard, tPlanner, tCheck, tRender], { cols: 3 });
  const [vWork, vFfmpeg] = column(dL3tighten, [dWork, ffmpeg]);

  link(dL3tighten, pkgTighten, vWork, vDet, 'final-narrated.mp4 to');
  link(dL3tighten, pkgTighten, vDet, vFfmpeg, 'Runs the detection pass', 'child process');
  link(dL3tighten, pkgTighten, vOpts, vDet, 'Noise floors to');
  link(dL3tighten, pkgTighten, vDet, vInt, 'Frozen and silent runs to');
  link(dL3tighten, pkgTighten, vOpts, vInt, 'Minimum run length to');
  link(dL3tighten, pkgTighten, vInt, vZoom, 'Dead runs to');
  link(dL3tighten, pkgTighten, vWork, vZoom, '{take}.recordly zoom regions to');
  link(dL3tighten, pkgTighten, vZoom, vPlan, 'Protected dead runs to');
  link(dL3tighten, pkgTighten, vOpts, vPlan, 'keep, speed and tail to');
  link(dL3tighten, pkgTighten, vPlan, vChk, 'Segment plan to');
  link(dL3tighten, pkgTighten, vChk, vRen, 'Approved plan to');
  link(dL3tighten, pkgTighten, vRen, vFfmpeg, 'Runs', 'child process');
  link(dL3tighten, pkgTighten, vRen, vWork, 'Writes final-narrated-tight.mp4');
}

// ======================================== L3 · 8 — components: card renderer ==
const pkgCards = pkg(
  '3.8 — Components · Card Renderer',
  'Inside cards.mjs. Cards are painted with canvas rather than ffmpeg drawtext, for real layout ' +
    'control and so the logo composites with alpha. Brand assets come from one directory and ' +
    'nowhere else.',
);

const rCopy = mk(pkgCards, 'component', 'Copy parser', 'cards.mjs + script.mjs',
  'The intro and outro header directives, split on a pipe into headline and subhead. Both appear ' +
  'on the card and both are read aloud. Without a pipe the text becomes the subhead under a ' +
  'default headline. An optional third part is a contact line (an email) under the subhead: ' +
  'shown, not read aloud.');
const rStyle = mk(pkgCards, 'component', 'Style guide reader', 'brand.mjs · shared',
  'Colour and type from brand/StyleGuide.txt, shared with the compositor so the style-guide hex ' +
  'cannot end up in one stage and not the other.');
const rFonts = mk(pkgCards, 'component', 'Font loader', 'cards.mjs + @napi-rs/canvas',
  'Registers every font file in the brand directory. Falls back loudly and states what the card is ' +
  'actually set in, because a silent fallback and a successful resolve otherwise look identical ' +
  'in the log.');
const rPaint = mk(pkgCards, 'component', 'Card painter', '@napi-rs/canvas',
  'The brand hex flat across the top 55% and deepening below, so sampling the field returns the ' +
  'style-guide colour rather than a near-black navy. Then the logo, the CTA green rule, and the ' +
  'type wrapped and balanced so two lines do not come out as a long one and a stub. The block is ' +
  'measured first, then drawn optically centred.');
const rTts = mk(pkgCards, 'component', 'TTS gateway', 'tts.mjs · shared',
  'The same provider, cache and breath trim the narrator uses. Sharing it is why the cards sit at ' +
  'the same level as the body of the video instead of the join being audible.');
const rClip = mk(pkgCards, 'component', 'Clip builder', 'ffmpeg',
  'Still plus voice, with a lead-in long enough to clear the dissolve. The outro is the incoming ' +
  'side of the last fade, so a shorter lead would put its first word inside that fade — the one ' +
  'place a card can start quiet. Only the outer edges fade to black.');
const rJoin = mk(pkgCards, 'component', 'Joiner', 'ffmpeg xfade + acrossfade',
  'Normalises frame rate, pixel format and timebase on every input first, then dissolves card into ' +
  'demo. Filters rather than the concat demuxer, so mismatched encoder settings between the cards ' +
  'and the composed video cannot corrupt the join.');

const dL3cards = diagram(pkgCards, 'c4-l3-card-renderer',
  'C4-L3 — Components · Card Renderer (cards.mjs)',
  'Level 3, container "8 · Card Renderer".',
  { macro: 'Container_Boundary', name: '8 · Card Renderer' });
{
  const [vCopy, vStyle, vFonts, vPaint, vTts, vClip, vJoin] = grid(dL3cards,
    [rCopy, rStyle, rFonts, rPaint, rTts, rClip, rJoin], { cols: 3 });
  const [vFlows, vBrand, vCache, vApi, vWork, vFfmpeg] =
    column(dL3cards, [dFlows, dBrand, dTts, ttsApi, dWork, ffmpeg], { dy: 150 });

  link(dL3cards, pkgCards, vFlows, vCopy, 'intro and outro headers to');
  link(dL3cards, pkgCards, vStyle, vBrand, 'Reads colour and type');
  link(dL3cards, pkgCards, vFonts, vBrand, 'Registers the font files');
  link(dL3cards, pkgCards, vCopy, vPaint, 'Headline, subhead and contact line to');
  link(dL3cards, pkgCards, vStyle, vPaint, 'Palette to');
  link(dL3cards, pkgCards, vFonts, vPaint, 'Resolved typefaces to');
  link(dL3cards, pkgCards, vPaint, vBrand, 'Reads the logo');
  link(dL3cards, pkgCards, vCopy, vTts, 'Spoken line to');
  link(dL3cards, pkgCards, vTts, vCache, 'Hits before spending');
  link(dL3cards, pkgCards, vTts, vApi, 'Renders a miss', 'HTTPS');
  link(dL3cards, pkgCards, vPaint, vClip, 'Card PNG to');
  link(dL3cards, pkgCards, vTts, vClip, 'Card voice to');
  link(dL3cards, pkgCards, vClip, vJoin, 'Card clips to');
  link(dL3cards, pkgCards, vWork, vJoin, 'The tightened video to');
  link(dL3cards, pkgCards, vJoin, vFfmpeg, 'Runs', 'child process');
  link(dL3cards, pkgCards, vJoin, vWork, 'Writes the carded MP4');
}

// ========================================= L3 · 9 — components: quality gate ==
const pkgQa = pkg(
  '3.9 — Components · Quality Gate',
  "Inside qa.mjs. Per-line checks run where cue times are still the take's own timeline — the " +
    'narrated video; whole-video checks run on the deliverable. It reports; it never fixes.',
);

const qInputs = mk(pkgQa, 'component', 'Input resolver', 'qa.mjs',
  'The deliverable (the newest stage output, or --video), the narrated video, the cue file the ' +
  'narrator used, and the intro and outro card lengths to leave out of the whole-video checks.');
const qLineage = mk(pkgQa, 'component', 'Lineage check', 'qa.mjs · file times',
  'Every stage output the deliverable is built from must be newer than the one before it. A stage ' +
  "that did not write leaves an older take's file behind and the next stage joins it: a " +
  'clean-looking video of the wrong take.');
const qStreams = mk(pkgQa, 'component', 'Stream check', 'ffprobe',
  'Audio and video of the same length and with the same start, or the whole track is shifted.');
const qLines = mk(pkgQa, 'component', 'Line checker', 'qa.mjs + TTS clip cache',
  'Overlap: a line still speaking when the next starts — two voices at once. Sync: every line has ' +
  'to start within 250ms of its cue in the narrated video. Line lengths come from the clip cache, ' +
  'so it never calls the TTS API.');
const qDead = mk(pkgQa, 'component', 'Dead-air detector', 'ffmpeg silencedetect',
  '4s without narration warns and 6s fails, outside the title cards.');
const qFreeze = mk(pkgQa, 'component', 'Freeze classifier', 'ffmpeg freezedetect',
  'A still picture with the voice over most of it is a deliberate hold and only warns; a still ' +
  'picture in silence is a wait and fails at 5s. Pauses under 0.8s count as speech, or the gaps ' +
  'between the clauses of one line would score a correctly paced hold as silent.');
const qBlack = mk(pkgQa, 'component', 'Black and loudness', 'ffmpeg blackdetect + ebur128',
  'Black frames fail. Integrated loudness outside -19..-13 LUFS, or a true peak above -1 dBFS, warns.');
const qStills = mk(pkgQa, 'component', 'Still extractor', 'ffmpeg',
  'One still mid-line for every narration line and one for every flagged range: what the visual ' +
  'review looks at.');
const qReport = mk(pkgQa, 'component', 'Report writer', 'qa.json',
  'The verdict, findings ordered fail-first, every line with its timing and still. Exits 1 on any ' +
  'failure, so it can end a build.');

const dL3qa = diagram(pkgQa, 'c4-l3-quality-gate',
  'C4-L3 — Components · Quality Gate (qa.mjs)',
  'Level 3, container "9 · Quality Gate".',
  { macro: 'Container_Boundary', name: '9 · Quality Gate' });
{
  const [vIn, vLin, vStr, vLines, vDead, vFreeze, vBlack, vStills, vRep] = grid(dL3qa,
    [qInputs, qLineage, qStreams, qLines, qDead, qFreeze, qBlack, qStills, qReport], { cols: 3 });
  const [vWork, vCache, vFfmpeg, vAgent] = column(dL3qa, [dWork, dTts, ffmpeg, qaAgent], { dy: 150 });

  link(dL3qa, pkgQa, vWork, vIn, 'Stage outputs and the cue file to');
  link(dL3qa, pkgQa, vIn, vLin, 'The stage chain to');
  link(dL3qa, pkgQa, vIn, vStr, 'The deliverable to');
  link(dL3qa, pkgQa, vIn, vLines, 'Cues and the narrated video to');
  link(dL3qa, pkgQa, vCache, vLines, 'Line lengths to');
  link(dL3qa, pkgQa, vIn, vDead, 'The deliverable and card lengths to');
  link(dL3qa, pkgQa, vIn, vFreeze, 'The deliverable and card lengths to');
  link(dL3qa, pkgQa, vIn, vBlack, 'The deliverable to');
  for (const v of [vLin, vStr, vLines, vDead, vFreeze, vBlack]) link(dL3qa, pkgQa, v, vRep, 'Findings to');
  link(dL3qa, pkgQa, vLines, vStills, 'Line times to');
  link(dL3qa, pkgQa, vFreeze, vStills, 'Flagged ranges to');
  link(dL3qa, pkgQa, vDead, vStills, 'Flagged ranges to');
  for (const v of [vStr, vLines, vDead, vFreeze, vBlack, vStills]) link(dL3qa, pkgQa, v, vFfmpeg, 'Runs', 'child process');
  link(dL3qa, pkgQa, vStills, vWork, 'Writes the stills');
  link(dL3qa, pkgQa, vRep, vWork, 'Writes qa.json');
  link(dL3qa, pkgQa, vAgent, vRep, 'Reads the report and stills of');
}

// ===================================== L3 · 10 — components: build orchestrator ==
const pkgBuild = pkg(
  '3.10 — Components · Build Orchestrator',
  'Inside build.mjs. One command per video, and the only place stages are run by code rather ' +
    'than by hand. Everything it decides — trims included — is measured, so a video can be ' +
    'rebuilt from the repo.',
);

// The flags are named without their leading dashes on purpose: PlantUML reads
// text between two double-dashes as strikethrough.
const bManifest = mk(pkgBuild, 'component', 'Manifest reader', 'videos/*.json',
  'The parts in recording order, the env every stage gets, the crossfade and the silence to keep ' +
  'either side of a join. The only, no-record, join-only and no-gate flags pick what runs.');
const bFolders = mk(pkgBuild, 'component', 'Part folders', 'paths.mjs · DEMO_OUT',
  "Each part builds in out/{video}/{part}/, so no take overwrites another's fixed-name stage " +
  'files. The TTS clip cache stays shared.');
const bRunner = mk(pkgBuild, 'component', 'Part runner', 'child processes',
  "driver, assemble, project, compose, narrate, tighten and cards, in order, each with the part's " +
  "folder and the manifest env. Prints the part's before-the-take note first.");
const bGate = mk(pkgBuild, 'component', 'Part gate', 'qa.mjs',
  'Runs the quality gate on each part and stops the build on a failure, naming the part to fix ' +
  'and how to rerun it.');
const bTrim = mk(pkgBuild, 'component', 'Join planner', 'ffmpeg silencedetect',
  "Measures each part's first and last word and keeps leadS before and tailS after them, so " +
  'joins are trimmed by measurement rather than by hand-picked times.');
const bJoin = mk(pkgBuild, 'component', 'Joiner', 'ffmpeg xfade + acrossfade',
  'Chains a crossfade between every pair of parts, video and audio together.');
const bJoinGate = mk(pkgBuild, 'component', 'Joined gate', 'qa.mjs --cues none',
  'Whole-video checks on the result, with the first part intro card and the last part outro card ' +
  'left out.');
const bState = mk(pkgBuild, 'component', 'Video state recorder', 'memory.mjs recordVideo · video sync',
  'On every way a build ends (built, failed the quality gate, failed outright) records the outcome, ' +
  'scope and qa counts in the video state file next to its page, and sends it to Zep.');
const bReport = mk(pkgBuild, 'component', 'Build report', 'build.json',
  'The trims and every verdict, beside the parts.');

const dL3build = diagram(pkgBuild, 'c4-l3-build',
  'C4-L3 — Components · Build Orchestrator (build.mjs)',
  'Level 3, container "Build Orchestrator".',
  { macro: 'Container_Boundary', name: 'Build Orchestrator' });
{
  const vAuthor = place(dL3build, author, 60, 40);
  const [vMan, vFold, vRun, vGate, vTrim, vJoin, vJGate, vRep, vState] = grid(dL3build,
    [bManifest, bFolders, bRunner, bGate, bTrim, bJoin, bJoinGate, bReport, bState], { y: 200, cols: 3 });
  const [vManifests, vWork, vStages, vQa, vFfmpeg, vMemoryC] =
    column(dL3build, [dManifests, dWork, cDriver, cQa, ffmpeg, cMemory], { dy: 150 });

  link(dL3build, pkgBuild, vAuthor, vMan, 'Runs', 'CLI');
  link(dL3build, pkgBuild, vMan, vManifests, 'Reads');
  link(dL3build, pkgBuild, vMan, vFold, 'Parts to');
  link(dL3build, pkgBuild, vFold, vRun, 'Each part with its folder to');
  link(dL3build, pkgBuild, vRun, vStages, 'Runs driver.mjs, then every later stage', 'child process');
  link(dL3build, pkgBuild, vRun, vWork, "Each stage writes the part's files in");
  link(dL3build, pkgBuild, vRun, vGate, 'Then');
  link(dL3build, pkgBuild, vGate, vQa, 'Runs', 'child process');
  link(dL3build, pkgBuild, vGate, vTrim, 'Passed parts to');
  link(dL3build, pkgBuild, vTrim, vFfmpeg, 'Measures speech via', 'child process');
  link(dL3build, pkgBuild, vTrim, vJoin, 'Trims to');
  link(dL3build, pkgBuild, vJoin, vFfmpeg, 'Runs', 'child process');
  link(dL3build, pkgBuild, vJoin, vWork, 'Writes the joined MP4');
  link(dL3build, pkgBuild, vJoin, vJGate, 'The joined video to');
  link(dL3build, pkgBuild, vJGate, vQa, 'Runs', 'child process');
  link(dL3build, pkgBuild, vJGate, vRep, 'Verdict to');
  link(dL3build, pkgBuild, vRep, vWork, 'Writes build.json');
  link(dL3build, pkgBuild, vGate, vState, 'A failed gate to');
  link(dL3build, pkgBuild, vRep, vState, 'The finished build to');
  link(dL3build, pkgBuild, vState, vMemoryC, 'Records the state and sends it to Zep via', 'import + child process');
}

// ======================================== L3 · 11 — components: memory ==
const pkgMemory = pkg(
  '3.11 — Components · Memory',
  'Inside memory.mjs. Bookkeeping for project memory: it never reads an online source itself ' +
    '(only the memory agent can, through MCP tools), but it decides what changed, merges what the ' +
    'agent found, and keeps Zep in step with the repo.',
);

const mSource = mk(pkgMemory, 'component', 'Source resolver', 'sources.json + .env · source',
  'Finds the apps (one folder per app under memory/features), the catalog of each, and its online ' +
  'source from FEATURE_SOURCE_{APP} in .env; recognises the kind of source and names the tools to ' +
  'list and read it.');
const mDiff = mk(pkgMemory, 'component', 'Change detector', 'diff · baseline',
  'Compares a source listing with the sync lock: new, changed, removed, unchanged. Files dated on ' +
  'or before the catalog generated date are its baseline, recorded without being read.');
const mCatalog = mk(pkgMemory, 'component', 'Catalog merger', 'upsert',
  'Merges the features the agent found into data/features.json: matched by name, a new one gets ' +
  'the next feature id; totals and the updated date follow.');
const mLock = mk(pkgMemory, 'component', 'Sync lock', 'mark · synced',
  'data/sources.lock.json next to each catalog: every source file seen, its kind and the features ' +
  'it fed, and when the app was last synced. Private with its app.');
const mStale = mk(pkgMemory, 'component', 'Staleness check', 'staleSources() · MEMORY_MAX_AGE_H',
  'Apps whose source was last synced longer ago than the limit. Read by the session hook and by ' +
  'build.mjs.');
const mHook = mk(pkgMemory, 'component', 'Session hook', 'hook · SessionStart',
  'Runs when a Claude Code session starts: attributes the session to its user, opens its Zep ' +
  'thread, and asks Claude to launch the memory agent when a source is stale.');
const mUsers = mk(pkgMemory, 'component', 'Session attribution', 'MEMORY_USER · Zep users and threads',
  'One Zep user per person (MEMORY_USER, else git user.email) and one thread per Claude session; ' +
  'zep session adds notes to it.');
const mVideo = mk(pkgMemory, 'component', 'Video state', 'video state · video review · video accept · video sync',
  'One state file per video next to its page: status (not built, build failed, qa failed, awaiting ' +
  'review, review failed, done, accepted, published), last build with qa counts, the visual review, the ' +
  "user's acceptance of a build with open findings (never recorded as a PASS) and a history. " +
  'Generates the Video status section of the page, sends the state to the app graph and posts the whole ' +
  'status to the video thread.');
const mRecorder = mk(pkgMemory, 'component', 'Session recorder', 'session flush (Stop) · session end (SessionEnd) · session video',
  'After every Claude turn, and at the end, pushes what the person typed and Claude answered from the transcript, tool output left out and ' +
  'emails and phone numbers masked, then a summary built from the record: prompts, files changed, ' +
  'commits, pull requests. Each new video starts a new thread, so a video is a session of its own.');
const mPush = mk(pkgMemory, 'component', 'Zep publisher', 'zep push',
  'Turns catalogs (one document per feature), video pages, rules, pipeline lessons, flows, traces and ' +
  'manifests (not generated scripts or videos) into Zep documents in the graph of their app. Sends only what changed; a full push ' +
  'removes documents whose file is gone.');
const mSearch = mk(pkgMemory, 'component', 'Zep search', 'zep search',
  'Facts from the graph of one app, or of all of them.');

const dL3memory = diagram(pkgMemory, 'c4-l3-memory',
  'C4-L3 — Components · Memory (memory.mjs)',
  'Level 3, container "Memory".',
  { macro: 'Container_Boundary', name: 'Memory' });
{
  const vAgent = place(dL3memory, memoryAgent, 60, 40);
  const vMemAuthor = place(dL3memory, author, 400, 40);
  const [vSrc, vDiff, vCat, vLock, vStale, vHook, vUsers, vPush, vSearch, vRec, vVideo] = grid(dL3memory,
    [mSource, mDiff, mCatalog, mLock, mStale, mHook, mUsers, mPush, mSearch, mRecorder, mVideo], { y: 200, cols: 3 });
  const [vStore, vTraces, vManifests, vBuild, vZep] =
    column(dL3memory, [dMemory, dTraces, dManifests, cBuild, zepCloud], { dy: 150 });

  link(dL3memory, pkgMemory, vAgent, vSrc, 'Asks where the source is', 'CLI');
  link(dL3memory, pkgMemory, vAgent, vDiff, 'Hands the source listing to', 'CLI');
  link(dL3memory, pkgMemory, vAgent, vCat, 'Hands the features it read to', 'CLI');
  link(dL3memory, pkgMemory, vAgent, vPush, 'Runs', 'CLI');
  link(dL3memory, pkgMemory, vSrc, vStore, 'Reads sources.json and the catalogs');
  link(dL3memory, pkgMemory, vDiff, vLock, 'Compares with');
  link(dL3memory, pkgMemory, vCat, vStore, 'Writes data/features.json');
  link(dL3memory, pkgMemory, vCat, vLock, 'Then records the file in');
  link(dL3memory, pkgMemory, vLock, vStore, 'Writes data/sources.lock.json');
  link(dL3memory, pkgMemory, vStale, vLock, 'Reads the last sync from');
  link(dL3memory, pkgMemory, vBuild, vStale, 'Warns on stale sources', 'import');
  link(dL3memory, pkgMemory, vHook, vStale, 'Checks');
  link(dL3memory, pkgMemory, vHook, vUsers, 'Opens the session thread via');
  link(dL3memory, pkgMemory, vUsers, vZep, 'Users, threads, messages', 'HTTPS');
  link(dL3memory, pkgMemory, vRec, vUsers, 'Opens and switches threads via');
  link(dL3memory, pkgMemory, vRec, vZep, 'Conversation and summary messages', 'HTTPS');
  link(dL3memory, pkgMemory, vBuild, vVideo, 'Records every build', 'import');
  link(dL3memory, pkgMemory, vMemAuthor, vVideo, 'Records the visual review (through Claude)', 'CLI');
  link(dL3memory, pkgMemory, vVideo, vStore, 'Writes the state file and the page status');
  link(dL3memory, pkgMemory, vVideo, vPush, 'Sends the state via');
  link(dL3memory, pkgMemory, vVideo, vZep, 'Posts each change to the video thread', 'HTTPS');
  link(dL3memory, pkgMemory, vMemAuthor, vRec, 'Starts each new video as a new session (through Claude)', 'CLI');
  link(dL3memory, pkgMemory, vPush, vStore, 'Reads catalogs, pages, rules');
  link(dL3memory, pkgMemory, vPush, vTraces, 'Reads');
  link(dL3memory, pkgMemory, vPush, vManifests, 'Reads');
  link(dL3memory, pkgMemory, vPush, vZep, 'Adds and deletes episodes', 'HTTPS');
  link(dL3memory, pkgMemory, vSearch, vZep, 'Searches facts', 'HTTPS');
}

// ===================================== L3 · 12 — components: publisher ==
const pkgPublish = pkg(
  '3.12 — Components · Publisher',
  'Inside publish.mjs. The last step of a video, and the only one that sends it anywhere: gated on ' +
    'the video state and on the explicit approval of the user.',
);
const pPlan = mk(pkgPublish, 'component', 'Publish plan', 'check',
  'The file, its destination (PUBLISH_DEST_{APP} and its kind), the ticket from the manifest, and ' +
  'every reason it may not be published yet: state not done, file missing, destination or Google ' +
  'credentials not set.');
const pAuth = mk(pkgPublish, 'component', 'Google sign-in', 'auth · OAuth loopback + PKCE',
  'One-time: the user signs in in the browser, Google redirects to a 127.0.0.1 port, and the refresh ' +
  'token is written into .env, never printed.');
const pGate = mk(pkgPublish, 'component', 'Approval gate', 'upload --approved',
  'Refuses unless the video state is done (or already published) and --approved is given, which ' +
  'Claude passes only after the user says to publish.');
const pUpload = mk(pkgPublish, 'component', 'Drive uploader', 'resumable upload · 8 MB chunks',
  'Uploads into the destination folder as the user, or adds a new revision of the file published ' +
  'before so its link stays the same.');
const pRecord = mk(pkgPublish, 'component', 'Publication record', 'memory.mjs recordVideo · video sync',
  'Records the link, file id and destination in the video state (status published), posts it to the ' +
  'video thread and states it as facts in the app graph. jira records the comment Claude posted.');

const dL3publish = diagram(pkgPublish, 'c4-l3-publisher',
  'C4-L3 — Components · Publisher (publish.mjs)',
  'Level 3, container "Publisher".',
  { macro: 'Container_Boundary', name: 'Publisher' });
{
  const vAuthor = place(dL3publish, author, 60, 40);
  const [vPlan, vAuth, vGate, vUp, vRec] = grid(dL3publish, [pPlan, pAuth, pGate, pUpload, pRecord], { y: 200, cols: 3 });
  const [vWorkP, vMemP, vDestP, vJiraP] = column(dL3publish, [dWork, cMemory, videoDest, jiraTickets], { dy: 150 });
  link(dL3publish, pkgPublish, vAuthor, vAuth, 'Signs in once', 'CLI');
  link(dL3publish, pkgPublish, vAuthor, vGate, 'Approves, then Claude runs upload', 'CLI');
  link(dL3publish, pkgPublish, vGate, vPlan, 'Checks');
  link(dL3publish, pkgPublish, vPlan, vMemP, 'Reads the video state via', 'import');
  link(dL3publish, pkgPublish, vPlan, vWorkP, 'Finds the MP4 in');
  link(dL3publish, pkgPublish, vGate, vUp, 'Approved to');
  link(dL3publish, pkgPublish, vAuth, vUp, 'Refresh token for');
  link(dL3publish, pkgPublish, vUp, vDestP, 'Uploads to', 'HTTPS');
  link(dL3publish, pkgPublish, vUp, vRec, 'The link to');
  link(dL3publish, pkgPublish, vRec, vMemP, 'Records and syncs via', 'import + child process');
  link(dL3publish, pkgPublish, vAuthor, vJiraP, 'Posts the link on the ticket (through Claude)', 'MCP');
}

// --------------------------------------------------------------- validate
const byId = new Map();
(function index(o, at = '$') {
  if (Array.isArray(o)) return o.forEach((v, i) => index(v, `${at}[${i}]`));
  if (!o || typeof o !== 'object') return;
  if (o._id) {
    if (byId.has(o._id)) throw new Error(`duplicate _id ${o._id} at ${at}`);
    byId.set(o._id, o);
  }
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('__')) index(v, `${at}.${k}`);
})(project);

const problems = [];
(function check(o, at = '$') {
  if (Array.isArray(o)) return o.forEach((v, i) => check(v, `${at}[${i}]`));
  if (!o || typeof o !== 'object') return;
  if (typeof o.$ref === 'string' && !byId.has(o.$ref)) problems.push(`${at}: unresolved $ref ${o.$ref}`);
  if (o._type && !o._id) problems.push(`${at}: ${o._type} has no _id`);
  if (o._type && o._type !== 'Project' && !o._parent) problems.push(`${at}: ${o._type} has no _parent`);
  if (o._parent && !byId.has(o._parent.$ref)) problems.push(`${at}: _parent does not resolve`);
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('__')) check(v, `${at}.${k}`);
})(project);

for (const p of model.ownedElements.filter((e) => e._type === 'UMLPackage')) {
  for (const d of p.ownedElements.filter((e) => e._type === 'UMLClassDiagram')) {
    const onDiagram = new Set(
      d.ownedViews.filter((v) => v._type === 'UMLClassView').map((v) => v._id),
    );
    for (const e of d.ownedViews.filter((v) => v._type === 'UMLDependencyView')) {
      if (!onDiagram.has(e.head.$ref)) problems.push(`${d.name}: edge head is not on this diagram`);
      if (!onDiagram.has(e.tail.$ref)) problems.push(`${d.name}: edge tail is not on this diagram`);
    }
  }
}

// PlantUML macro arguments are quoted strings with no escape for a quote, so a
// stray one silently swallows the rest of the argument list. Angle brackets are
// the same class of problem: PlantUML reads them as markup, so a placeholder
// like <take>.cursor.json disappears from the rendered box. Both are caught
// here rather than in a rendered diagram nobody looks at twice.
for (const el of byId.values()) {
  if (el._type !== 'UMLClass') continue;
  const text = `${el.name}${el.__tech}${el.__doc}`;
  if (/["\n]/.test(text)) {
    problems.push(`element "${el.name}" has a quote or newline that PlantUML cannot carry`);
  }
  if (/[<>]/.test(text)) {
    problems.push(`element "${el.name}" has an angle bracket; PlantUML reads it as markup`);
  }
}
for (const d of diagrams) {
  for (const l of d.links) {
    if (/["<>\n]/.test(`${l.label}${l.tech}`)) {
      problems.push(`relationship "${l.label}" has a quote or angle bracket`);
    }
  }
}

// Coverage: mentioning a stage somewhere in the model is not enough, it has to
// be drawn at every level it belongs to. These rules caught nothing before they
// existed, which is how memory.mjs and Zep reached main on L2 only.
const isL1 = (d) => d.slug === 'c4-l1-context';
const isL3 = (d) => d.slug.startsWith('c4-l3-');
const placed = (pred) => new Set(diagrams.filter(pred).flatMap((d) => d.nodes));
const allEls = [...byId.values()].filter((e) => e._type === 'UMLClass');

// 1. every container has its own L3 diagram (its boundary carries the container's name)
const l3Boundaries = new Set(diagrams.filter(isL3).map((d) => d.boundary?.name));
for (const c of allEls.filter((e) => e.__kind === 'container')) {
  if (!l3Boundaries.has(c.name)) problems.push(`container "${c.name}" has no L3 diagram (diagram(..., { macro: 'Container_Boundary', name: '${c.name}' }))`);
}

// 2. every person and external system drawn anywhere is on the L1 context diagram
const onL1 = placed(isL1);
for (const el of placed(() => true)) {
  if ((el.__kind === 'external' || el.__kind === 'person') && !onL1.has(el)) {
    problems.push(`${el.__kind} "${el.name}" is drawn on a diagram but not on L1 context`);
  }
}

// 3. every pipeline file is named by an L3 diagram: its title or one of its components
const l3Text = diagrams.filter(isL3)
  .map((d) => [d.name, ...d.nodes.filter((n) => n.__kind === 'component').map((n) => `${n.name} ${n.__tech} ${n.__doc}`)].join(' '))
  .join(' ');
const PIPELINE = path.join(HERE, '..', 'pipeline');
for (const f of fs.readdirSync(PIPELINE).filter((x) => x.endsWith('.mjs'))) {
  if (!l3Text.includes(f)) problems.push(`pipeline/${f} is not named by any L3 diagram title or component`);
}

// 4. every runtime dependency is named in the model, so a new outside service
//    (a client library) cannot arrive without being drawn
const modelText = allEls.map((e) => `${e.name} ${e.__tech} ${e.__doc}`).join(' ');
const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(PIPELINE, 'package.json'), 'utf8')).dependencies ?? {});
for (const dep of deps) {
  if (!modelText.includes(dep)) problems.push(`dependency ${dep} (pipeline/package.json) is not named by any element`);
}

if (problems.length) {
  console.error(`${problems.length} structural problem(s):`);
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}

// ------------------------------------------------------------- write .mdj
const json = JSON.stringify(project, (k, v) => (k.startsWith('__') ? undefined : v), 2);
JSON.parse(json);
fs.writeFileSync(MDJ, `${json}\n`);

// ------------------------------------------------------------ write .puml
// A C4 box wants a caption, not an essay, so PlantUML gets the first sentence.
// The full description is in C4.md and in the StarUML Documentation panel.
function firstSentence(doc) {
  const s = doc.replace(/\s+/g, ' ').trim();
  // split only on a full stop that ends a word and precedes a capital, so
  // ".demo", ".mjs" and "1.4s" do not count as sentence ends
  const m = /^(.+?[a-z0-9)\]])\.\s+[A-Z]/.exec(s);
  const one = m ? `${m[1]}.` : s;
  return one.length > 200 ? `${one.slice(0, 197).trimEnd()}...` : one;
}

const aliases = new Map();
const usedAliases = new Set();
function alias(el) {
  if (aliases.has(el._id)) return aliases.get(el._id);
  let base = el.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '');
  if (!base) base = 'el';
  let a = base;
  let n = 2;
  while (usedAliases.has(a)) a = `${base}_${n++}`;
  usedAliases.add(a);
  aliases.set(el._id, a);
  return a;
}

// deepest C4-PlantUML include a diagram needs
function includeFor(d) {
  if (d.nodes.some((e) => e.__kind === 'component')) return 'C4_Component';
  if (d.nodes.some((e) => e.__kind === 'container' || e.__kind === 'store')) return 'C4_Container';
  return 'C4_Context';
}

function pumlNode(el, indent) {
  const macro = PUML_MACRO[el.__kind];
  // Person, System and System_Ext are (alias, label, descr) — no techn
  // parameter — so their technology is folded into the description instead.
  const hasTechArg = !['person', 'system', 'external'].includes(el.__kind);
  const descr =
    !hasTechArg && el.__tech ? `${el.__tech}. ${firstSentence(el.__doc)}` : firstSentence(el.__doc);
  const quoted = hasTechArg ? [el.name, el.__tech, descr] : [el.name, descr];
  return `${indent}${macro}(${alias(el)}, ${quoted.map((a) => `"${a}"`).join(', ')})`;
}

const pumlFiles = [];
for (const d of diagrams) {
  const file = path.join(HERE, `${d.slug}.puml`);
  const inBoundary = d.boundary
    ? d.nodes.filter((e) => e._parent.$ref === d.owner._id)
    : [];
  const outside = d.nodes.filter((e) => !inBoundary.includes(e));

  const out = [];
  out.push(`@startuml ${d.slug}`);
  out.push("' Generated by docs/c4-model.mjs — do not edit; edit the model and re-run.");
  out.push(`!include <C4/${includeFor(d)}>`);
  out.push("' No bundled C4 stdlib? Replace the line above with:");
  out.push(
    `' !include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/${includeFor(d)}.puml`,
  );
  out.push('');
  out.push(`title ${d.name}`);
  out.push(`caption ${d.documentation.replace(/\s+/g, ' ')}`);
  out.push('');

  for (const el of outside) out.push(pumlNode(el, ''));
  if (d.boundary) {
    out.push('');
    out.push(`${d.boundary.macro}(${alias({ _id: `b-${d.slug}`, name: d.boundary.name })}, "${d.boundary.name}") {`);
    for (const el of inBoundary) out.push(pumlNode(el, '  '));
    out.push('}');
  }
  out.push('');
  for (const l of d.links) {
    const args = [alias(l.from), alias(l.to), `"${l.label}"`];
    if (l.tech) args.push(`"${l.tech}"`);
    out.push(`Rel(${args.join(', ')})`);
  }
  out.push('');
  out.push('LAYOUT_WITH_LEGEND()');
  out.push('@enduml');

  fs.writeFileSync(file, `${out.join('\n')}\n`);
  pumlFiles.push({ file, d, nodes: d.nodes.length, links: d.links.length });
}

// -------------------------------------------------------------- write .md
const mermaidIds = new Map();
const mid = (el) => {
  if (!mermaidIds.has(el._id)) mermaidIds.set(el._id, `n${mermaidIds.size}`);
  return mermaidIds.get(el._id);
};
const esc = (s) => s.replace(/"/g, "'").replace(/\|/g, '/');

function mermaid(d) {
  const out = ['```mermaid', 'flowchart TD'];
  for (const el of d.nodes) {
    const body = `${esc(el.name)}<br/><i>[${KIND_LABEL[el.__kind]}${el.__tech ? `: ${esc(el.__tech)}` : ''}]</i>`;
    out.push(
      el.__kind === 'store'
        ? `  ${mid(el)}[("${body}")]`
        : el.__kind === 'person'
          ? `  ${mid(el)}(["${body}"])`
          : `  ${mid(el)}["${body}"]`,
    );
  }
  for (const l of d.links) {
    out.push(`  ${mid(l.from)} -->|"${esc(l.label)}${l.tech ? ` [${esc(l.tech)}]` : ''}"| ${mid(l.to)}`);
  }
  for (const [kind, c] of Object.entries(COLOR)) {
    out.push(`  classDef ${kind} fill:${c.fill},stroke:${c.fill},color:${c.font};`);
  }
  for (const kind of Object.keys(COLOR)) {
    const ids = d.nodes.filter((e) => e.__kind === kind).map(mid);
    if (ids.length) out.push(`  class ${ids.join(',')} ${kind};`);
  }
  out.push('```');
  return out.join('\n');
}

const cell = (s) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|');

const md = [];
md.push('# C4 model — Demo Video Pipeline\n');
md.push(
  '> Generated by `docs/c4-model.mjs`. **Do not edit this file** — edit the model and re-run\n' +
    '> `node docs/c4-model.mjs`, which rewrites every rendering together.\n',
);
md.push('The same model is published three ways:\n');
md.push('| File | Tool | Notes |');
md.push('|---|---|---|');
md.push('| `C4.md` | anything | this file — mermaid, plus the full descriptions |');
md.push(
  `| ${diagrams.length} × \`c4-*.puml\` | ` +
    '[C4-PlantUML](https://github.com/plantuml-stdlib/C4-PlantUML) | proper C4 shapes and ' +
    'boundaries; renders to PNG/SVG from the CLI or an IDE plugin |',
);
md.push(
  '| `ProductVideo-C4.mdj` | [StarUML](https://staruml.io) | stock UML class diagrams, no ' +
    'extension needed; C4 kind as a stereotype, description in the Documentation panel |',
);
md.push(
  '\nRendering the PlantUML, once `plantuml` is on PATH:\n\n' +
    '```\nplantuml -tsvg docs/c4-*.puml\n```\n\n' +
    'The `!include <C4/...>` lines use PlantUML’s bundled C4 stdlib. If yours is too old to have\n' +
    'it, each file carries the URL form on the commented line beneath.\n',
);
md.push(MODEL_DOC);
md.push('\n## Legend\n');
md.push('| | C4 element | Colour | PlantUML macro |');
md.push('|---|---|---|---|');
for (const [kind, label] of Object.entries(KIND_LABEL)) {
  const icon = kind === 'store' ? '🗄' : kind === 'person' ? '👤' : '▭';
  md.push(`| ${icon} | ${label} | \`${COLOR[kind].fill}\` | \`${PUML_MACRO[kind]}()\` |`);
}

for (const d of diagrams) {
  md.push(`\n## ${d.name}\n`);
  md.push(`${d.documentation}\n`);
  md.push(`PlantUML: \`docs/${d.slug}.puml\`\n`);
  md.push(mermaid(d));
  md.push('\n### Elements\n');
  md.push('| Element | Kind | Technology | Description |');
  md.push('|---|---|---|---|');
  const seen = new Set();
  for (const el of d.nodes) {
    if (seen.has(el._id)) continue;
    seen.add(el._id);
    md.push(
      `| **${cell(el.name)}** | ${KIND_LABEL[el.__kind]} | ${el.__tech ? `\`${cell(el.__tech)}\`` : '—'} | ${cell(el.__doc)} |`,
    );
  }
}

fs.writeFileSync(MD, `${md.join('\n')}\n`);

// ------------------------------------------------------------------ report
const counts = {};
for (const el of byId.values()) counts[el._type] = (counts[el._type] ?? 0) + 1;
const rel = (p) => path.relative(process.cwd(), p);

console.log(`${rel(MDJ)}  (${(json.length / 1024).toFixed(0)} KB)`);
console.log(`  ${byId.size} objects — every _id unique, every $ref and _parent resolves`);
for (const t of ['UMLPackage', 'UMLClassDiagram', 'UMLClass', 'UMLDependency', 'UMLClassView', 'UMLDependencyView']) {
  console.log(`    ${String(counts[t] ?? 0).padStart(4)}  ${t}`);
}
for (const p of pumlFiles) {
  console.log(`${rel(p.file)}  — ${p.nodes} nodes, ${p.links} edges, !include <C4/${includeFor(p.d)}>`);
}
console.log(`${rel(MD)}`);
