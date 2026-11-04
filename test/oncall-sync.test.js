const test = require('node:test'), assert = require('node:assert/strict');
const { syncOnce } = require('../src/oncall-sync');

function fakePhone(handlerId) {
  const patches = [];
  let current = handlerId;
  return {
    patches,
    phone: {
      ready: true,
      list: async () => [{ id: 9, name: 'On Call Plumber' }],
      get: async () => ({ id: 9, name: 'On Call Plumber', timeout_handler: { id: current } }),
      patch: async (r, id, body) => { patches.push({ r, id, body }); current = body.timeout_handler.id; return {}; },
    },
  };
}
const cal = (...people) => async () => ({ connected: true, current: people.map(p => ({ person: p, title: `${p} On Call` })), upcoming: [] });
const EDGAR = 13177454, CINDY = 12587515;

test('match: nothing posted or changed', async () => {
  const { phone, patches } = fakePhone(EDGAR), posts = [];
  const out = await syncOnce({ phone, oncall: cal('Edgar'), post: async t => posts.push(t), state: {}, syncMode: 'report' });
  assert.equal(out.action, 'ok');
  assert.equal(posts.length, 0);
  assert.equal(patches.length, 0);
});

test('report mode: a mismatch seen twice is posted once and never changes Phone.com', async () => {
  const { phone, patches } = fakePhone(EDGAR), posts = [], state = {};
  const run = () => syncOnce({ phone, oncall: cal('Cindy'), post: async t => posts.push(t), state, syncMode: 'report' });
  assert.equal((await run()).action, 'wait');
  assert.equal(posts.length, 0);
  await run(); await run();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /report only.*Cindy.*Edgar \(ext 507\).*Nothing was changed/);
  assert.equal(patches.length, 0);
});

test('live mode: switches after the second check and confirms', async () => {
  const { phone, patches } = fakePhone(EDGAR), posts = [], state = {};
  const run = () => syncOnce({ phone, oncall: cal('Cindy'), post: async t => posts.push(t), state, syncMode: 'live' });
  await run();
  assert.equal(patches.length, 0);
  const out = await run();
  assert.equal(out.action, 'switched');
  assert.deepEqual(patches[0], { r: 'menus', id: 9, body: { timeout_handler: { id: CINDY } } });
  assert.match(posts[0], /changed to: Cindy \(was Edgar/);
  assert.equal((await run()).action, 'ok');
});

test('unclear calendar leaves Phone.com alone and says why once', async () => {
  for (const [oncall, re] of [[cal(), /nobody is on the calendar/], [cal('Edgar', 'Cindy'), /Edgar and Cindy on call at the same time/], [async () => ({ connected: true, current: [{ person: null, title: 'Office closed' }] }), /doesn’t name a TPS plumber/]]) {
    const { phone, patches } = fakePhone(EDGAR), posts = [], state = {};
    await syncOnce({ phone, oncall, post: async t => posts.push(t), state, syncMode: 'live' });
    await syncOnce({ phone, oncall, post: async t => posts.push(t), state, syncMode: 'live' });
    assert.equal(posts.length, 1);
    assert.match(posts[0], re);
    assert.equal(patches.length, 0);
  }
});

test('off mode and missing connections do nothing', async () => {
  assert.equal((await syncOnce({ syncMode: 'off' })).action, 'off');
  assert.equal((await syncOnce({ phone: { ready: false }, syncMode: 'report' })).action, 'skip');
  assert.equal((await syncOnce({ phone: { ready: true }, oncall: async () => ({ connected: false }), syncMode: 'report' })).action, 'skip');
});
