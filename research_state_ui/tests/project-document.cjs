/** Browser regression check against a running Vite dev server.
 * Install playwright in a temporary directory, then run with NODE_PATH pointing
 * at its node_modules. MERV_UI_URL defaults to http://127.0.0.1:5197/merv/.
 * All API responses are fixtures; this never contacts a production backend.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = process.env.MERV_UI_URL || 'http://127.0.0.1:5197/merv/';
const output = process.env.MERV_UI_SCREENSHOTS || '/tmp/merv-ui-verification';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      if (width === 320) await page.addInitScript(() => localStorage.setItem('rsui:theme', 'dark'));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const project = { id: 'proj_document', name: 'Efficient language models', summary: 'Reduce inference cost while preserving model quality.\nScope: reproducible small-model experiments.',
        settings: {}, literature: { body: 'Prior work suggests **shared projections** can reduce memory. Quality tradeoffs remain uncertain.' },
        methods: '### Established approach\nWe compared shared projections against the baseline under identical evaluation.\n\n### Currently trying\nA wider-rank replication is ongoing and unreviewed.',
        results: '### Evidence so far\nThe first run did **not** improve quality. A lower memory footprint was observed.\n\n### Limitations\nOne seed; the result does not establish a general improvement.',
        references: [{ kind: 'experiment', id: 'exp_baseline', label: 'Shared projection baseline', status: 'completed' }, { kind: 'reflection', id: 'syn_wave', label: 'First reflection', status: 'consolidating' }, { kind: 'artifact', id: 'art_report', label: 'Evaluation report' }],
        maintenance: { state: 'writing', pending: true } };
      let failSave = false;
      let holdSave = null;
      const writes = [];
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) {
          const body = route.request().postDataJSON(); writes.push(body);
          if (holdSave) await holdSave;
          if (failSave) return route.fulfill({ status: 503, json: { detail: 'Temporary service failure' } });
          if (body.expected_summary !== project.summary) return route.fulfill({ status: 400, json: { reason: 'stale_project_context', detail: 'Project intent changed.' } });
          project.summary = body.summary.trim();
          return route.fulfill({ json: project });
        }
        let data = {};
        if (path === '/api/meta') data = { server_version: '0.0015', auth: { required: false } };
        else if (path === '/api/projects') data = { projects: [project] };
        else if (path.endsWith('/home')) data = { project, stats: {}, claims: [], experiments: [], tasks: [], reviews: [], artifacts: [], recent_events: [], active_experiments: [] };
        else if (path.endsWith('/proj_document')) data = project;
        else if (path.endsWith('/sandboxes')) data = { sandboxes: [] };
        else if (path.endsWith('/reflections')) data = { reflections: [] };
        else if (path.endsWith('/events')) data = { events: [] };
        return route.fulfill({ json: data });
      });
      await page.goto(url + 'p/proj_document');
      await page.getByRole('heading', { name: 'Project document', exact: true }).waitFor();
      const doc = page.getByRole('region', { name: 'Project document' });
      assert.match(await doc.innerText(), /Revision pending/);
      const opening = doc.locator('.project-document-section').first();
      assert.equal(await opening.locator('h3').innerText(), 'Introduction');
      assert.equal(await opening.locator('.markdown-body').innerText(), project.summary.replace(/\s+/g, ' '));
      assert.equal(await doc.getByText('Your project brief', { exact: true }).count(), 0);
      assert.match(await doc.innerText(), /did not improve quality/);
      assert.equal(await doc.getByRole('link', { name: 'First reflection', exact: true }).getAttribute('href'), '/merv/p/proj_document/reflection/syn_wave');
      assert.equal(await doc.getByRole('link', { name: 'Evaluation report', exact: true }).getAttribute('href'), '/merv/p/proj_document/artifacts/art_report');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
      await page.screenshot({ path: `${output}/document-${width}.png`, fullPage: true });
      await doc.getByRole('button', { name: 'Edit Introduction', exact: true }).click();
      const input = doc.getByRole('textbox', { name: 'Introduction' });
      const original = project.summary;
      await input.fill('My preserved draft');
      project.summary = 'New context from another user';
      await doc.getByRole('button', { name: 'Save Introduction', exact: true }).click();
      await doc.getByText('Current Introduction', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'My preserved draft');
      assert.equal(writes[0].expected_summary, original);
      assert.equal(await doc.getByRole('button', { name: 'Save Introduction', exact: true }).isDisabled(), true);
      await page.screenshot({ path: `${output}/conflict-${width}.png`, fullPage: true });
      await input.fill('Reconciled user scope');
      await doc.getByRole('button', { name: 'I’ve reconciled my draft' }).click();
      let release;
      holdSave = new Promise(resolve => { release = resolve; });
      await doc.getByRole('button', { name: 'Save Introduction', exact: true }).click();
      await doc.getByRole('button', { name: 'Saving…', exact: true }).waitFor();
      assert.equal(await input.isDisabled(), true);
      release(); holdSave = null;
      await doc.getByText('Introduction saved.', { exact: true }).waitFor();
      assert.equal(writes[1].expected_summary, 'New context from another user');
      assert.equal(project.summary, 'Reconciled user scope');
      assert.equal(await opening.locator('.markdown-body').innerText(), project.summary.replace(/\s+/g, ' '));
      await doc.getByRole('button', { name: 'Edit Introduction', exact: true }).click();
      await input.fill('Unsaved retry draft'); failSave = true;
      await doc.getByRole('button', { name: 'Save Introduction', exact: true }).click();
      await doc.getByText('Temporary service failure', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Unsaved retry draft'); failSave = false;
      await doc.getByRole('button', { name: 'Cancel', exact: true }).click();
      // Exercise empty/loading/error/stale snapshots without waiting for polling timers.
      const setState = state => page.evaluate(async state => {
        const { useProjectStore } = await import('/merv/src/store/useProjectStore.js');
        useProjectStore.setState(state);
      }, state);
      await setState({ lastSyncError: 'Offline' });
      await doc.getByText(/Could not refresh/).waitFor();
      await page.screenshot({ path: `${output}/stale-${width}.png`, fullPage: true });
      await setState({ home: { project: { ...project, summary: '', literature: {}, methods: '', results: '', references: [], maintenance: { state: 'waiting', pending: false } } }, lastSyncError: null });
      await doc.getByText('No methods published yet.', { exact: true }).waitFor();
      await doc.getByText('No Introduction yet. Write one here or develop it with an agent.', { exact: true }).waitFor();
      assert.match(await doc.innerText(), /Awaiting first publication/);
      await page.screenshot({ path: `${output}/empty-${width}.png`, fullPage: true });
      await setState({ home: null });
      await doc.getByText('Loading project document…', { exact: true }).waitFor();
      await setState({ lastSyncError: 'Offline' });
      await doc.getByText(/Could not load the project document/).waitFor();
      await page.goto(url + 'projects');
      await page.getByRole('button', { name: 'Edit Introduction', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit Introduction', exact: true }).click();
      await page.getByRole('textbox', { name: 'Introduction' }).fill('Project index clarification');
      await page.getByRole('button', { name: 'Save Introduction', exact: true }).click();
      await page.getByText('Introduction saved.', { exact: true }).waitFor();
      assert.equal(project.summary, 'Project index clarification');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Project index fits viewport');
      await page.screenshot({ path: `${output}/projects-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      console.log(`${width}px: document, links, conflict/reconciliation, saving, failure draft retention, empty/loading/error/stale, no overflow passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
