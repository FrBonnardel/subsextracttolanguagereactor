import assert from 'node:assert/strict';
import test from 'node:test';
import { stripFinalPeriod } from '../extension/background/translate.js';

test('translations drop a closing full stop but keep ?, ! and ellipses', () => {
  assert.equal(stripFinalPeriod("It's daytime now."), "It's daytime now");
  assert.equal(stripFinalPeriod('好的。'), '好的');
  assert.equal(stripFinalPeriod('He said "go."'), 'He said "go"');
  assert.equal(stripFinalPeriod('Why?'), 'Why?');
  assert.equal(stripFinalPeriod('Alright!'), 'Alright!');
  assert.equal(stripFinalPeriod('Wait...'), 'Wait...');
  assert.equal(stripFinalPeriod('Hold on…'), 'Hold on…');
  assert.equal(stripFinalPeriod('Dr. Who'), 'Dr. Who');
});
