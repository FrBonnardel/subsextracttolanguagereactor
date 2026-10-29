import assert from 'node:assert/strict';
import test from 'node:test';
import story from '../extension/sidepanel/sections/story.js';
import { createBus } from '../extension/sidepanel/core.js';

test('story section is collapsed and loads existing context, then follows live updates', async () => {
  const bus = createBus();
  const children = [];
  const root = { append: (...nodes) => children.push(...nodes) };
  const el = (tag, cls, text = '') => ({ textContent: text });
  let resolve;
  globalThis.chrome = { tabs: { sendMessage: async (id, msg) => {
    assert.equal(id, 12);
    assert.equal(msg.type, 'HSR_GET_STORY_CONTEXT');
    return new Promise((r) => { resolve = r; });
  } } };
  globalThis.HSR_log = () => {};
  assert.equal(story.open, false);
  story.mount(root, { bus, el });
  bus.emit('tab', { id: 12 });
  resolve({ enabled: true, text: 'Video title: Example' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(children[1].textContent, 'Video title: Example');
  bus.emit('story', { enabled: true, text: 'Wikipedia synopsis: Example' });
  assert.equal(children[1].textContent, 'Wikipedia synopsis: Example');
  bus.emit('episode', {});
  assert.equal(children[1].textContent, '');
  bus.emit('story', { enabled: false, text: '' });
  assert.match(children[0].textContent, /disabled/);
});

test('a late tab snapshot does not overwrite a newer context event', async () => {
  const bus = createBus();
  const children = [];
  let resolve;
  globalThis.chrome = { tabs: { sendMessage: () => new Promise((r) => { resolve = r; }) } };
  story.mount({ append: (...nodes) => children.push(...nodes) }, {
    bus, el: (tag, cls, text = '') => ({ textContent: text }),
  });
  bus.emit('tab', { id: 1 });
  bus.emit('story', { enabled: true, text: 'New episode' });
  resolve({ enabled: true, text: 'Old episode' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(children[1].textContent, 'New episode');
});
