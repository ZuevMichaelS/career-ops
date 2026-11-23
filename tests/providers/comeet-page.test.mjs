// tests/providers/comeet-page.test.mjs — provider-contract tests for the
// public-page scraping path added to providers/comeet.mjs: a
// www.comeet.com/jobs/<slug>/<uid> careers page carries no token, so unlike
// the careers-api path (tests/providers/comeet.test.mjs) it is read by
// parsing the COMPANY_POSITIONS_DATA array the page itself embeds.
//
// tests/fixtures/comeet-page-{port,coralogix}.html are trimmed real pages
// (fetched 2026-11-23) — real titles/departments/locations/urls/dates, with
// COMPANY_DATA's token/linkedin_integrations_api_key and every position's
// custom_fields/email/arrival_instructions stripped (unread by the provider,
// not ours to redistribute). tests/fixtures/comeet-page-malformed.html is
// synthetic: a page that no longer embeds COMPANY_POSITIONS_DATA at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, results, ROOT } from '../helpers.mjs';
import comeet, { parseComeetPage, parseComeetResponse } from '../../providers/comeet.mjs';

console.log('\nProvider — comeet (public page)');

async function check(name, run) {
  try {
    await run();
    pass(name);
  } catch (error) {
    fail(`${name}: ${error.message}`);
  }
}

const portHtml = readFileSync(join(ROOT, 'tests/fixtures/comeet-page-port.html'), 'utf-8');
const coralogixHtml = readFileSync(join(ROOT, 'tests/fixtures/comeet-page-coralogix.html'), 'utf-8');
const malformedHtml = readFileSync(join(ROOT, 'tests/fixtures/comeet-page-malformed.html'), 'utf-8');

function stubCtx(html) {
  const calls = [];
  return {
    calls,
    ctx: {
      transport: 'http',
      sleep: async () => {},
      fetchText: async (url, opts) => { calls.push({ url, opts }); return html; },
      fetchJson: async () => { throw new Error('fetchJson should not be called on the page-scraping path'); },
    },
  };
}

// ── detect() ──────────────────────────────────────────────────────────────

await check('detect() claims a public jobs page and resolves the shallow board root', () => {
  const hit = comeet.detect({ name: 'Port', careers_url: 'https://www.comeet.com/jobs/port/59.004' });
  assert.deepEqual(hit, { url: 'https://www.comeet.com/jobs/port/59.004' });
});

await check('detect() rejects a non-HTTPS comeet.com jobs page', () => {
  assert.equal(comeet.detect({ name: 'X', careers_url: 'http://www.comeet.com/jobs/port/59.004' }), null);
});

// ── fetch() over the page path ──────────────────────────────────────────

await check('fetch() reads the real Port fixture end-to-end: title, location, department-as-description, dates, workplaceType, employmentType', async () => {
  const { calls, ctx } = stubCtx(portHtml);
  const jobs = await comeet.fetch({ name: 'Port', careers_url: 'https://www.comeet.com/jobs/port/59.004' }, ctx);

  // Exactly one request, to the normalized board root, redirect:'error'.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.comeet.com/jobs/port/59.004');
  assert.equal(calls[0].opts.redirect, 'error');

  assert.equal(jobs.length, 4);

  const backend = jobs.find(j => j.title === 'Senior Backend Engineer');
  assert.ok(backend, 'Senior Backend Engineer present');
  assert.equal(backend.company, 'Port');
  assert.equal(backend.location, 'Tel Aviv - Israel, Remote'); // is_remote: true, appended
  assert.equal(backend.description, 'Department: R&D');
  assert.equal(backend.workplaceType, 'hybrid');
  assert.equal(backend.employmentType, 'full_time');
  assert.equal(backend.url, 'https://www.comeet.com/jobs/port/59.004/senior-backend-engineer/7C.767?t=1795421180349');
  assert.equal(backend.postedAt, Date.parse('2026-11-23T08:07:37Z'));
  assert.equal(backend.externalId, '7C.767');

  const onsite = jobs.find(j => j.title === 'Program Manager, GTM');
  assert.ok(onsite, 'Program Manager, GTM present');
  assert.equal(onsite.location, 'Tel Aviv - Israel'); // is_remote: false, no suffix
  assert.equal(onsite.workplaceType, 'onsite');
  // employment_type: null on this real row — no guessed employmentType.
  assert.equal('employmentType' in onsite, false);
});

