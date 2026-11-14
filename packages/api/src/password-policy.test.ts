import assert from 'node:assert/strict';
import test from 'node:test';
import { PASSWORD_MIN_LENGTH, passwordIsStrong, passwordPolicyMessage, passwordViolations } from './password-policy.js';

test('accepts a 12-character password with every character class', () => {
  assert.equal(passwordIsStrong('Str0ng!Passw'), true);
  assert.deepEqual(passwordViolations('Str0ng!Passw'), []);
});

test('rejects the bootstrap password', () => {
  const codes = passwordViolations('admin123').map(violation => violation.code);
  assert.ok(codes.includes('too_short'));
  assert.ok(codes.includes('uppercase'));
  assert.ok(codes.includes('special'));
  assert.equal(passwordIsStrong('admin123'), false);
});

test('reports each missing character class', () => {
  const eleven = 'Ab1!abcdxyz';
  assert.equal(eleven.length, PASSWORD_MIN_LENGTH - 1);
  assert.deepEqual(passwordViolations(eleven).map(v => v.code), ['too_short']);

  assert.deepEqual(passwordViolations('ABCDEFGH!123').map(v => v.code), ['lowercase']);
  assert.deepEqual(passwordViolations('abcdefgh!123').map(v => v.code), ['uppercase']);
  assert.deepEqual(passwordViolations('Abcdefgh!xyz').map(v => v.code), ['digit']);
  assert.deepEqual(passwordViolations('Abcdefgh1234').map(v => v.code), ['special']);
});

test('rejects overlong input and exposes a policy message', () => {
  assert.deepEqual(passwordViolations(`Aa1!${'x'.repeat(500)}`).map(v => v.code), ['too_long']);
  assert.match(passwordPolicyMessage(), /12 位/);
});
