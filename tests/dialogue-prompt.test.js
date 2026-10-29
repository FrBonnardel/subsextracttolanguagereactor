import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLlmOutput, dialogueSystemPrompt } from '../extension/shared/dialogue-prompt.js';

test('system prompt names the target language', () => {
  assert.match(dialogueSystemPrompt('en'), /natural, idiomatic English subtitles/);
  assert.match(dialogueSystemPrompt('fr'), /natural, idiomatic French subtitles/);
});

test('cleanLlmOutput strips reasoning, labels and wrapping quotes', () => {
  assert.equal(cleanLlmOutput('<think>hmm</think>\n  "Hold on a bit longer."  '), 'Hold on a bit longer.');
  assert.equal(cleanLlmOutput('Translation: Dawn is almost here.'), 'Dawn is almost here.');
  assert.equal(cleanLlmOutput('“Leave the rest to me.”'), 'Leave the rest to me.');
  assert.equal(cleanLlmOutput('He said "no".'), 'He said "no".');
});
