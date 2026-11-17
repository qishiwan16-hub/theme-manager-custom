'use strict';
// Run with: node --test tests/theme-bindings.test.cjs
// Exercises the shipped single file with mocked browser and public helper APIs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const assetSource = source.slice(source.indexOf('// Theme asset bindings:'), source.indexOf('/* BEGIN MODULE 26/29:'));
function moduleSource(number) {
    return source.slice(source.indexOf(`/* BEGIN MODULE ${number}/29:`), source.indexOf(`/* END MODULE ${number}/29:`));
}
function events() {
    const handlers = new Map();
    return {
        addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
        removeEventListener(name, handler) { handlers.get(name)?.delete(handler); },
        emit(name, event = {}) { for (const handler of [...(handlers.get(name) || [])]) handler(event); },
        count(name) { return handlers.get(name)?.size || 0; },
    };
}
function harness({ trees = [], data = { themeMeta: {} }, session = new Map(), helper = true } = {}) {
    let currentTrees = clone(trees), updates = 0, rejectUpdate = false, ignoreUpdate = false;
    const logs = [], messages = [], sheets = [], timers = new Map();
    const document = Object.assign(events(), { getElementById: () => null });
    const window = Object.assign(events(), {
        document,
        ThemeMgrDiagnostics: { recordOperation(action, success, details) { logs.push({ action, success, details: clone(details) }); } },
        sessionStorage: { getItem(key) { return session.get(key); }, setItem(key, value) { session.set(key, value); } },
        setInterval(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
        clearInterval(id) { timers.delete(id); },
    });
    if (helper) window.TavernHelper = {
        getScriptTrees(options) { assert.equal(options.type, 'global'); return clone(currentTrees); },
        updateScriptTreesWith(updater, options) {
            assert.equal(options.type, 'global'); updates++;
            if (rejectUpdate) throw new Error('update rejected');
            const next = updater(clone(currentTrees));
            if (!ignoreUpdate) currentTrees = clone(next).map((item, i) => item.id ? item : { ...item, id: 'generated-' + i });
            return clone(currentTrees);
        },
    };
    function createSheet(html) {
        const nodes = new Map();
        const sheet = {
            html, isConnected: true,
            querySelector(selector) {
                if (selector === '[data-create-folder]' && !html.includes('data-create-folder')) return null;
                if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', value: '', dataset: {}, checked: false });
                return nodes.get(selector);
            },
            querySelectorAll(selector) {
                const attribute = selector.slice(1, -1);
                const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                const text = html + [...nodes.values()].map(node => node.innerHTML).join('');
                return [...text.matchAll(new RegExp(attribute + '="(\\d+)"', 'g'))].map(match => {
                    const id = selector + ':' + match[1];
                    if (!nodes.has(id)) nodes.set(id, { dataset: { [key]: match[1] }, checked: text.includes(attribute + '="' + match[1] + '" checked') });
                    return nodes.get(id);
                });
            },
        };
        sheets.push(sheet); return sheet;
    }
    const opts = {
        load: () => data,
        esc: text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
        toast: (...message) => messages.push(message),
        createSheet,
        closeSheet(sheet, options = {}) { if (!options.force && sheet.guard && sheet.guard('programmatic') === false) return false; sheet.isConnected = false; return true; },
        setBeforeClose(sheet, guard) { sheet.guard = guard; },
        backgrounds: () => ({ buildBackgroundBindHtml: name => String(name), openBackgroundPickerSheet(name, onPick) { opts.onPick = onPick; } }),
    };
    const context = vm.createContext({ window, console, setTimeout, clearTimeout });
    vm.runInContext(assetSource, context);
    const ns = window.ThemeMgrModules, api = ns.createThemeAssets(opts);
    return {
        window, document, context, ns, api, opts, data, logs, messages, sheets, session,
        trees: () => currentTrees, updates: () => updates,
        reject(value) { rejectUpdate = value; }, ignore(value) { ignoreUpdate = value; },
        async tick() { for (const fn of [...timers.values()]) fn(); await Promise.resolve(); },
    };
}
const binding = (...ids) => ({ folderId: 'folder', folderName: '美化脚本', scripts: ids.map(id => ({ id, name: id })) });
function fixtures() {
    return [{ type: 'script', id: 'unrelated', enabled: true, content: 'untouched' }, {
        type: 'folder', id: 'folder', name: '美化脚本', enabled: false, icon: 'icon', scripts: [
            { type: 'script', id: 'a', name: 'A', enabled: false, content: 'A content', data: { custom: 1 } },
            { type: 'script', id: 'b', name: 'B', enabled: false, content: 'B content' },
            { type: 'script', id: 'already-on', enabled: true, content: 'C content' },
            { type: 'script', id: 'other', enabled: false, content: 'D content' },
        ],
    }];
}
const script = (h, id) => h.trees()[1].scripts.find(item => item.id === id);
const themeData = () => ({ themeMeta: { A: { scriptBinding: binding('a', 'already-on') }, B: { scriptBinding: binding('a', 'b') }, none: {} } });

test('legacy background migrates; order, uniqueness and explicit default survive normalization', () => {
    const { ns } = harness();
    assert.deepEqual(clone(ns.themeAssets.normalize({ backgroundName: 'old.png' })).backgroundNames, ['old.png']);
    const meta = ns.themeAssets.normalize({ backgroundNames: ['b', '', null, 'a', 'b'], defaultBackgroundName: 'a' });
    assert.deepEqual(clone(meta.backgroundNames), ['b', 'a']); assert.equal(meta.backgroundName, 'a');
    meta.backgroundNames.splice(1, 1); ns.themeAssets.normalize(meta); assert.equal(meta.defaultBackgroundName, 'b');
    meta.backgroundNames = []; ns.themeAssets.normalize(meta); assert.equal(meta.backgroundName, '');
});

test('imports merge ordered pools while preserving the current default and clone script references', () => {
    const { ns } = harness(), incoming = { backgroundNames: ['b', 'c'], defaultBackgroundName: 'c', scriptBinding: binding('a') };
    const meta = ns.themeAssets.merge({ backgroundName: 'a' }, incoming);
    assert.deepEqual(clone(meta.backgroundNames), ['a', 'b', 'c']); assert.equal(meta.backgroundName, 'a');
    incoming.scriptBinding.scripts[0].name = 'changed'; assert.equal(meta.scriptBinding.scripts[0].name, 'a');
    const imported = ns.themeAssets.merge({}, incoming); assert.equal(imported.backgroundName, 'c');
});

test('invalid imported script IDs are rejected and duplicate IDs are removed', () => {
    const { ns } = harness();
    const meta = ns.themeAssets.normalize({ scriptBinding: { folderId: 'folder', scripts: [null, {}, { id: 'a' }, { id: 'a' }, { id: 2 }] } });
    assert.deepEqual(clone(meta.scriptBinding.scripts), [{ id: 'a', name: 'a' }]);
    assert.equal(ns.themeAssets.normalize({ scriptBinding: { folderId: null, scripts: [] } }).scriptBinding, null);
});

test('metadata import and annotation detection include both new binding types', () => {
    const h = harness(); vm.runInContext(moduleSource('07'), h.context);
    const metadata = h.ns.themeMetadata, data = { categories: [], themeMeta: {} };
    metadata.mergeImported(data, ['new'], { new: { backgroundNames: ['a', 'b'], defaultBackgroundName: 'b', scriptBinding: binding('a') } }, []);
    assert.deepEqual(clone(data.themeMeta.new.backgroundNames), ['a', 'b']); assert.equal(data.themeMeta.new.backgroundName, 'b');
    assert.equal(metadata.hasMeaningfulAnnotation(data.themeMeta.new), true);
});

test('zero or one background resolves without showing a picker', async () => {
    const h = harness(); assert.equal(await h.api.chooseBackground({}), '');
    assert.equal(await h.api.chooseBackground({ backgroundName: 'single' }), 'single'); assert.equal(h.sheets.length, 0);
});

for (const close of ['cancel', 'backdrop', 'Escape', 'back']) test('background picker uses the default on ' + close, async () => {
    const h = harness(), meta = { backgroundNames: ['first', 'default'], defaultBackgroundName: 'default' };
    const promise = h.api.chooseBackground(meta), sheet = h.sheets[0];
    if (close === 'cancel') sheet.querySelector('[data-default]').onclick();
    if (close === 'backdrop') sheet.guard('backdrop');
    if (close === 'Escape') h.document.emit('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    if (close === 'back') h.window.emit('popstate');
    assert.equal(await promise, 'default'); assert.equal(sheet.isConnected, false);
    assert.equal(h.document.count('keydown'), 0); assert.equal(h.window.count('popstate'), 0);
    assert.equal(meta.defaultBackgroundName, 'default');
});

test('choosing a temporary background never changes the saved default', async () => {
    const h = harness(), meta = { backgroundNames: ['a', 'b'], defaultBackgroundName: 'b' };
    const result = h.api.chooseBackground(meta); h.sheets[0].querySelectorAll('[data-choice]')[0].onclick();
    assert.equal(await result, 'a'); assert.equal(meta.defaultBackgroundName, 'b');
});

test('background editor appends uniquely, changes the default and falls back after deletion', () => {
    const h = harness(), meta = { backgroundName: 'a' }; let changes = 0;
    h.api.editBackgrounds(meta, () => changes++); const sheet = h.sheets[0];
    sheet.querySelector('[data-add]').onclick(); h.opts.onPick('b'); h.opts.onPick('b');
    assert.deepEqual(clone(meta.backgroundNames), ['a', 'b']);
    const click = dataset => sheet.onclick({ target: { closest: () => ({ dataset, hasAttribute: name => name === 'data-default' && Object.hasOwn(dataset, 'default') }) } });
    click({ default: '1' }); assert.equal(meta.backgroundName, 'b');
    click({ remove: '1' }); assert.equal(meta.backgroundName, 'a');
    click({ remove: '0' }); assert.equal(meta.backgroundName, ''); assert.equal(changes, 4);
});

test('switching enables bound scripts, keeps shared scripts on, and restores original states', async () => {
    const original = fixtures(), h = harness({ trees: original, data: themeData() });
    await h.api.sync('A'); assert.equal(h.trees()[1].enabled, true); assert.equal(script(h, 'a').enabled, true);
    assert.equal(script(h, 'b').enabled, false); assert.equal(script(h, 'already-on').enabled, true);
    await h.api.sync('B'); assert.equal(script(h, 'a').enabled, true); assert.equal(script(h, 'b').enabled, true);
    await h.api.sync('none'); assert.deepEqual(h.trees(), original);
    assert.ok(h.logs.some(item => item.details.status === 'enabled-state-only'));
});

test('manual disabled states are protected for both previously-on and manager-enabled scripts', async () => {
    const h = harness({ trees: fixtures(), data: themeData() }); await h.api.sync('A');
    script(h, 'a').enabled = false; script(h, 'already-on').enabled = false;
    await h.tick(); await h.api.sync('A');
    assert.equal(script(h, 'a').enabled, false); assert.equal(script(h, 'already-on').enabled, false);
    await h.api.sync('none'); assert.equal(script(h, 'already-on').enabled, false);
    await h.api.sync('A'); assert.equal(script(h, 'a').enabled, true); // New entry can take ownership again.
});

test('enabling an unbound script manually protects the folder from being restored off', async () => {
    const h = harness({ trees: fixtures(), data: themeData() }); await h.api.sync('A');
    script(h, 'other').enabled = true; await h.tick(); await h.api.sync('none');
    assert.equal(h.trees()[1].enabled, true); assert.equal(script(h, 'other').enabled, true);
    assert.equal(script(h, 'a').enabled, false);
});

test('missing target folder is reported and previous managed scripts are restored', async () => {
    const data = themeData(); data.themeMeta.missing = { scriptBinding: { folderId: 'gone', scripts: [{ id: 'x', name: 'x' }] } };
    const h = harness({ trees: fixtures(), data }); await h.api.sync('A'); await h.api.sync('missing');
    assert.equal(script(h, 'a').enabled, false); assert.equal(h.trees()[1].enabled, false);
    assert.ok(h.logs.some(item => !item.success && item.details.missing?.length)); assert.equal(h.messages.length, 1);
});

test('missing helper never rejects theme completion and existing bindings can still be cleared', async () => {
    const h = harness({ helper: false, data: themeData() }); await assert.doesNotReject(h.api.sync('A'));
    assert.equal(h.logs.at(-1).success, false); let changed = 'unchanged';
    await h.api.editScripts(binding('a'), value => { changed = value; });
    h.sheets.at(-1).querySelector('[data-clear]').onclick(); assert.equal(changed, null);
});

test('stale requests are skipped and queued requests leave the latest binding active', async () => {
    const h = harness({ trees: fixtures(), data: themeData() });
    await h.api.sync('A', () => false); assert.equal(h.updates(), 0);
    await Promise.all([h.api.sync('A'), h.api.sync('B')]);
    assert.equal(script(h, 'a').enabled, true); assert.equal(script(h, 'b').enabled, true);
    await h.api.sync('none'); assert.equal(h.trees()[1].enabled, false);
});

test('failed helper writes do not lose ownership needed for a later restoration', async () => {
    const h = harness({ trees: fixtures(), data: themeData() }); await h.api.sync('A');
    h.reject(true); await assert.doesNotReject(h.api.sync('B')); h.reject(false);
    await h.api.sync('none'); assert.deepEqual(h.trees(), fixtures());
});

test('enabled state is read back and an ignored write is reported as a failure', async () => {
    const h = harness({ trees: fixtures(), data: themeData() }); h.ignore(true); await h.api.sync('A');
    assert.equal(h.logs.at(-1).success, false); assert.ok(h.logs.at(-1).details.missing.some(item => item.includes('开关未生效')));
});

test('ownership survives a refresh in the same browser session', async () => {
    const h = harness({ trees: fixtures(), data: themeData() }); await h.api.sync('A');
    const refreshed = harness({ trees: h.trees(), data: themeData(), session: h.session });
    await refreshed.api.sync('none'); assert.deepEqual(refreshed.trees(), fixtures());
});

test('background runtime applies default, temporary override, common fallback and supersession', async () => {
    const data = { themeMeta: { A: { backgroundNames: ['a', 'b'], defaultBackgroundName: 'b' }, none: {} }, commonBackgroundName: 'common' };
    const h = harness({ data }); vm.runInContext(moduleSource('26'), h.context);
    const bg = { background_settings: {} }; const element = { style: {} }; let saved = 0;
    h.document.getElementById = id => id === 'bg1' ? element : null;
    const runtime = h.ns.createBackgrounds({ ...h.opts, load: () => data, save() { saved++; }, setControlValue() {}, themeRuntime: { isApplyCurrent: () => true }, loadBackgroundModules: () => Promise.resolve([bg, { saveSettingsDebounced() {} }]) });
    const apply = (name, override, isCurrent) => new Promise(resolve => runtime.applyBoundBackground(name, (ok, reason) => resolve({ ok, reason }), isCurrent, override));
    await apply('A'); assert.equal(bg.background_settings.name, 'b');
    await apply('A', 'a'); assert.equal(bg.background_settings.name, 'a'); assert.equal(data.themeMeta.A.defaultBackgroundName, 'b');
    await apply('none'); assert.equal(bg.background_settings.name, 'common');
    assert.equal((await apply('A', 'b', () => false)).reason, 'superseded'); assert.equal(bg.background_settings.name, 'common');
    h.window.emit('theme-manager-background-deleted', { detail: { name: 'b' } }); await Promise.resolve();
    assert.deepEqual(clone(data.themeMeta.A.backgroundNames), ['a']); assert.equal(data.themeMeta.A.backgroundName, 'a'); assert.equal(saved, 1);
    h.window.emit('theme-manager-background-deleted', { detail: { name: 'a' } }); await Promise.resolve();
    assert.equal(data.themeMeta.A.backgroundName, ''); await apply('A'); assert.equal(bg.background_settings.name, 'common');
});

test('day/night assets remain independent and editor dirty checking includes binding changes', () => {
    const h = harness(); vm.runInContext(moduleSource('08'), h.context);
    const snapshot = { variants: { day: { backgroundNames: ['day'], scriptBinding: binding('a') }, night: { backgroundNames: ['night'], scriptBinding: binding('b') } } };
    const session = h.ns.editorDraft.createSession(snapshot); assert.equal(session.isDirty(snapshot), false);
    snapshot.variants.day.backgroundNames.push('day-2'); assert.equal(session.isDirty(snapshot), true);
    assert.deepEqual(snapshot.variants.night.backgroundNames, ['night']);
    const ticket = session.beginSave(snapshot); snapshot.variants.day.scriptBinding.scripts.push({ id: 'b' });
    assert.equal(ticket.snapshot.variants.day.scriptBinding.scripts.length, 1);
});


function wireMain(h) {
    const operations = [];
    let requestId = 0;
    const runtime = {
        applyThemeAndWait(name) { operations.push(['theme', name]); requestId++; return Promise.resolve({ requestId }); },
        isApplyCurrent(id) { return id === requestId; },
    };
    Object.assign(h.context, {
        themeRuntime: runtime, themeAssetsApi: h.api, manualBackgroundIntent: 0,
        pendingVerifiedManualThemes: Object.create(null), bindingController: null, avatarRuntime: null,
        scheduleManagerAppearanceSync() {},
        getCurrentThemeName() { return operations.filter(op => op[0] === 'theme').at(-1)?.[1] || ''; },
        peekMeta(data, name) { return data.themeMeta[name] || {}; }, load: () => h.data,
        backgroundsApi: {
            finishApplyTheme(name, cb, ok, id, selected) { operations.push(['background', name, selected]); cb(ok); },
        },
    });
    const begin = source.indexOf('    function applyTheme(themeName, cb, selectedBackground)');
    const end = source.indexOf('    function handleBindingApplyError', begin);
    vm.runInContext(source.slice(begin, end), h.context);
    const finish = source.indexOf('    function finishApplyTheme(themeName, cb, ok, requestId, selectedBackground)');
    // The first match includes the backgrounds module's function. Select the main wrapper explicitly.
    const mainFinish = source.indexOf('    function finishApplyTheme(themeName, cb, ok, requestId, selectedBackground) {\n        return backgroundsApi', finish);
    vm.runInContext(source.slice(mainFinish, source.indexOf('    function setThemeControlValue', mainFinish)), h.context);
    return { operations, apply: (name, manual = true) => new Promise(resolve => {
        h.context[manual ? 'applyManualTheme' : 'applyTheme'](name, (ok, reason) => resolve({ ok, reason }));
    }) };
}

test('main switching waits for the picker, then cancellation continues through theme, background and scripts', async () => {
    const data = themeData(); data.themeMeta.A.backgroundNames = ['first', 'default']; data.themeMeta.A.defaultBackgroundName = 'default';
    const h = harness({ trees: fixtures(), data }), main = wireMain(h);
    const result = main.apply('A'); assert.equal(main.operations.length, 0);
    h.sheets[0].guard('backdrop'); assert.equal((await result).ok, true);
    assert.deepEqual(main.operations, [['theme', 'A'], ['background', 'A', 'default']]);
    assert.equal(script(h, 'a').enabled, true);
    const sheetsBefore = h.sheets.length; await main.apply('B', false);
    assert.equal(h.sheets.length, sheetsBefore); assert.equal(script(h, 'b').enabled, true);
});

test('an automatic switch supersedes an older pending manual background choice', async () => {
    const data = themeData(); data.themeMeta.A.backgroundNames = ['a', 'b'];
    const h = harness({ trees: fixtures(), data }), main = wireMain(h);
    const pending = main.apply('A'); await main.apply('B', false);
    h.sheets[0].querySelector('[data-default]').onclick(); assert.equal((await pending).reason, 'superseded');
    assert.deepEqual(main.operations.map(op => op[1]), ['B', 'B']); assert.equal(script(h, 'b').enabled, true);
});

test('a missing helper reports partial script failure while the main theme switch succeeds', async () => {
    const h = harness({ data: themeData(), helper: false }), main = wireMain(h);
    const result = await main.apply('A'); assert.equal(result.ok, true); assert.equal(result.reason, 'scripts-failed');
    assert.equal(main.operations[0][0], 'theme'); assert.equal(main.operations[1][0], 'background');
});

test('an empty script selection does not require an installed helper', async () => {
    const h = harness({ helper: false, data: { themeMeta: { A: { scriptBinding: binding() } } } });
    const result = await h.api.sync('A'); assert.equal(result.ok, true); assert.equal(h.messages.length, 0);
});

test('script picker uses folder IDs, leaves ambiguous same-name folders unselected and preserves renamed bindings', async () => {
    const first = fixtures()[1], second = { ...clone(first), id: 'second' };
    const h = harness({ trees: [first, second] }); let changed;
    await h.api.editScripts(null, value => { changed = value; });
    const sheet = h.sheets[0]; assert.equal(sheet.querySelector('[data-folder]').value, '');
    sheet.querySelector('[data-folder]').value = 'second'; sheet.querySelector('[data-folder]').onchange();
    const input = sheet.querySelectorAll('[data-script]')[0]; input.checked = true; input.onchange();
    assert.equal(changed.folderId, 'second'); assert.equal(changed.scripts[0].id, 'a');
    const renamed = harness({ trees: [{ ...first, name: 'renamed' }] });
    await renamed.api.editScripts(binding('a'), () => {});
    assert.equal(renamed.sheets[0].querySelector('[data-folder]').value, 'folder');
});

test('dedicated folder creation is explicit and never duplicates an existing folder', async () => {
    const h = harness(); await h.api.editScripts(null, () => {}); assert.equal(h.trees().length, 0);
    await h.sheets[0].querySelector('[data-create-folder]').onclick();
    assert.equal(h.trees().length, 1); assert.equal(h.trees()[0].name, '美化脚本'); assert.equal(h.trees()[0].enabled, false);
    await h.api.editScripts(null, () => {}); assert.equal(h.sheets.at(-1).querySelector('[data-create-folder]'), null);
});

test('successful native background deletion emits a binding update, rejected deletion does not', async () => {
    let response = { ok: true, status: 200 }; const received = [];
    const window = Object.assign(events(), { document: { getElementById: () => null }, location: { href: 'http://localhost:8000/' }, fetch: async () => response });
    window.dispatchEvent = event => window.emit(event.type, event);
    window.addEventListener('theme-manager-background-deleted', event => received.push(event.detail.name));
    const context = vm.createContext({ window, performance, URL, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
    vm.runInContext(source.slice(0, source.indexOf('// GENERATED FILE')), context);
    const options = { method: 'POST', body: JSON.stringify({ bg: 'deleted.png' }) };
    await window.fetch('/api/backgrounds/delete', options); assert.deepEqual(received, ['deleted.png']);
    response = { ok: false, status: 500 }; await window.fetch('/api/backgrounds/delete', options);
    assert.deepEqual(received, ['deleted.png']);
});


test('theme bundle export preserves ordered backgrounds, the default and script references without sharing mutable data', () => {
    const h = harness();
    const start = source.indexOf('    function cleanThemeMetaForBundle(');
    Object.assign(h.context, { cloneJson: clone });
    vm.runInContext(source.slice(start, source.indexOf('    function buildThemeMetaForBundle', start)), h.context);
    const original = { backgroundNames: ['a', 'b'], defaultBackgroundName: 'b', backgroundName: 'b', scriptBinding: binding('a', 'b') };
    const bundled = h.context.cleanThemeMetaForBundle(original);
    const imported = h.ns.themeAssets.merge({}, clone(bundled));
    assert.deepEqual(clone(imported.backgroundNames), ['a', 'b']); assert.equal(imported.backgroundName, 'b');
    bundled.scriptBinding.scripts[0].name = 'changed'; assert.equal(original.scriptBinding.scripts[0].name, 'a');
});

test('background annotation export/import round-trips a pool and keeps legacy single-background files compatible', async () => {
    const h = harness({ data: { themeMeta: { A: { backgroundNames: ['a', 'b'], defaultBackgroundName: 'b', backgroundName: 'b' } } } });
    let exported, imported, input, saves = 0;
    Object.assign(h.context, {
        load: () => h.data, cloneJson: clone,
        downloadJsonBlob(name, value) { exported = clone(value); }, toast() {},
        document: { createElement() { input = { files: [{}], click() {} }; return input; } },
        readJsonFile: async () => ({ data: imported }), save() { saves++; }, refreshBackgroundPage() {},
    });
    let start = source.indexOf('    function exportBackgroundAnnotations()');
    vm.runInContext(source.slice(start, source.indexOf('    function openBackgroundSettingsSheet()', start)), h.context);
    h.context.exportBackgroundAnnotations(); assert.equal(exported.themeBindings.A, 'b');
    assert.deepEqual(exported.themeBackgroundPools.A.backgroundNames, ['a', 'b']);
    h.data.themeMeta = {}; imported = exported;
    h.context.importBackgroundAnnotations(); input.onchange();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(saves, 1); assert.deepEqual(clone(h.data.themeMeta.A.backgroundNames), ['a', 'b']); assert.equal(h.data.themeMeta.A.backgroundName, 'b');
    imported = { type: 'theme-manager-background-annotations', version: 1, themeBindings: { legacy: 'old.png' } };
    h.context.importBackgroundAnnotations(); input.onchange();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(clone(h.data.themeMeta.legacy.backgroundNames), ['old.png']);
});


test('card switch confirmation includes the display name and respects confirm or cancel', () => {
    const h = harness(); const prompts = []; let accepted = false;
    h.window.confirm = message => { prompts.push(message); return accepted; };
    h.context.global = h.window;
    const start = source.indexOf('    function confirmThemeSwitch(displayName)');
    vm.runInContext(source.slice(start, source.indexOf('    function applyManualTheme(', start)), h.context);
    assert.equal(h.context.confirmThemeSwitch('测试美化'), false);
    accepted = true; assert.equal(h.context.confirmThemeSwitch('测试美化'), true);
    assert.ok(prompts.every(message => message.includes('测试美化')));
    assert.ok(source.includes('if (!confirmThemeSwitch(item.name || themeName)) return;\n            applyManualTheme(themeName'));
});
