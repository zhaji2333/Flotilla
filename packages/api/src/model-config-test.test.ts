import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelConfigTestSchema, describeProbeFailure, redactSecret } from './model-config-test.js';

test('draft probe requires baseUrl, modelName and apiKey', () => {
  assert.equal(ModelConfigTestSchema.safeParse({}).success, false);
  assert.equal(ModelConfigTestSchema.safeParse({ baseUrl: 'https://gw.example/v1' }).success, false);
  assert.equal(
    ModelConfigTestSchema.safeParse({ baseUrl: 'https://gw.example/v1', modelName: 'm' }).success,
    false,
  );
  assert.equal(
    ModelConfigTestSchema.safeParse({ baseUrl: 'https://gw.example/v1', modelName: 'm', apiKey: 'k' }).success,
    true,
  );
});

test('stored probe only needs an id and inherits the saved settings', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(ModelConfigTestSchema.safeParse({ id }).success, true);
  assert.equal(ModelConfigTestSchema.safeParse({ id, modelName: 'override' }).success, true);
  assert.equal(ModelConfigTestSchema.safeParse({ id, baseUrl: 'ftp://gw' }).success, false);
  assert.equal(ModelConfigTestSchema.safeParse({ id, unexpected: true }).success, false);
});

test('redactSecret removes the provider key from upstream text', () => {
  const secret = 'sk-test-secret-value-123';
  assert.equal(redactSecret(`bad key ${secret} rejected`, secret), 'bad key *** rejected');
  // Short/absent secrets are left alone rather than corrupting the message.
  assert.equal(redactSecret('plain message', 'ab'), 'plain message');
  assert.equal(redactSecret('plain message', undefined), 'plain message');
});

test('describeProbeFailure explains gateway failures', () => {
  assert.match(describeProbeFailure(403, 'MODEL_ACCESS_DENIED', '当前模型仅对灰度用户开放'), /鉴权\/权限失败.*灰度/);
  assert.match(describeProbeFailure(401, '', ''), /鉴权\/权限失败/);
  assert.match(describeProbeFailure(404, '', '接口不存在'), /接口或模型不存在/);
  assert.match(describeProbeFailure(429, '', 'too many'), /限流/);
  assert.match(describeProbeFailure(502, '', ''), /上游服务异常/);
  assert.equal(describeProbeFailure(null, '', 'boom'), 'boom');
});
