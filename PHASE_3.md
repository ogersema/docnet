# Phase 3 – Web Crawler
## URL Input · Crawling · Text Extraction · Analysis

Prerequisite: Phase 2 complete and verified.

**Deliverable:** Reporters can submit a URL (single page or entire website)
to a project. The system crawls the pages, extracts text, and runs the same
analysis pipeline as for PDFs. JavaScript-rendered sites (SPAs, paywalled
articles) work via Playwright fallback.

---

## Step 3.1 — Install Dependencies

```bash
# Cheerio for HTML parsing (fast, no browser)
npm install cheerio @types/cheerio node-fetch@2 @types/node-fetch

# Playwright for JS-rendered sites (install separately — large download)
npm install playwright
npx playwright install chromium  # Only chromium — skip firefox/webkit
```

Playwright is ~300 MB. In production, install it once and cache it.
In `package.json`, add a `postinstall` note but don't auto-run it — too slow for CI.

---

## Step 3.2 — URL Submission Route

Add to `routes/upload.ts` (or create a separate `routes/crawl.ts`):

```typescript
// POST /api/projects/:projectId/crawl
router.post('/crawl',
  authMiddleware,
  async (req, res, next) => {
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    next();
  },
  async (req, res) => {
    const { url, maxDepth = 0, domainOnly = true, maxPages = 50 } = req.body;

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Only http and https URLs are supported' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Check for duplicate (same URL already crawled in this project)
    const { rows } = await pool.query(
      'SELECT id FROM web_sources WHERE project_id = $1 AND url = $2',
      [req.params.projectId, url]
    );
    if (rows.length > 0) {
      return res.status(409).json({ error: 'This URL has already been crawled in this project' });
    }

    // Enqueue crawl job
    const job = await queue.enqueue({
      projectId: req.params.projectId,
      type: 'web',
      payload: {
        url,
        maxDepth: Math.min(3, Math.max(0, parseInt(maxDepth))),  // cap at 3
        domainOnly: Boolean(domainOnly),
        maxPages: Math.min(200, Math.max(1, parseInt(maxPages)))
      }
    });

    res.json({ jobId: job.id, url, maxDepth, maxPages });
  }
);
```

---

## Step 3.3 — Core Crawler Module

Create `worker/processors/web.ts`:

