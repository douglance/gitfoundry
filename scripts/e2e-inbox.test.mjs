import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { signInCode } from './e2e-inbox/worker.mjs';

// Email Sending delivers with the bounce address as envelope sender and login@ in the From header.
const message = (overrides = {}) => ({ from: 'bounces@cf-bounce.gitfoundry.dev', to: 'e2e@gitfoundry.dev', headers: new Headers({ from: 'login@gitfoundry.dev', subject: '482913 is your GitFoundry sign-in code' }), ...overrides });

test('keeps only GitFoundry sign-in codes sent to the test address', () => {
  assert.equal(signInCode(message(), 'e2e@gitfoundry.dev'), '482913');
  assert.equal(signInCode(message({ headers: new Headers({ from: 'GitFoundry <login@gitfoundry.dev>', subject: '482913 is your GitFoundry sign-in code' }) }), 'e2e@gitfoundry.dev'), '482913');
  assert.equal(signInCode(message({ from: 'someone@example.com' }), 'e2e@gitfoundry.dev'), null);
  assert.equal(signInCode(message({ headers: new Headers({ from: 'someone@example.com', subject: '482913 is your GitFoundry sign-in code' }) }), 'e2e@gitfoundry.dev'), null);
  assert.equal(signInCode(message({ to: 'owner@gitfoundry.dev' }), 'e2e@gitfoundry.dev'), null);
  assert.equal(signInCode(message({ headers: new Headers({ subject: 'Your invoice 482913' }) }), 'e2e@gitfoundry.dev'), null);
});

test('stores a received code and rejects everything else', async () => {
  const rows = [], rejected = [];
  const env = { E2E_ADDRESS: 'e2e@gitfoundry.dev', INBOX: { prepare: sql => ({ bind: (...values) => ({ run: async () => { rows.push({ sql, values }); } }) }) } };
  await worker.email(message(), env);
  await worker.email({ ...message({ from: 'spam@example.com' }), setReject: reason => rejected.push(reason) }, env);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].values.slice(0, 2), ['e2e@gitfoundry.dev', '482913']);
  assert.equal(rejected.length, 1);
});
