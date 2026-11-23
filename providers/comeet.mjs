// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { coerceId } from './_ids.mjs';
import { fetchTextWithRetry } from './_http.mjs';
import { employmentTypeField } from './_employment-type.mjs';
import { workplaceField } from './_workplace-type.mjs';

// Comeet (Spark Hire Recruit) provider — two independent ways to read a board,
// tried in this order:
//
// 1. The token-gated careers-api, when the entry already carries it. The
//    positions endpoint needs BOTH a company-uid and a per-tenant token:
//      https://www.comeet.co/careers-api/2.0/company/<uid>/positions?token=<token>
//    Neither is derivable from a branded careers URL, so unlike
//    greenhouse/recruitee there is no slug→API shortcut: the full API URL
//    must be supplied via the `api:` field (or pasted into `careers_url`).
//    The API host is a single fixed origin, so the SSRF defence pins hostname
//    to www.comeet.co AND requires the /careers-api/ path prefix (rather than
//    a per-tenant subdomain regex).
// 2. The public, no-auth careers PAGE, auto-detected from a
//    https://www.comeet.com/jobs/<company-slug>/<company-uid> careers_url (the
//    link a candidate actually has — no API token, no login). The page
//    server-renders every posting into a `COMPANY_POSITIONS_DATA` JS array
//    (a sibling `COMPANY_DATA` object carries company metadata plus a
//    `token`/`linkedin_integrations_api_key` pair — the SAME per-tenant token
//    the careers-api needs — which this path never reads, so there is nothing
//    to redact here). Confirmed live on two real boards: the
//    position shape matches the careers-api response (`location.name` /
//    `location.is_remote`, `url_active_page` / `url_comeet_hosted_page`,
//    `time_updated`) plus `department`, `employment_type` and
//    `workplace_type`, which the careers-api fixture below never exercised.
//    That the careers-api returns the identical extra fields is an
//    assumption, not something this PR can confirm without a token — if a
//    future contributor who holds one finds otherwise, the `department`
//    fold-into-`description` and the employmentType/workplaceType mapping in
//    parseComeetResponse are the two lines to recheck.
//
// Both paths share one id/detect/fetch and the same Job mapping
// (parseComeetResponse), since a position row has the same shape either way.

const COMEET_API_HOST = 'www.comeet.co';
const COMEET_PAGE_HOST = 'www.comeet.com';

/** @param {unknown} raw */
function isComeetApiUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === COMEET_API_HOST && parsed.pathname.startsWith('/careers-api/');
}

/** @param {string} url */
function assertComeetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`comeet: invalid URL: ${redactToken(url)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`comeet: URL must use HTTPS: ${redactToken(url)}`);
  if (parsed.hostname !== COMEET_API_HOST)
    throw new Error(`comeet: untrusted hostname "${parsed.hostname}" — must be ${COMEET_API_HOST}`);
  if (!parsed.pathname.startsWith('/careers-api/'))
    throw new Error(`comeet: URL path must be the careers-api endpoint: ${redactToken(url)}`);
  return url;
}

// Redact the per-tenant ?token= so neither the (informational, possibly-logged)
// DetectHit url nor a thrown validation error carries the secret. Best-effort:
// falls back to a regex strip when the value can't be parsed as a URL.
function redactToken(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', 'REDACTED');
    return parsed.href;
  } catch {
    return typeof url === 'string' ? url.replace(/([?&]token=)[^&#]*/gi, '$1REDACTED') : url;
  }
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (isComeetApiUrl(entry.api)) return entry.api;
  if (isComeetApiUrl(entry.careers_url)) return entry.careers_url;
  return null;
}

/**
 * The public careers PAGE: https://www.comeet.com/jobs/<slug>/<company-uid>,
 * optionally with a deeper permalink to one posting appended
 * (.../<title-slug>/<posting-uid>). Accepts either shape but always fetches
 * the shallow 2-segment board root — the landing URL a candidate actually
 * has (ADDING_A_PROVIDER.md: "accept the shallowest") — never a path built by
 * hand, and never re-encodes a segment that is already a valid URL path
 * component (same as greenhouse.mjs's board-slug extraction).
 *
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {string|null}
 */
function resolvePageUrl(entry) {
  for (const raw of [entry.careers_url, entry.api]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== COMEET_PAGE_HOST) continue;
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (segs.length < 3 || segs[0] !== 'jobs' || !segs[1] || !segs[2]) continue;
    return `https://${COMEET_PAGE_HOST}/jobs/${segs[1]}/${segs[2]}`;
  }
  return null;
}

