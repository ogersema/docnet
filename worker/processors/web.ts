import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { URL } from 'url';
import robotsParser from 'robots-parser';
import { Job, queue } from '../queue.js';
import { analyzeText } from '../pipeline.js';
import { pool } from '../../db/pool.js';

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

// Per-domain robots.txt cache (lives for the duration of one crawl job)
const robotsCache = new Map<string, ReturnType<typeof robotsParser>>();

async function isAllowed(url: string): Promise<boolean> {
  try {
    const { origin } = new URL(url);
    if (robotsCache.has(origin)) {
      return robotsCache.get(origin)!.isAllowed(url, 'DocNet Research Bot') !== false;
    }
    const robotsUrl = `${origin}/robots.txt`;
    const response = await fetch(robotsUrl, { timeout: 5000 });
    if (!response.ok) {
      // No robots.txt = allowed
      return true;
    }
    const text = await response.text();
    const robots = robotsParser(robotsUrl, text);
    robotsCache.set(origin, robots);
    return robots.isAllowed(url, 'DocNet Research Bot') !== false;
  } catch {
    return true; // If robots.txt fetch fails, be permissive
  }
}

export async function processWebJob(job: Job): Promise<void> {
  const config = job.payload as CrawlConfig;
  const startDomain = new URL(config.url).hostname;

  // Clear robots cache for fresh crawl
  robotsCache.clear();

  await queue.setProgress(job.id, 2);

  // BFS crawl
  const visited = new Set<string>();
  const toVisit: Array<{ url: string; depth: number }> = [{ url: config.url, depth: 0 }];
  const pages: PageResult[] = [];

  while (toVisit.length > 0 && pages.length < config.maxPages) {
    const { url, depth } = toVisit.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    // Check robots.txt
    const allowed = await isAllowed(url);
    if (!allowed) {
      console.log(`Blocked by robots.txt: ${url}`);
      continue;
    }

    try {
      const page = await fetchPage(url);
      pages.push(page);

      // Update progress (crawling phase = 0-50%)
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

  if (pages.length === 0) {
    await queue.setDone(job.id, { pagesFound: 0, pagesAnalyzed: 0, startUrl: config.url });
    return;
  }

  // Record web source
  await pool.query(
    `INSERT INTO web_sources (project_id, url, title, doc_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, url) DO UPDATE SET doc_count = $4, crawled_at = NOW()`,
    [job.project_id, config.url, pages[0]?.title || config.url, pages.length]
  );

  // Analyze each page (analysis phase = 50-100%)
  let analyzed = 0;
  for (const page of pages) {
    if (page.text.length < 100) continue; // Skip near-empty pages

    const docId = `web-${urlToDocId(page.url)}`;
    try {
      await analyzeText({
        projectId: job.project_id,
        docId,
        filePath: page.url, // URL as "path" for web docs
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
  const page = await fetchStatic(url);

  // If we got very little text, try Playwright fallback (JS-rendered pages)
  if (page.text.length < 200) {
    try {
      return await fetchWithPlaywright(url);
    } catch {
      // If Playwright fails or isn't installed, return static result
      return page;
    }
  }

  return page;
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
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error('Not HTML');
  }

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
