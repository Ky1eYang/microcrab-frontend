// One-off real Server acceptance; starts no service and mocks no routes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const ready = JSON.parse(await readFile(process.argv[2], 'utf8'));
const origin = new URL(ready.url).origin;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const attachments = [], commands = [];
  page.on('request', request => {
    const match = new URL(request.url()).pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/runtime$/);
    if (match && request.method() === 'PUT') commands.push({ method: 'session.open', session_id: decodeURIComponent(match[1]) });
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
    if (frame.type !== 'command') return;
    commands.push(frame);
    if (frame.method === 'conversation.attach') attachments.push(frame.params);
  }));
  const login = new URL(ready.login_url, origin);
  assert.equal(login.origin, origin);
  login.searchParams.set('login_hint', 'alice');
  await page.goto(login.href, { waitUntil: 'domcontentloaded' });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible({ timeout: 30000 });
  const pill = page.getByTestId('composer-agent-pill');
  await expect(pill).toBeEnabled({ timeout: 90000 });
  assert.ok(attachments.length, 'Default browser workspace must attach to the actual Server');
  const attachment = attachments.at(-1);
  assert.ok(attachment.descriptor.info.description.includes('wasmsh'), 'Current Host-authored description must cross the real attachment boundary');
  const catalog = await page.evaluate(async id => {
    const response = await fetch('/api/v1/conversations/' + encodeURIComponent(id) + '/agents');
    if (!response.ok) throw Error('Real catalog failed: ' + response.status);
    return response.json();
  }, attachment.conversation_id);
  assert.ok(catalog.items.some(agent => agent.name === 'coding'));
  assert.ok(catalog.items.some(agent => agent.name === 'universal' && agent.modes.some(mode => mode.name === 'execute')));
  await pill.click();
  await page.getByRole('menuitem', { name: 'universal', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'execute', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('after-restart');
  await page.getByTitle('发送 (Enter)').click();
  await expect(page.getByText('canonical:after-restart', { exact: true })).toBeVisible({ timeout: 90000 });
  const id = new URL(page.url()).hash.match(/^#session\/([^/]+)$/)?.[1];
  assert.ok(id);
  const snapshot = await page.evaluate(async id => (await fetch('/api/v1/sessions/' + encodeURIComponent(id))).json(), id);
  assert.equal(snapshot.session.agent, 'universal');
  assert.equal(snapshot.session.project_id, null);
  assert.notEqual(snapshot.session.agent_initialization_deferred, true);
  assert.notEqual(snapshot.session.agent_init_retry_required, true);
  const bind = commands.findIndex(frame => frame.method === 'client_tools.bind' && frame.session_id === id);
  const opened = commands.findIndex(frame => frame.method === 'session.open' && frame.session_id === id);
  assert.ok(bind >= 0 && opened > bind);
  console.log(JSON.stringify({ result: 'passed', realAttachWithDescription: true, codingAndUniversalCatalog: true, universalInitializationAndTurn: true, projectless: true, executorBoundBeforeOpen: true }));
} finally { await browser.close(); }