// The page hydrates two sibling assignments; only the positions array is read
// (see the header comment on why COMPANY_DATA is skipped entirely).
const POSITIONS_START_RE = /COMPANY_POSITIONS_DATA\s*=\s*\[/;

/**
 * The JSON array assigned to COMPANY_POSITIONS_DATA, as source text. A
 * bracket scan that skips string contents, so a title or department
 * containing "]" can never end the scan early (same technique as
 * appDataSource in ashby.mjs, generalized from `{}` to `[]`).
 *
 * @param {string} html
 * @returns {string|null|undefined} the array text; null when the assignment
 *   is absent; undefined when it starts but never closes.
 */
function positionsSource(html) {
  const m = POSITIONS_START_RE.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']' && --depth === 0) {
      return html.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Pull the raw positions array out of a public Comeet careers page.
 *
 * Fail closed (ADDING_A_PROVIDER.md, "Defensive parsing" — the HTML-scraper
 * case): no COMPANY_POSITIONS_DATA assignment at all, or one that doesn't
 * parse as JSON, means Comeet changed the page, and that must surface as a
 * broken board, not a silent empty one. A present-and-empty `[]` is a
 * genuinely empty board and is returned as-is; parseComeetResponse (shared
 * with the careers-api path) maps it to `[]` either way.
 *
 * @param {string} html
 * @param {string} companyName
 * @returns {any[]}
 */
export function parseComeetPage(html, companyName) {
  const source = positionsSource(html || '');
  if (source === null) throw new Error(`comeet: ${companyName} careers page carried no COMPANY_POSITIONS_DATA — Comeet changed the page`);
  let data;
  try {
    if (source === undefined) throw new Error('unterminated');
    data = JSON.parse(source);
  } catch {
    throw new Error(`comeet: ${companyName} careers page COMPANY_POSITIONS_DATA did not parse as JSON — Comeet changed the page`);
  }
  if (!Array.isArray(data)) {
    // COMPANY_POSITIONS_DATA is documented as an array; the regex above only
    // matches a `[` opener, so this is unreachable in practice — kept as the
    // same defensive, keys-naming throw every other provider uses rather
    // than trusting the regex silently.
    const got = data && typeof data === 'object' ? Object.keys(data).join(', ') : data === null ? 'null' : typeof data;
    throw new Error(`comeet: ${companyName} careers page COMPANY_POSITIONS_DATA is not an array — got: [${got}]`);
  }
  return data;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @type {Provider} */
export default {
  id: 'comeet',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    if (apiUrl) {
      // The DetectHit url is informational (the framework may log it), so
      // strip the secret ?token= before returning it — fetch() re-resolves
      // the real URL from the entry, so redaction here is safe.
      return { url: redactToken(apiUrl) };
    }
    const pageUrl = resolvePageUrl(entry);
    // No token to redact here — resolvePageUrl only ever returns the public
    // board root, never a URL carrying ?token=.
    return pageUrl ? { url: pageUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (apiUrl) {
      assertComeetUrl(apiUrl);
      // redirect:'error' prevents SSRF via server-side redirects; combined with
      // assertComeetUrl above it guarantees the final hostname stays www.comeet.co.
      const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
      return parseComeetResponse(json, entry.name);
    }
    const pageUrl = resolvePageUrl(entry);
    if (!pageUrl) throw new Error(`comeet: cannot derive a careers-api or careers-page URL for ${entry.name} (set api: to the full careers-api positions URL, or careers_url: to a https://${COMEET_PAGE_HOST}/jobs/<slug>/<uid> page)`);
    // resolvePageUrl only ever returns a www.comeet.com origin it built
    // itself; redirect:'error' still guards the one request this path makes.
    const html = await fetchTextWithRetry(ctx, pageUrl, { redirect: 'error' });
    const positions = parseComeetPage(html, entry.name);
    return parseComeetResponse(positions, entry.name);
  },
};

/**
 * Parse a Comeet careers-api positions response. Exported for unit tests.
 *
 * Comeet returns a top-level ARRAY of position objects:
 *   [{ name, location: { name, is_remote }, url_active_page,
 *      url_comeet_hosted_page, time_updated, ... }]
 *
 * - url: prefer `url_active_page` (the tenant's live careers page), fall back to
 *   `url_comeet_hosted_page` (the Comeet-hosted page). Both are public, display-
 *   only URLs (recorded in the pipeline/history, never server-fetched here), so
 *   they are NOT host-locked. Require a well-formed https: URL; a position whose
 *   two URLs are both missing/non-https/malformed is dropped (url is the dedup key).
 * - location: `location.name`, appending "Remote" when `location.is_remote`.
 * - department: not a Job field (_types.js has none, and peoplesoft.mjs
 *   dropped its own `department` field per review for exactly that reason) —
 *   folded into `description` as a `Department: <name>` line instead, the
 *   same convention collage.mjs/meituan.mjs/mokahr.mjs already use.
 * - employmentType / workplaceType: mapped through the shared
 *   `_employment-type.mjs` / `_workplace-type.mjs` normalizers from
 *   `employment_type` ("Full-time") / `workplace_type` ("Hybrid", "On-site",
 *   "Remote"); omitted when the source value doesn't normalize to a known one.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, externalId?: string, employmentType?: string, workplaceType?: string}>}
 */
export function parseComeetResponse(json, companyName) {
  // [] is an empty board. Any other body ({}, { error }, a bare string) is a
  // changed or failing API and must not read as a board with no open roles
  // (ADDING_A_PROVIDER.md, "Defensive parsing"; #6906).
  if (!Array.isArray(json)) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : json === null ? 'null' : typeof json;
    throw new Error(`comeet: unexpected response for ${companyName} — expected an array of positions, got: [${got}]`);
  }
  const positions = json;
  return positions
    .map(row => {
      // Coerce each row to a safe object so null / non-object members can't throw.
      const j = (row && typeof row === 'object') ? row : {};
      // Resolve a display-only https URL; drop the position if none is usable.
      let url = '';
      for (const rawUrl of [j.url_active_page, j.url_comeet_hosted_page]) {
        if (typeof rawUrl !== 'string' || !rawUrl) continue;
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'https:') {
            url = parsed.href;
            break;
          }
        } catch {
          // malformed active URL → try the hosted fallback
        }
      }

      const loc = j.location || {};
      const remote = loc.is_remote ? 'Remote' : '';
      const base = (typeof loc.name === 'string' && loc.name.trim()) ? loc.name.trim() : '';
      // Append "Remote" only when the base location doesn't already say so.
      const location = remote && !/remote/i.test(base)
        ? [base, remote].filter(Boolean).join(', ')
        : base;

      const department = typeof j.department === 'string' ? j.department.trim() : '';

      return {
        title: (typeof j.name === 'string' ? j.name.trim() : ''),
        url,
        location,
        company: companyName,
        externalId: coerceId(j.uid),
        ...(department ? { description: `Department: ${department}` } : {}),
        ...employmentTypeField(j.employment_type),
        ...workplaceField(j.workplace_type),
        postedAt: toEpochMs(j.time_updated),
      };
    })
    .filter(job => job.title && job.url);
}