```typescript
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { URL } from 'url';
import { Job } from '../queue';
import { queue } from '../queue';
import { analyzeText } from '../pipeline';
import { pool } from '../../db/pool';

interface CrawlConfig {
  url: string;
  maxDepth: number;
  domainOnly: boolean;
  maxPages: number;
}

interface PageResult {
  url: string;
  title: string;
  text: string;
  links: string[];
}

export async function processWebJob(job: Job): Promise<void> {
  const config = job.payload as CrawlConfig;
  const startDomain = new URL(config.url).hostname;

  await queue.setProgress(job.id, 2);

  // BFS crawl
  const visited = new Set<string>();
  const toVisit: Array<{ url: string; depth: number }> = [{ url: config.url, depth: 0 }];
  const pages: PageResult[] = [];

  while (toVisit.length > 0 && pages.length < config.maxPages) {
    const { url, depth } = toVisit.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await fetchPage(url);
      pages.push(page);

      // Update progress
      const pct = Math.min(50, Math.round((pages.length / Math.min(config.maxPages, 20)) * 50));
      await queue.setProgress(job.id, pct);

      // Discover links if we haven't reached maxDepth
      if (depth < config.maxDepth) {
        for (const link of page.links) {
          if (visited.has(link)) continue;
          if (config.domainOnly && new URL(link).hostname !== startDomain) continue;
          toVisit.push({ url: link, depth: depth + 1 });
        }
      }

      // Small delay to be respectful to the target server
      await sleep(500);
    } catch (err: any) {
      console.warn(`Failed to fetch ${url}: ${err.message}`);
    }
  }

  // Record web sources
  await pool.query(
    `INSERT INTO web_sources (project_id, url, title, doc_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, url) DO UPDATE SET doc_count = $4, crawled_at = NOW()`,
    [job.projectId, config.url, pages[0]?.title || config.url, pages.length]
  );

  // Analyze each page
  let analyzed = 0;
  for (const page of pages) {
    if (page.text.length < 100) continue; // Skip near-empty pages

    const docId = `web-${urlToDocId(page.url)}`;
    try {
      await analyzeText({
        projectId: job.projectId,
        docId,
        filePath: page.url,  // URL as "path" for web docs
        content: `URL: ${page.url}\nTitle: ${page.title}\n\n${page.text}`,
        originalName: page.title || page.url
      });
      analyzed++;

      const pct = 50 + Math.round((analyzed / pages.length) * 50);
      await queue.setProgress(job.id, pct);
    } catch (err: any) {
      console.warn(`Analysis failed for ${page.url}: ${err.message}`);
    }
  }

  await queue.setDone(job.id, {
    pagesFound: pages.length,
    pagesAnalyzed: analyzed,
    startUrl: config.url
  });
}

async function fetchPage(url: string): Promise<PageResult> {
  // Try static fetch first (faster)
  try {
    return await fetchStatic(url);
  } catch {
    // Fall back to Playwright for JS-rendered pages
    return await fetchWithPlaywright(url);
  }
}

async function fetchStatic(url: string): Promise<PageResult> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DocNet Research Bot/1.0 (document analysis)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    timeout: 15000
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) throw new Error('Not HTML');

  const html = await response.text();
  return parseHtml(url, html);
}

async function fetchWithPlaywright(url: string): Promise<PageResult> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const html = await page.content();
    return parseHtml(url, html);
  } finally {
    await browser.close();
  }
}

function parseHtml(url: string, html: string): PageResult {
  const $ = cheerio.load(html);

  // Extract title
  const title = $('title').text().trim() ||
    $('h1').first().text().trim() ||
    url;

  // Remove navigation, footer, sidebars, scripts, styles
  $('nav, footer, header, aside, script, style, noscript, iframe').remove();
  $('[class*="nav"], [class*="menu"], [class*="footer"], [class*="sidebar"], [id*="nav"]').remove();

  // Extract main content
  const mainContent = $('main, article, [role="main"], .content, #content').first();
  const text = (mainContent.length ? mainContent : $('body')).text()
    .replace(/\s+/g, ' ')
    .trim();

  // Extract links
  const baseUrl = new URL(url);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href')!;
      const absolute = new URL(href, baseUrl).toString();
      // Only include HTTP(S) links, exclude fragments and mailto
      if (absolute.startsWith('http') && !absolute.includes('#')) {
        links.push(absolute.split('?')[0]); // Strip query params for dedup
      }
    } catch {}
  });

  return { url, title, text, links: [...new Set(links)] };
}

function urlToDocId(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .slice(0, 80);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## Step 3.4 — Web Sources API

Add endpoint to `routes/graph.ts` (or create `routes/sources.ts`):

```typescript
// GET /api/projects/:projectId/sources
// Lists all crawled web sources for a project
router.get('/:projectId/sources', authMiddleware, async (req, res) => {
  const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Project not found' });

  const { rows } = await pool.query(
    `SELECT id, url, title, doc_count, crawled_at
     FROM web_sources WHERE project_id = $1
     ORDER BY crawled_at DESC`,
    [req.params.projectId]
  );
  res.json(rows);
});
```

---

## Step 3.5 — Frontend: URL Input UI

### CrawlForm component (`network-ui/src/components/CrawlForm.tsx`)

A form with:
- URL input field (text, validated as URL on change)
- Crawl depth selector: "This page only" (0) / "Linked pages" (1) / "Two levels deep" (2) / "Three levels deep" (3)
- Max pages input (number, default 50, max 200)
- Domain only toggle (default: on — stays on same domain)
- Submit button: "Analyse Website"

On submit:
1. POST to `/api/projects/:projectId/crawl`
2. Receive `{ jobId }`
3. Start polling `GET /api/jobs/:jobId` every 3 seconds
4. Show progress: "Crawling... (page 12 of ~50)" (use `job.progress` percentage)
5. On completion: show "Analyzed N pages from domain.com" → trigger graph refresh

### Source list (`network-ui/src/components/SourceList.tsx`)

Below the upload zone and crawl form, show a compact table of already-crawled
web sources for this project:
- Domain / URL
- Pages analyzed
- Crawled date
- "Re-crawl" button (enqueues a new crawl job for same URL/config)

---

## Step 3.6 — Document Source Display

In `DocumentModal.tsx`, when `doc.filePath` starts with `http://` or `https://`,
show it as a clickable link ("View original page →") instead of a file path.

---

## Step 3.7 — Crawl Politeness

Add to `worker/processors/web.ts` — respect robots.txt (optional but good practice):

```typescript
import robotsParser from 'robots-parser';
// npm install robots-parser @types/robots-parser

async function isAllowed(url: string): Promise<boolean> {
  try {
    const { origin } = new URL(url);
    const robotsUrl = `${origin}/robots.txt`;
    const response = await fetch(robotsUrl, { timeout: 5000 });
    if (!response.ok) return true; // No robots.txt = allowed
    const text = await response.text();
    const robots = robotsParser(robotsUrl, text);
    return robots.isAllowed(url, 'DocNet Research Bot') !== false;
  } catch {
    return true; // If robots.txt fetch fails, be permissive
  }
}
```

Cache robots.txt per domain for the duration of a crawl job (don't re-fetch
it for every page).

---

## Phase 3 Verification Checklist

- [ ] `npm install` includes `cheerio`, `node-fetch`, `playwright`
- [ ] `npx playwright install chromium` completes without errors
- [ ] `POST /api/projects/:id/crawl` with a valid URL returns `{ jobId }`
- [ ] `POST /api/projects/:id/crawl` with invalid URL returns 400
- [ ] Worker processes `type: 'web'` jobs (add `case 'web'` to `worker/index.ts`)
- [ ] Crawling a simple static site (e.g. a Wikipedia article URL) creates documents
- [ ] Crawling with `maxDepth: 0` fetches only the single page
- [ ] Crawling with `domainOnly: true` does not follow external links
- [ ] Crawling `maxPages: 5` stops after 5 pages even if more links exist
- [ ] After crawl completes, web documents appear in graph
- [ ] `GET /api/projects/:id/sources` lists crawled sources
- [ ] DocumentModal shows clickable URL link for web-sourced documents
- [ ] Duplicate URL submission (same project) returns 409
- [ ] A JS-heavy page (try a React-built site) falls back to Playwright and succeeds
- [ ] Progress bar in UI updates during a crawl job (not just at 0 and 100)
