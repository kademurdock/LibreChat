import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = readFileSync(new URL('./ConversationMode.tsx', import.meta.url), 'utf8');
const overlayStart = source.indexOf('  // -- Call overlay');
const overlay =
  'function CallOverlay() {' + source.slice(source.indexOf('  return (', overlayStart));
const handlerStart = source.indexOf('  const onDialogKeyDown =');
const handler = source.slice(handlerStart, source.indexOf('  };', handlerStart) + 4);
const compile = (input) =>
  ts.transpileModule(input, {
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
  }).outputText;

function dialog(appearance = true, notices = false) {
  let ended = 0;
  const ref = { current: null };
  const noop = () => {};
  const values = {
    React,
    dialogRef: ref,
    onDialogKeyDown: noop,
    cn: (...parts) => parts.filter(Boolean).join(' '),
    srStatus: 'Speaking',
    error: '',
    orbRef: ref,
    preparedCallPortrait: true,
    liveMode: !appearance,
    avatarUrl: '',
    ringClass: '',
    backgroundClass: '',
    portraitCanvasRef: ref,
    status: 'speaking',
    appearanceKey: appearance ? 'angel' : null,
    localize: (key) => key,
    visibleStatus: 'Speaking',
    videoInfo: '',
    videoNotice: notices ? { text: 'Camera notice', mode: 'hq' } : null,
    videoConfirmRef: ref,
    requestVideo: noop,
    liveNotice: notices ? 'Spotter notice' : null,
    liveConfirmRef: ref,
    streamingEngine: { sendJson: noop },
    liveTable: null,
    transcript: '',
    aiText: '',
    interruptAI: noop,
    streamingRef: { current: true },
    videoMode: 'off',
    torchAvailable: false,
    endCall: () => {
      ended++;
    },
    interruptionHelp: 'Interrupt',
  };
  for (const icon of [
    'Mic',
    'Phone',
    'Radio',
    'StopCircle',
    'Camera',
    'CameraOff',
    'SwitchCamera',
    'Flashlight',
    'FlashlightOff',
    'PhoneOff',
  ])
    values[icon] = () => React.createElement('svg', { 'aria-hidden': true });
  const render = new Function(...Object.keys(values), compile(overlay) + ';return CallOverlay;')(
    ...Object.values(values),
  );
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(render)));
  const surface = dom.window.document.querySelector('[role="dialog"]');
  ref.current = surface;
  const keydown = new Function(
    'dialogRef',
    'endCall',
    'document',
    compile(handler) + ';return onDialogKeyDown;',
  )(ref, values.endCall, dom.window.document);
  surface.addEventListener('keydown', keydown);
  return {
    dom,
    surface,
    ended: () => ended,
    press(key, shiftKey = false) {
      const event = new dom.window.KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      dom.window.document.activeElement.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

for (const notices of [false, true]) {
  test(`actual rendered call overlay includes appearance summary at both focus boundaries (notices ${notices})`, () => {
    const view = dialog(true, notices),
      doc = view.dom.window.document;
    const nodes = [...view.surface.querySelectorAll('summary, button:not([disabled])')];
    const first = nodes[0],
      last = nodes.at(-1);
    assert.equal(first.tagName, 'SUMMARY');
    assert.equal(last.getAttribute('aria-label'), 'End voice conversation');
    view.surface.focus();
    assert.equal(view.press('Tab'), true);
    assert.equal(doc.activeElement, first);
    assert.equal(view.press('Tab', true), true);
    assert.equal(doc.activeElement, last);
    assert.equal(view.press('Tab'), true);
    assert.equal(doc.activeElement, first);
    nodes[1].focus();
    assert.equal(view.press('Tab', true), false);
    view.dom.window.close();
  });
}

test('fallback call without an appearance summary still traps its controls and permits Escape', () => {
  const view = dialog(false),
    doc = view.dom.window.document;
  const nodes = [...view.surface.querySelectorAll('button:not([disabled])')];
  view.surface.focus();
  view.press('Tab');
  assert.equal(doc.activeElement, nodes[0]);
  view.press('Tab', true);
  assert.equal(doc.activeElement, nodes.at(-1));
  view.press('Tab');
  assert.equal(doc.activeElement, nodes[0]);
  assert.equal(view.press('Escape'), true);
  assert.equal(view.ended(), 1);
  view.dom.window.close();
});