await check('fetch() keeps both rows of a real multi-location posting (same base uid, different city) as distinct jobs sharing one url', async () => {
  const { ctx } = stubCtx(portHtml);
  const jobs = await comeet.fetch({ name: 'Port', careers_url: 'https://www.comeet.com/jobs/port/59.004' }, ctx);
  const accountManagers = jobs.filter(j => j.title === 'Account Manager');
  assert.equal(accountManagers.length, 2);
  assert.equal(accountManagers[0].url, accountManagers[1].url); // scan.mjs dedups by url
  assert.notEqual(accountManagers[0].externalId, accountManagers[1].externalId);
  assert.deepEqual(new Set(accountManagers.map(j => j.location)),
    new Set(['Boston - USA, Remote', 'Austin - USA, Remote']));
});

await check('fetch() reads the real Coralogix fixture: a branded url_active_page, a location.name already saying Remote, and a null city', async () => {
  const { ctx } = stubCtx(coralogixHtml);
  const jobs = await comeet.fetch({ name: 'Coralogix', careers_url: 'https://www.comeet.com/jobs/coralogix/06.004' }, ctx);
  assert.equal(jobs.length, 4);

  // url_active_page is on coralogix.com (a custom domain), not comeet.com —
  // preferred over url_comeet_hosted_page, same precedence as the
  // careers-api path (comeet.test.mjs's "falls back to url_comeet_hosted_page").
  const remoteBackend = jobs.find(j => j.externalId === 'E9.377');
  assert.ok(remoteBackend);
  assert.equal(remoteBackend.url, 'https://coralogix.com/careers/co/remote-europe/E9.377/backend-engineer/all/');
  // location.name is "Remote, Europe" already — must not become "..., Remote, Remote".
  assert.equal(remoteBackend.location, 'Remote, Europe');
  assert.equal(remoteBackend.workplaceType, 'remote');

  // Title says "(Remote Role, ...)" but is_remote is false and workplace_type
  // is On-site — the title text must never leak into the remote decision.
  const onsiteIndia = jobs.find(j => j.externalId === '4D.169');
  assert.ok(onsiteIndia);
  assert.equal(onsiteIndia.location, 'Remote, India'); // location.name as-is, no suffix added
  assert.equal(onsiteIndia.workplaceType, 'onsite');

  // location.city/country are null/"" on this row — location.name ("New York")
  // still carries the job, with Remote appended for is_remote: true.
  const nullCity = jobs.find(j => j.externalId === 'FD.27E-2B.40F');
  assert.ok(nullCity);
  assert.equal(nullCity.location, 'New York, Remote');
});

// ── empty vs broken (ADDING_A_PROVIDER.md, "Defensive parsing") ─────────

await check('fetch() throws on a page redesign that dropped COMPANY_POSITIONS_DATA entirely', async () => {
  const { ctx } = stubCtx(malformedHtml);
  await assert.rejects(
    () => comeet.fetch({ name: 'Fictional Co', careers_url: 'https://www.comeet.com/jobs/fictional-co/00.000' }, ctx),
    (err) => /carried no COMPANY_POSITIONS_DATA/.test(err.message),
  );
});

await check('parseComeetPage returns [] for a genuinely empty board (present-and-empty array)', () => {
  const html = '<script>var COMPANY_POSITIONS_DATA = [];</script>';
  assert.deepEqual(parseComeetPage(html, 'X'), []);
  assert.deepEqual(parseComeetResponse(parseComeetPage(html, 'X'), 'X'), []);
});

await check('parseComeetPage throws on an unterminated array (started but never closed)', () => {
  assert.throws(
    () => parseComeetPage('<script>var COMPANY_POSITIONS_DATA = [{"name": "Engineer"', 'X'),
    /did not parse as JSON/,
  );
});

await check('parseComeetPage throws when COMPANY_POSITIONS_DATA is absent (no assignment at all)', () => {
  assert.throws(() => parseComeetPage('<script>var COMPANY_DATA = {};</script>', 'X'), /carried no COMPANY_POSITIONS_DATA/);
});

await check('parseComeetPage skips over an unrelated "]" inside a string value (e.g. a title) without ending the scan early', () => {
  const html = '<script>var COMPANY_POSITIONS_DATA = [{"name": "Weird ] Title", "uid": "A1", '
    + '"url_active_page": "https://example.com/a", "location": {}}];</script>';
  const positions = parseComeetPage(html, 'X');
  assert.equal(positions.length, 1);
  assert.equal(positions[0].name, 'Weird ] Title');
});

// ── detect() + fetch() precedence over the careers-api path is covered in
// comeet.test.mjs (the file that already owns that path's contract tests).

if (results().failed) process.exitCode = 1;
