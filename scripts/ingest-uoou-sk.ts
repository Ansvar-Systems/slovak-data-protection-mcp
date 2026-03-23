#!/usr/bin/env tsx
/**
 * ÚOOÚ SR ingestion crawler — dataprotection.gov.sk
 *
 * Crawls the Slovak Data Protection Authority website for:
 *   1. Aktuality (news) — paginated at /sk/aktuality/?page=N (33 pages)
 *      Items matching decision/sanction keywords → decisions table
 *      Items matching guidance keywords → guidelines table
 *   2. EDPB methodologies — PDFs at /sk/legislativa-metodiky/metodiky-faq/metodiky-edpb/
 *      Each PDF entry → guidelines table (type = 'metodika_edpb')
 *   3. ÚOOÚ office methodologies — /sk/legislativa-metodiky/metodiky-faq/metodiky-uradu/
 *      Subsection pages → guidelines table (type = 'metodický_pokyn')
 *   4. Annual reports — /sk/urad/o-nas/vyrocne-spravy/
 *      PDF links → guidelines table (type = 'výročná_správa')
 *   5. Control plans — /sk/urad/kontrola-spracuvania-osobnych-udajov/plan-kontrol-rok-YYYY/
 *      Inspection plan pages → guidelines table (type = 'plán_kontrol')
 *
 * Usage:
 *   npx tsx scripts/ingest-uoou-sk.ts
 *   npx tsx scripts/ingest-uoou-sk.ts --resume       # skip already-ingested URLs
 *   npx tsx scripts/ingest-uoou-sk.ts --dry-run       # parse and log, do not write DB
 *   npx tsx scripts/ingest-uoou-sk.ts --force          # drop existing data first
 *   npx tsx scripts/ingest-uoou-sk.ts --limit 10       # stop after N detail pages
 *   npx tsx scripts/ingest-uoou-sk.ts --section news   # only crawl aktuality
 *   npx tsx scripts/ingest-uoou-sk.ts --section edpb   # only crawl EDPB methodologies
 *   npx tsx scripts/ingest-uoou-sk.ts --section reports # only crawl annual reports
 *   npx tsx scripts/ingest-uoou-sk.ts --section plans   # only crawl control plans
 *
 * Env:
 *   UOOU_SK_DB_PATH  — SQLite path (default: data/uoou_sk.db)
 *
 * Dependencies: better-sqlite3, cheerio
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = "https://dataprotection.gov.sk";
const NEWS_PATH = "/sk/aktuality/";
const EDPB_PATH = "/sk/legislativa-metodiky/metodiky-faq/metodiky-edpb/";
const UOOU_METHODOLOGIES_PATH =
  "/sk/legislativa-metodiky/metodiky-faq/metodiky-uradu/";
const ANNUAL_REPORTS_PATH = "/sk/urad/o-nas/vyrocne-spravy/";
const CONTROL_PLANS_BASE_PATH =
  "/sk/urad/kontrola-spracuvania-osobnych-udajov/";

const USER_AGENT =
  "Ansvar-UOOU-SK-MCP/1.0 (legal-data-pipeline; contact: hello@ansvar.ai)";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

const STATE_FILE = resolve(__dirname, "../data/.ingest-state.json");

const DB_PATH = process.env["UOOU_SK_DB_PATH"] ?? "data/uoou_sk.db";

// Control plan years to attempt crawling
const CONTROL_PLAN_YEARS = [
  2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Section =
  | "all"
  | "news"
  | "edpb"
  | "methodologies"
  | "reports"
  | "plans";

interface CliArgs {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number | null;
  section: Section;
}

const VALID_SECTIONS: Section[] = [
  "all",
  "news",
  "edpb",
  "methodologies",
  "reports",
  "plans",
];

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    resume: false,
    dryRun: false,
    force: false,
    limit: null,
    section: "all",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--resume") {
      args.resume = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--limit" && argv[i + 1]) {
      args.limit = Number.parseInt(argv[++i]!, 10);
      if (Number.isNaN(args.limit) || args.limit < 1) {
        console.error("--limit must be a positive integer");
        process.exit(1);
      }
    } else if (a === "--section" && argv[i + 1]) {
      const v = argv[++i]!;
      if (VALID_SECTIONS.includes(v as Section)) {
        args.section = v as Section;
      } else {
        console.error(
          `Unknown section: ${v}. Valid: ${VALID_SECTIONS.join(", ")}`,
        );
        process.exit(1);
      }
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(
        "Usage: npx tsx scripts/ingest-uoou-sk.ts [--resume] [--dry-run] [--force] [--limit N] [--section SECTION]",
      );
      process.exit(1);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Rate-limited fetcher with retry
// ---------------------------------------------------------------------------

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function applyRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

interface FetchResult {
  status: number;
  body: string;
  url: string;
  contentType: string;
}

async function fetchPage(url: string): Promise<FetchResult> {
  await applyRateLimit();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "sk,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < MAX_RETRIES
      ) {
        const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `  [retry] ${url} → HTTP ${res.status}, backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(backoffMs);
        continue;
      }

      const body = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      return { status: res.status, body, url: res.url, contentType };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `  [retry] ${url} → ${err instanceof Error ? err.message : String(err)}, backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES + 1} attempts`);
}

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

interface IngestState {
  ingestedUrls: string[];
  lastNewsPage: number;
  lastRun: string;
}

function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as IngestState;
    } catch {
      console.warn("Corrupted state file — starting fresh");
    }
  }
  return { ingestedUrls: [], lastNewsPage: 0, lastRun: "" };
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Topic classification
// ---------------------------------------------------------------------------

interface TopicMatch {
  id: string;
  keywords: string[];
}

const TOPIC_RULES: TopicMatch[] = [
  {
    id: "consent",
    keywords: [
      "súhlas",
      "consent",
      "právny základ",
      "čl. 6",
      "čl. 7",
      "článok 6",
      "článok 7",
    ],
  },
  {
    id: "cookies",
    keywords: [
      "cookie",
      "cookies",
      "súbor",
      "sledovac",
      "eprivacy",
      "e-privacy",
    ],
  },
  {
    id: "transfers",
    keywords: [
      "prenos",
      "transfer",
      "tretia krajina",
      "tretích krajín",
      "kapitola v",
      "čl. 44",
      "čl. 46",
      "článok 44",
      "článok 46",
      "článok 49",
      "adequacy",
      "primeranosť",
      "standard contractual",
      "štandardné zmluvné",
      "bcr",
      "binding corporate",
      "záväzné vnútropodnikové",
    ],
  },
  {
    id: "dpia",
    keywords: [
      "posúdenie vplyvu",
      "dpia",
      "impact assessment",
      "čl. 35",
      "článok 35",
      "vysoké riziko",
    ],
  },
  {
    id: "breach_notification",
    keywords: [
      "porušenie ochrany",
      "breach",
      "incident",
      "únik",
      "72 hodín",
      "čl. 33",
      "čl. 34",
      "článok 33",
      "článok 34",
      "oznamovanie porušení",
      "data breach",
    ],
  },
  {
    id: "privacy_by_design",
    keywords: [
      "privacy by design",
      "ochrana údajov v štádiu návrhu",
      "predvolené nastavenie",
      "čl. 25",
      "článok 25",
      "technické opatrenia",
      "organizačné opatrenia",
      "čl. 32",
      "článok 32",
    ],
  },
  {
    id: "employee_monitoring",
    keywords: [
      "monitorovanie zamestnancov",
      "zamestnanec",
      "pracovisko",
      "pracovnoprávn",
      "kamerov",
      "sledovanie obrazovky",
      "kamera",
      "camera",
      "video",
      "biometrické",
      "biometric",
    ],
  },
  {
    id: "health_data",
    keywords: [
      "zdravotné údaje",
      "zdravotný",
      "health data",
      "osobitná kategória",
      "čl. 9",
      "článok 9",
    ],
  },
  {
    id: "children",
    keywords: [
      "deti",
      "dieťa",
      "maloletý",
      "children",
      "child",
      "čl. 8",
      "článok 8",
      "rodičovský súhlas",
    ],
  },
  {
    id: "profiling",
    keywords: [
      "profilovanie",
      "profiling",
      "automatizované rozhodovanie",
      "automated decision",
      "čl. 22",
      "článok 22",
      "umelá inteligencia",
      "artificial intelligence",
    ],
  },
  {
    id: "transparency",
    keywords: [
      "transparentnosť",
      "transparency",
      "informačná povinnosť",
      "čl. 13",
      "čl. 14",
      "článok 13",
      "článok 14",
      "informovanie",
    ],
  },
  {
    id: "dpo",
    keywords: [
      "zodpovedná osoba",
      "data protection officer",
      "dpo",
      "čl. 37",
      "článok 37",
    ],
  },
  {
    id: "data_subject_rights",
    keywords: [
      "práva dotknutých osôb",
      "právo na prístup",
      "právo na vymazanie",
      "právo na prenosnosť",
      "right of access",
      "right to erasure",
      "right to portability",
      "čl. 15",
      "čl. 16",
      "čl. 17",
      "článok 15",
      "článok 17",
    ],
  },
  {
    id: "codes_of_conduct",
    keywords: [
      "kódex správania",
      "code of conduct",
      "certifikácia",
      "certification",
      "čl. 40",
      "čl. 42",
      "článok 40",
      "článok 42",
    ],
  },
  {
    id: "law_enforcement",
    keywords: [
      "presadzovanie práva",
      "law enforcement",
      "smernica 2016/680",
      "policajné",
      "trestné",
    ],
  },
];

function classifyTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      matched.push(rule.id);
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// GDPR article extraction
// ---------------------------------------------------------------------------

const GDPR_ARTICLE_RE =
  /(?:čl(?:ánok|\.)\s*(\d+))|(?:article\s+(\d+))|(?:art\.\s*(\d+))/gi;

function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex — the regex has the global flag
  GDPR_ARTICLE_RE.lastIndex = 0;
  while ((m = GDPR_ARTICLE_RE.exec(text)) !== null) {
    const num = m[1] ?? m[2] ?? m[3];
    if (num) {
      const n = Number.parseInt(num, 10);
      // GDPR articles range 1-99
      if (n >= 1 && n <= 99) {
        articles.add(num);
      }
    }
  }
  return [...articles].sort((a, b) => Number(a) - Number(b));
}

// ---------------------------------------------------------------------------
// Fine extraction
// ---------------------------------------------------------------------------

const FINE_RE = /(\d[\d\s.,]*)\s*(?:EUR|eur|€)/g;

function extractFine(text: string): number | null {
  let highest: number | null = null;
  FINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FINE_RE.exec(text)) !== null) {
    const raw = m[1]!.replace(/[\s.]/g, "").replace(",", ".");
    const val = Number.parseFloat(raw);
    if (!Number.isNaN(val) && val > 0) {
      if (highest === null || val > highest) {
        highest = val;
      }
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Entity extraction (simplified)
// ---------------------------------------------------------------------------

const ENTITY_PATTERNS = [
  // "spoločnosti X a.s." / "spoločnosti X s.r.o."
  /spoločnost[ií]\s+([\p{L}\s-]+(?:a\.s\.|s\.r\.o\.|k\.s\.))/gu,
  // "prevádzkovateľovi X"
  /prevádzkovateľ(?:ovi|a)?\s+([\p{L}\s-]+(?:a\.s\.|s\.r\.o\.|k\.s\.))/gu,
  // Standalone entity with legal suffix
  /([\p{L}\s-]+(?:a\.s\.|s\.r\.o\.|k\.s\.))/gu,
];

function extractEntityName(text: string): string | null {
  // Try more specific patterns first (first two), then the generic one
  for (const re of ENTITY_PATTERNS.slice(0, 2)) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m?.[1]) {
      return m[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const SK_MONTHS: Record<string, string> = {
  januára: "01",
  januáru: "01",
  január: "01",
  "jan.": "01",
  februára: "02",
  februáru: "02",
  február: "02",
  "feb.": "02",
  marca: "03",
  marcu: "03",
  marec: "03",
  "mar.": "03",
  apríla: "04",
  aprílu: "04",
  apríl: "04",
  "apr.": "04",
  mája: "05",
  máju: "05",
  máj: "05",
  júna: "06",
  júnu: "06",
  jún: "06",
  júla: "07",
  júlu: "07",
  júl: "07",
  augusta: "08",
  augustu: "08",
  august: "08",
  "aug.": "08",
  septembra: "09",
  septembru: "09",
  september: "09",
  "sep.": "09",
  "sept.": "09",
  októbra: "10",
  októbru: "10",
  október: "10",
  "okt.": "10",
  novembra: "11",
  novembru: "11",
  november: "11",
  "nov.": "11",
  decembra: "12",
  decembru: "12",
  december: "12",
  "dec.": "12",
};

/**
 * Parse dates in formats:
 *   DD.MM.YYYY
 *   D. marca 2024
 *   DD. január 2024
 */
function parseDate(raw: string): string | null {
  // DD.MM.YYYY
  const dotMatch = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, d, m, y] = dotMatch;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // D. monthName YYYY
  const textMatch = raw.match(/(\d{1,2})\.\s*([\p{L}.]+)\s+(\d{4})/u);
  if (textMatch) {
    const [, d, monthStr, y] = textMatch;
    const mm = SK_MONTHS[monthStr!.toLowerCase()];
    if (mm) {
      return `${y}-${mm}-${d!.padStart(2, "0")}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Content classification — decision vs guideline
// ---------------------------------------------------------------------------

const DECISION_KEYWORDS = [
  "pokut",
  "pokutu",
  "sankci",
  "rozhodnutie",
  "rozhodnutia",
  "porušenie",
  "uložil",
  "uložila",
  "správny delikt",
  "kontrola zistila",
  "neoprávnený prístup",
  "bezpečnostný incident",
  "GDPR enforcement",
  "fine",
  "penalty",
  "dozorná činnosť",
  "nápravné opatrenie",
];

const GUIDELINE_KEYWORDS = [
  "usmernenie",
  "usmernenia",
  "metodický pokyn",
  "metodické usmernenie",
  "príručka",
  "stanovisko",
  "stanoviská",
  "odporúčanie",
  "odporúčania",
  "recommendations",
  "guidelines",
  "guidance",
  "opinion",
  "pracovná skupina",
  "working party",
  "EDPB",
  "vyhlásenie",
  "statement",
  "deklarácia",
];

/** Skip patterns — internal affairs, hiring, events unrelated to data protection. */
const SKIP_KEYWORDS = [
  "výberové konanie",
  "výberového konania",
  "vnútorné výberové",
  "vonkajšie výberové",
  "pracovná ponuka",
  "voľné miesto",
  "verejné obstarávanie",
];

type ContentType = "decision" | "guideline" | "skip";

function classifyContent(title: string, body: string): ContentType {
  const combined = `${title} ${body}`.toLowerCase();

  // Check skip patterns first — these are always irrelevant
  if (SKIP_KEYWORDS.some((kw) => combined.includes(kw))) {
    return "skip";
  }

  const decisionScore = DECISION_KEYWORDS.reduce(
    (acc, kw) => acc + (combined.includes(kw) ? 1 : 0),
    0,
  );
  const guidelineScore = GUIDELINE_KEYWORDS.reduce(
    (acc, kw) => acc + (combined.includes(kw) ? 1 : 0),
    0,
  );

  if (decisionScore >= 2) return "decision";
  if (guidelineScore >= 1) return "guideline";
  if (decisionScore === 1 && guidelineScore === 0) return "decision";
  return "skip";
}

// ---------------------------------------------------------------------------
// Decision type classification
// ---------------------------------------------------------------------------

function classifyDecisionType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("pokut")) return "pokuta";
  if (lower.includes("upozorneni")) return "upozornenie";
  if (lower.includes("nápravné opatrenie")) return "nápravné_opatrenie";
  if (lower.includes("stanovisk")) return "stanovisko";
  return "rozhodnutie";
}

// ---------------------------------------------------------------------------
// Guideline type classification
// ---------------------------------------------------------------------------

function classifyGuidelineType(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes("metodický pokyn") ||
    lower.includes("metodické usmernenie")
  )
    return "metodický_pokyn";
  if (lower.includes("príručka")) return "príručka";
  if (lower.includes("stanovisk")) return "stanovisko";
  if (lower.includes("odporúčan")) return "odporúčanie";
  if (lower.includes("vyhlásenie") || lower.includes("statement"))
    return "vyhlásenie";
  if (lower.includes("výročná správa") || lower.includes("ročná správa"))
    return "výročná_správa";
  if (lower.includes("plán kontrol")) return "plán_kontrol";
  if (lower.includes("kódex správania")) return "kódex_správania";
  return "usmernenie";
}

// ---------------------------------------------------------------------------
// Reference generation
// ---------------------------------------------------------------------------

let refCounter = 0;

function generateReference(date: string | null, title: string): string {
  refCounter++;
  const year = date ? date.slice(0, 4) : "XXXX";
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  return `UOOU-SK-${year}-${String(refCounter).padStart(4, "0")}-${slug}`;
}

// ---------------------------------------------------------------------------
// HTML parsing — news list page
// ---------------------------------------------------------------------------

interface NewsListItem {
  title: string;
  url: string;
  date: string | null;
  category: string;
}

/**
 * Parse a paginated news list page from /sk/aktuality/?page=N.
 *
 * Each news item on the page follows this HTML pattern:
 *   <a href="/sk/aktuality/[slug].html">
 *     <img .../>
 *   </a>
 *   <a href="...">[DD.MM.YYYY] — [CATEGORY]</a>
 *   <h3><a href="/sk/aktuality/[slug].html">[TITLE]</a></h3>
 */
function parseNewsListPage(
  html: string,
  pageUrl: string,
): {
  items: NewsListItem[];
  maxPage: number;
} {
  const $ = cheerio.load(html);
  const items: NewsListItem[] = [];

  $("h3").each((_, el) => {
    const $h3 = $(el);
    const $link = $h3.find("a").first();
    if (!$link.length) return;

    const href = $link.attr("href");
    if (!href || !href.includes("/sk/aktuality/")) return;

    const title = $link.text().trim();
    if (!title) return;

    const fullUrl = new URL(href, pageUrl).toString();

    // Walk upward to parent container and look for date pattern
    const parentText = $h3.parent().text();
    const dateMatch = parentText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const date = dateMatch ? parseDate(dateMatch[1]!) : null;

    // Category extraction — look for UOOU/EDPB/EDPS labels in sibling text
    let category = "UOOU";
    const siblingLinks = $h3.parent().find("a");
    siblingLinks.each((_, sib) => {
      const sibText = $(sib).text().trim();
      if (/^(UOOU|EDPB|EDPS|EU|EÚ)/i.test(sibText)) {
        category = sibText;
      }
    });

    items.push({ title, url: fullUrl, date, category });
  });

  // Pagination — find the highest page number from pagination links
  // Pattern: /sk/aktuality/?page=N
  let maxPage = 1;
  $("a[href*='?page=']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const pageMatch = href.match(/[?&]page=(\d+)/);
    if (pageMatch) {
      const p = Number.parseInt(pageMatch[1]!, 10);
      if (p > maxPage) maxPage = p;
    }
  });

  return { items, maxPage };
}

// ---------------------------------------------------------------------------
// HTML parsing — article detail page
// ---------------------------------------------------------------------------

interface ArticleDetail {
  title: string;
  date: string | null;
  bodyText: string;
  bodyHtml: string;
}

function parseArticlePage(html: string): ArticleDetail {
  const $ = cheerio.load(html);

  // Title: the page uses <h3> for article titles, <h1> for site name
  // Prefer the first h3 within content area, falling back to h1
  let title = "";
  const contentSelectors = [
    "article",
    ".content",
    ".article-content",
    ".node-content",
    "main",
    ".field-name-body",
  ];

  // Find best content container — use ReturnType to avoid cheerio version-specific type names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let $content: ReturnType<typeof $> = $("body") as any;
  for (const sel of contentSelectors) {
    const $candidate = $(sel);
    if ($candidate.length && $candidate.text().trim().length > 100) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $content = $candidate as any;
      break;
    }
  }

  // Extract title from heading tags
  const h3 = $content.find("h3").first().text().trim();
  const h1 = $("h1").first().text().trim();
  title = h3 || h1;

  // Clean breadcrumb noise from title
  if (title.includes(">")) {
    const parts = title.split(">");
    title = parts[parts.length - 1]!.trim();
  }
  // Strip "Slovensky" prefix if present (from breadcrumb leaking)
  title = title.replace(/^Slovensky\s*/i, "").trim();

  // Remove nav, footer, sidebar, scripts from content
  $content
    .find(
      "nav, footer, .sidebar, .menu, .navigation, header, script, style, .breadcrumb",
    )
    .remove();

  const bodyHtml = $content.html() ?? "";
  const bodyText = $content
    .text()
    .replace(/\s+/g, " ")
    .trim();

  // Date — look for date patterns in the page text
  const fullText = $.text();
  let date: string | null = null;

  const datePatterns = [
    /(\d{1,2}\.\s*(?:januára|februára|marca|apríla|mája|júna|júla|augusta|septembra|októbra|novembra|decembra)\s+\d{4})/iu,
    /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/,
  ];

  for (const pat of datePatterns) {
    const m = fullText.match(pat);
    if (m) {
      date = parseDate(m[1]!);
      if (date) break;
    }
  }

  return { title: title || "Bez názvu", date, bodyText, bodyHtml };
}

// ---------------------------------------------------------------------------
// HTML parsing — EDPB methodology list
// ---------------------------------------------------------------------------

interface EdpbDocument {
  title: string;
  pdfUrl: string;
}

/**
 * Parse the EDPB methodology listing page.
 *
 * Documents are listed as plain text headings with a "Stiahnuť" (Download)
 * link pointing to /files/metod-edpb/*.pdf, followed by file size in parens.
 * Some links have the document title as the link text itself.
 */
function parseEdpbPage(html: string): EdpbDocument[] {
  const $ = cheerio.load(html);
  const docs: EdpbDocument[] = [];
  const seen = new Set<string>();

  $("a[href$='.pdf']").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || !href.includes("/files/")) return;

    const pdfUrl = new URL(href, BASE_URL).toString();
    if (seen.has(pdfUrl)) return;
    seen.add(pdfUrl);

    let title = $a.text().trim();

    // If link text is just "Stiahnuť" (Download), extract title from context
    if (!title || title.toLowerCase() === "stiahnuť") {
      // Walk up to parent and collect preceding text nodes
      const $parent = $a.parent();
      const parentText = $parent.text().trim();
      // Remove the "Stiahnuť" and file size info
      const cleaned = parentText
        .replace(/stiahnuť/gi, "")
        .replace(/\(pdf,\s*[\d,.\s]+\s*[kKmM]B\)/gi, "")
        .trim();
      title =
        cleaned ||
        href
          .split("/")
          .pop()!
          .replace(".pdf", "")
          .replace(/[-_]/g, " ");
    }

    if (title) {
      docs.push({ title, pdfUrl });
    }
  });

  return docs;
}

// ---------------------------------------------------------------------------
// HTML parsing — ÚOOÚ methodology list (sub-pages)
// ---------------------------------------------------------------------------

interface MethodologyLink {
  title: string;
  url: string;
}

function parseMethodologyListPage(html: string): MethodologyLink[] {
  const $ = cheerio.load(html);
  const links: MethodologyLink[] = [];
  const seen = new Set<string>();

  $("a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    // Include internal methodology pages and PDF downloads
    const isMethodologyPage =
      href.includes("/metodiky-uradu/") ||
      href.includes("/metodicke-usmernenie") ||
      href.includes("/metodicky-pokyn");
    const isMethodologyPdf =
      href.includes("/files/") &&
      href.includes("metod") &&
      href.endsWith(".pdf");

    if (!isMethodologyPage && !isMethodologyPdf) return;
    // Skip self-links
    if (href === UOOU_METHODOLOGIES_PATH) return;

    const fullUrl = new URL(href, BASE_URL).toString();
    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    const title = $a.text().trim();
    if (title && title.length > 5) {
      links.push({ title, url: fullUrl });
    }
  });

  return links;
}

// ---------------------------------------------------------------------------
// HTML parsing — annual reports page
// ---------------------------------------------------------------------------

interface AnnualReportLink {
  title: string;
  url: string;
  year: number | null;
}

function parseAnnualReportsPage(html: string): AnnualReportLink[] {
  const $ = cheerio.load(html);
  const reports: AnnualReportLink[] = [];
  const seen = new Set<string>();

  // Annual reports link to PDFs in /files/annual-reports/
  $("a[href*='/files/annual-reports/'], a[href*='vyrocn'], a[href*='sprava']").each(
    (_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      if (!href) return;

      const fullUrl = new URL(href, BASE_URL).toString();
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      let title = $a.text().trim();
      if (!title || title.toLowerCase() === "stiahnuť") {
        const $parent = $a.parent();
        title = $parent
          .text()
          .replace(/stiahnuť/gi, "")
          .replace(/\(pdf,\s*[\d,.\s]+\s*[kKmM]B\)/gi, "")
          .trim();
      }

      if (!title || title.length < 5) return;

      // Extract year from title or filename
      const yearMatch =
        title.match(/(\d{4})/) ?? href.match(/(\d{4})/);
      const year = yearMatch
        ? Number.parseInt(yearMatch[1]!, 10)
        : null;

      reports.push({ title, url: fullUrl, year });
    },
  );

  return reports;
}

// ---------------------------------------------------------------------------
// HTML parsing — control plan page
// ---------------------------------------------------------------------------

function parseControlPlanPage(
  html: string,
  year: number,
): ArticleDetail {
  const detail = parseArticlePage(html);
  // Override title if generic
  if (
    !detail.title ||
    detail.title === "Bez názvu" ||
    !detail.title.toLowerCase().includes("kontrol")
  ) {
    detail.title = `Plán kontrol na rok ${year}`;
  }
  // Set date to Jan 1 of that year if no date found
  if (!detail.date) {
    detail.date = `${year}-01-01`;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

interface InsertDecisionParams {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

interface InsertGuidelineParams {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

function prepareStatements(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (:reference, :title, :date, :type, :entity_name, :fine_amount, :summary, :full_text, :topics, :gdpr_articles, :status)
  `);

  const insertGuideline = db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (:reference, :title, :date, :type, :summary, :full_text, :topics, :language)
  `);

  const checkDecisionExists = db.prepare(
    "SELECT 1 FROM decisions WHERE reference = ? LIMIT 1",
  );

  const checkGuidelineByTitle = db.prepare(
    "SELECT 1 FROM guidelines WHERE title = ? LIMIT 1",
  );

  return {
    insertDecision,
    insertGuideline,
    checkDecisionExists,
    checkGuidelineByTitle,
  };
}

// ---------------------------------------------------------------------------
// Summary generation (first ~500 chars of body, cut at sentence boundary)
// ---------------------------------------------------------------------------

function makeSummary(text: string, maxLen = 500): string {
  const cleaned = text.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLen) return cleaned;

  // Cut at last sentence boundary before maxLen
  const truncated = cleaned.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(".");
  if (lastPeriod > maxLen * 0.5) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return truncated + "...";
}

// ---------------------------------------------------------------------------
// Topics seeding
// ---------------------------------------------------------------------------

function seedTopics(db: Database.Database): void {
  const insertTopic = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const topics = [
    {
      id: "consent",
      local: "Súhlas",
      en: "Consent",
      desc: "Získanie, platnosť a odvolanie súhlasu na spracúvanie osobných údajov (čl. 7 GDPR).",
    },
    {
      id: "cookies",
      local: "Súbory cookies a sledovacie nástroje",
      en: "Cookies and trackers",
      desc: "Ukladanie a čítanie súborov cookies a sledovacích nástrojov na zariadeniach používateľov (ePrivacy smernica).",
    },
    {
      id: "transfers",
      local: "Medzinárodné prenosy osobných údajov",
      en: "International transfers",
      desc: "Prenos osobných údajov do tretích krajín alebo medzinárodným organizáciám (čl. 44-49 GDPR).",
    },
    {
      id: "dpia",
      local: "Posúdenie vplyvu na ochranu údajov (DPIA)",
      en: "Data Protection Impact Assessment (DPIA)",
      desc: "Posúdenie rizík pre práva a slobody dotknutých osôb pri spracúvaní s vysokým rizikom (čl. 35 GDPR).",
    },
    {
      id: "breach_notification",
      local: "Porušenie ochrany osobných údajov",
      en: "Data breach notification",
      desc: "Oznamovanie porušení ÚOOÚ SR a dotknutým osobám (čl. 33-34 GDPR).",
    },
    {
      id: "privacy_by_design",
      local: "Ochrana súkromia už v štádiu návrhu",
      en: "Privacy by design",
      desc: "Integrácia ochrany údajov pri návrhu a predvolené nastavenia (čl. 25 GDPR).",
    },
    {
      id: "employee_monitoring",
      local: "Monitorovanie zamestnancov",
      en: "Employee monitoring",
      desc: "Spracúvanie osobných údajov v pracovnoprávnych vzťahoch a monitorovanie zamestnancov.",
    },
    {
      id: "health_data",
      local: "Zdravotné údaje",
      en: "Health data",
      desc: "Spracúvanie zdravotných údajov — osobitné kategórie s posilnenou ochranou (čl. 9 GDPR).",
    },
    {
      id: "children",
      local: "Údaje detí",
      en: "Children's data",
      desc: "Ochrana osobných údajov maloletých v online službách (čl. 8 GDPR).",
    },
    {
      id: "profiling",
      local: "Profilovanie a automatizované rozhodovanie",
      en: "Profiling and automated decision-making",
      desc: "Automatizované individuálne rozhodovanie vrátane profilovania (čl. 22 GDPR).",
    },
    {
      id: "transparency",
      local: "Transparentnosť",
      en: "Transparency",
      desc: "Informačná povinnosť a transparentnosť spracúvania (čl. 13-14 GDPR).",
    },
    {
      id: "dpo",
      local: "Zodpovedná osoba (DPO)",
      en: "Data Protection Officer",
      desc: "Určenie, postavenie a úlohy zodpovednej osoby (čl. 37-39 GDPR).",
    },
    {
      id: "data_subject_rights",
      local: "Práva dotknutých osôb",
      en: "Data subject rights",
      desc: "Právo na prístup, výmaz, prenosnosť a ďalšie práva dotknutých osôb (čl. 15-21 GDPR).",
    },
    {
      id: "codes_of_conduct",
      local: "Kódexy správania a certifikácia",
      en: "Codes of conduct and certification",
      desc: "Kódexy správania, certifikačné mechanizmy a monitorovacie orgány (čl. 40-43 GDPR).",
    },
    {
      id: "law_enforcement",
      local: "Presadzovanie práva",
      en: "Law enforcement",
      desc: "Spracúvanie osobných údajov na účely presadzovania práva (smernica 2016/680).",
    },
  ];

  const tx = db.transaction(() => {
    for (const t of topics) {
      insertTopic.run(t.id, t.local, t.en, t.desc);
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// Crawl stats
// ---------------------------------------------------------------------------

interface CrawlStats {
  pagesScanned: number;
  itemsFound: number;
  decisionsInserted: number;
  guidelinesInserted: number;
  skipped: number;
  errors: number;
}

function emptyStats(): CrawlStats {
  return {
    pagesScanned: 0,
    itemsFound: 0,
    decisionsInserted: 0,
    guidelinesInserted: 0,
    skipped: 0,
    errors: 0,
  };
}

function mergeStats(target: CrawlStats, source: CrawlStats): void {
  target.pagesScanned += source.pagesScanned;
  target.itemsFound += source.itemsFound;
  target.decisionsInserted += source.decisionsInserted;
  target.guidelinesInserted += source.guidelinesInserted;
  target.skipped += source.skipped;
  target.errors += source.errors;
}

// ---------------------------------------------------------------------------
// Guideline insert helper
// ---------------------------------------------------------------------------

function insertGuidelineRecord(
  stmts: ReturnType<typeof prepareStatements>,
  params: InsertGuidelineParams,
  stats: CrawlStats,
): void {
  const exists = stmts.checkGuidelineByTitle.get(params.title);
  if (exists) {
    stats.skipped++;
    return;
  }
  try {
    stmts.insertGuideline.run(params);
    stats.guidelinesInserted++;
  } catch (err) {
    console.error(
      `  DB error: ${err instanceof Error ? err.message : String(err)}`,
    );
    stats.errors++;
  }
}

// ---------------------------------------------------------------------------
// Section: Aktuality (news) crawl
// ---------------------------------------------------------------------------

async function crawlNews(
  db: Database.Database | null,
  args: CliArgs,
  state: IngestState,
  stmts: ReturnType<typeof prepareStatements> | null,
): Promise<CrawlStats> {
  const stats = emptyStats();

  console.log(
    "\n--- Sekcia: Aktuality (rozhodnutia, usmernenia, správy) ---",
  );

  // Discover total pages
  const firstPageUrl = `${BASE_URL}${NEWS_PATH}?page=1`;
  console.log(`Fetching first page to discover pagination: ${firstPageUrl}`);
  const firstResult = await fetchPage(firstPageUrl);

  if (firstResult.status !== 200) {
    console.error(
      `Failed to fetch news page 1: HTTP ${firstResult.status}`,
    );
    stats.errors++;
    return stats;
  }

  const { items: firstItems, maxPage } = parseNewsListPage(
    firstResult.body,
    firstPageUrl,
  );
  console.log(`Found ${maxPage} pages of aktuality`);

  const startPage = args.resume ? Math.max(state.lastNewsPage, 1) : 1;
  const ingestedSet = new Set(state.ingestedUrls);
  let detailCount = 0;

  for (let page = startPage; page <= maxPage; page++) {
    if (args.limit !== null && detailCount >= args.limit) {
      console.log(`  Reached --limit ${args.limit}, stopping news crawl`);
      break;
    }

    let items: NewsListItem[];
    if (page === 1 && startPage === 1) {
      items = firstItems;
    } else {
      const pageUrl = `${BASE_URL}${NEWS_PATH}?page=${page}`;
      console.log(`  Fetching page ${page}/${maxPage}: ${pageUrl}`);
      const result = await fetchPage(pageUrl);
      if (result.status !== 200) {
        console.warn(`  Skipping page ${page}: HTTP ${result.status}`);
        stats.errors++;
        continue;
      }
      items = parseNewsListPage(result.body, pageUrl).items;
    }

    stats.pagesScanned++;
    stats.itemsFound += items.length;
    console.log(`  Page ${page}: ${items.length} items`);

    for (const item of items) {
      if (args.limit !== null && detailCount >= args.limit) break;

      if (args.resume && ingestedSet.has(item.url)) {
        stats.skipped++;
        continue;
      }

      // Fetch detail page
      console.log(`    Fetching: ${item.title.slice(0, 80)}...`);
      let detail: ArticleDetail;
      try {
        const detailResult = await fetchPage(item.url);
        if (detailResult.status !== 200) {
          console.warn(
            `    Skipping (HTTP ${detailResult.status}): ${item.url}`,
          );
          stats.errors++;
          continue;
        }
        detail = parseArticlePage(detailResult.body);
        detailCount++;
      } catch (err) {
        console.error(
          `    Error fetching ${item.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        stats.errors++;
        continue;
      }

      // Use the list date if detail page date extraction failed
      const date = detail.date ?? item.date;

      // Classify content
      const contentType = classifyContent(
        detail.title || item.title,
        detail.bodyText,
      );

      if (contentType === "skip") {
        stats.skipped++;
        if (!args.dryRun) {
          ingestedSet.add(item.url);
          state.ingestedUrls.push(item.url);
        }
        continue;
      }

      const title = detail.title || item.title;
      const topics = classifyTopics(`${title} ${detail.bodyText}`);
      const gdprArticles = extractGdprArticles(detail.bodyText);

      if (contentType === "decision") {
        const reference = generateReference(date, title);
        const entityName = extractEntityName(detail.bodyText);
        const fineAmount = extractFine(detail.bodyText);
        const decisionType = classifyDecisionType(
          `${title} ${detail.bodyText}`,
        );
        const summary = makeSummary(detail.bodyText);

        if (args.dryRun) {
          console.log(`    [DRY-RUN] DECISION: ${reference}`);
          console.log(`      title: ${title.slice(0, 100)}`);
          console.log(
            `      type: ${decisionType}, entity: ${entityName ?? "N/A"}, fine: ${fineAmount ?? "N/A"} EUR`,
          );
          console.log(`      topics: ${topics.join(", ") || "none"}`);
          console.log(
            `      GDPR articles: ${gdprArticles.join(", ") || "none"}`,
          );
        } else if (stmts && db) {
          try {
            stmts.insertDecision.run({
              reference,
              title,
              date,
              type: decisionType,
              entity_name: entityName,
              fine_amount: fineAmount,
              summary,
              full_text: detail.bodyText,
              topics: JSON.stringify(topics),
              gdpr_articles: JSON.stringify(gdprArticles),
              status: "final",
            } satisfies InsertDecisionParams);
            stats.decisionsInserted++;
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.includes("UNIQUE constraint")
            ) {
              stats.skipped++;
            } else {
              console.error(
                `    DB error: ${err instanceof Error ? err.message : String(err)}`,
              );
              stats.errors++;
            }
          }
        }
      } else {
        // guideline
        const reference = generateReference(date, title);
        const guidelineType = classifyGuidelineType(
          `${title} ${detail.bodyText}`,
        );
        const summary = makeSummary(detail.bodyText);

        if (args.dryRun) {
          console.log(`    [DRY-RUN] GUIDELINE: ${reference}`);
          console.log(`      title: ${title.slice(0, 100)}`);
          console.log(`      type: ${guidelineType}`);
          console.log(`      topics: ${topics.join(", ") || "none"}`);
        } else if (stmts && db) {
          insertGuidelineRecord(
            stmts,
            {
              reference,
              title,
              date,
              type: guidelineType,
              summary,
              full_text: detail.bodyText,
              topics: JSON.stringify(topics),
              language: "sk",
            } satisfies InsertGuidelineParams,
            stats,
          );
        }
      }

      // Track URL for resume
      if (!args.dryRun) {
        ingestedSet.add(item.url);
        state.ingestedUrls.push(item.url);
        state.lastNewsPage = page;
      }
    }

    // Save state after each page (for resume)
    if (!args.dryRun) {
      state.lastRun = new Date().toISOString();
      saveState(state);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Section: EDPB methodologies
// ---------------------------------------------------------------------------

async function crawlEdpbMethodologies(
  db: Database.Database | null,
  args: CliArgs,
  state: IngestState,
  stmts: ReturnType<typeof prepareStatements> | null,
): Promise<CrawlStats> {
  const stats = emptyStats();

  console.log("\n--- Sekcia: EDPB metodiky (PDF dokumenty) ---");

  const listUrl = `${BASE_URL}${EDPB_PATH}`;
  console.log(`Fetching EDPB methodology list: ${listUrl}`);

  const result = await fetchPage(listUrl);
  if (result.status !== 200) {
    console.error(`Failed to fetch EDPB page: HTTP ${result.status}`);
    stats.errors++;
    return stats;
  }

  const docs = parseEdpbPage(result.body);
  stats.pagesScanned = 1;
  stats.itemsFound = docs.length;
  console.log(`Found ${docs.length} EDPB documents`);

  const ingestedSet = new Set(state.ingestedUrls);
  let count = 0;

  for (const doc of docs) {
    if (args.limit !== null && count >= args.limit) {
      console.log(`  Reached --limit ${args.limit}, stopping EDPB crawl`);
      break;
    }

    if (args.resume && ingestedSet.has(doc.pdfUrl)) {
      stats.skipped++;
      continue;
    }

    const topics = classifyTopics(doc.title);

    // Determine language from title pattern
    const isEnglish =
      /guidelines|recommendations|opinion|working\s*document|adopted|statement/i.test(
        doc.title,
      );
    const language = isEnglish ? "en" : "sk";

    const reference = `EDPB-${
      doc.pdfUrl
        .split("/")
        .pop()
        ?.replace(".pdf", "")
        .slice(0, 60) ?? "unknown"
    }`;

    if (args.dryRun) {
      console.log(`  [DRY-RUN] EDPB: ${doc.title.slice(0, 90)}`);
      console.log(`    pdf: ${doc.pdfUrl}`);
      console.log(
        `    lang: ${language}, topics: ${topics.join(", ") || "none"}`,
      );
    } else if (stmts && db) {
      insertGuidelineRecord(
        stmts,
        {
          reference,
          title: doc.title,
          date: null,
          type: "metodika_edpb",
          summary: `EDPB metodika/usmernenie: ${doc.title}. Dostupné na: ${doc.pdfUrl}`,
          full_text: `${doc.title}\n\nDokument EDPB dostupný na: ${doc.pdfUrl}\n\nTento dokument je metodikou/usmernením Európskeho výboru pre ochranu údajov (EDPB). Pre úplný text si pozrite PDF dokument.`,
          topics: JSON.stringify(topics),
          language,
        } satisfies InsertGuidelineParams,
        stats,
      );
    }

    if (!args.dryRun) {
      ingestedSet.add(doc.pdfUrl);
      state.ingestedUrls.push(doc.pdfUrl);
    }

    count++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Section: ÚOOÚ office methodologies
// ---------------------------------------------------------------------------

async function crawlUoouMethodologies(
  db: Database.Database | null,
  args: CliArgs,
  state: IngestState,
  stmts: ReturnType<typeof prepareStatements> | null,
): Promise<CrawlStats> {
  const stats = emptyStats();

  console.log("\n--- Sekcia: Metodiky úradu (ÚOOÚ SR) ---");

  const listUrl = `${BASE_URL}${UOOU_METHODOLOGIES_PATH}`;
  console.log(`Fetching ÚOOÚ methodology list: ${listUrl}`);

  const result = await fetchPage(listUrl);
  if (result.status !== 200) {
    console.error(
      `Failed to fetch ÚOOÚ methodologies page: HTTP ${result.status}`,
    );
    stats.errors++;
    return stats;
  }

  stats.pagesScanned = 1;
  const links = parseMethodologyListPage(result.body);
  stats.itemsFound = links.length;

  if (links.length === 0) {
    // The ÚOOÚ methodology page sometimes shows a stub message:
    // "Dokumenty aktualizujeme. Na stránku ich budeme dopĺňať priebežne."
    console.log(
      "  No methodology sub-pages found (page may be under construction)",
    );
    return stats;
  }

  console.log(`Found ${links.length} methodology links`);

  const ingestedSet = new Set(state.ingestedUrls);
  let count = 0;

  for (const link of links) {
    if (args.limit !== null && count >= args.limit) {
      console.log(
        `  Reached --limit ${args.limit}, stopping methodology crawl`,
      );
      break;
    }

    if (args.resume && ingestedSet.has(link.url)) {
      stats.skipped++;
      continue;
    }

    // Handle PDF links directly (no detail page to fetch)
    if (link.url.endsWith(".pdf")) {
      const topics = classifyTopics(link.title);
      const reference = generateReference(null, link.title);

      if (args.dryRun) {
        console.log(
          `  [DRY-RUN] METHODOLOGY (PDF): ${link.title.slice(0, 90)}`,
        );
        console.log(`    url: ${link.url}`);
      } else if (stmts && db) {
        insertGuidelineRecord(
          stmts,
          {
            reference,
            title: link.title,
            date: null,
            type: "metodický_pokyn",
            summary: `Metodický pokyn ÚOOÚ SR: ${link.title}. Dostupné na: ${link.url}`,
            full_text: `${link.title}\n\nDokument ÚOOÚ SR dostupný na: ${link.url}\n\nPre úplný text si pozrite PDF dokument.`,
            topics: JSON.stringify(topics),
            language: "sk",
          },
          stats,
        );
      }

      if (!args.dryRun) {
        ingestedSet.add(link.url);
        state.ingestedUrls.push(link.url);
      }
      count++;
      continue;
    }

    // Fetch HTML detail page
    console.log(`  Fetching: ${link.title.slice(0, 80)}...`);
    let detail: ArticleDetail;
    try {
      const detailResult = await fetchPage(link.url);
      if (detailResult.status !== 200) {
        console.warn(
          `  Skipping (HTTP ${detailResult.status}): ${link.url}`,
        );
        stats.errors++;
        continue;
      }
      detail = parseArticlePage(detailResult.body);
      count++;
    } catch (err) {
      console.error(
        `  Error fetching ${link.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
      continue;
    }

    const title = detail.title || link.title;
    const topics = classifyTopics(`${title} ${detail.bodyText}`);
    const reference = generateReference(detail.date, title);
    const summary = makeSummary(detail.bodyText);

    if (args.dryRun) {
      console.log(`  [DRY-RUN] METHODOLOGY: ${reference}`);
      console.log(`    title: ${title.slice(0, 100)}`);
      console.log(`    topics: ${topics.join(", ") || "none"}`);
    } else if (stmts && db) {
      insertGuidelineRecord(
        stmts,
        {
          reference,
          title,
          date: detail.date,
          type: "metodický_pokyn",
          summary,
          full_text: detail.bodyText,
          topics: JSON.stringify(topics),
          language: "sk",
        },
        stats,
      );
    }

    if (!args.dryRun) {
      ingestedSet.add(link.url);
      state.ingestedUrls.push(link.url);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Section: Annual reports
// ---------------------------------------------------------------------------

async function crawlAnnualReports(
  db: Database.Database | null,
  args: CliArgs,
  state: IngestState,
  stmts: ReturnType<typeof prepareStatements> | null,
): Promise<CrawlStats> {
  const stats = emptyStats();

  console.log("\n--- Sekcia: Výročné správy (ročné správy ÚOOÚ SR) ---");

  const listUrl = `${BASE_URL}${ANNUAL_REPORTS_PATH}`;
  console.log(`Fetching annual reports page: ${listUrl}`);

  const result = await fetchPage(listUrl);
  if (result.status !== 200) {
    console.error(
      `Failed to fetch annual reports page: HTTP ${result.status}`,
    );
    stats.errors++;
    return stats;
  }

  stats.pagesScanned = 1;
  const reports = parseAnnualReportsPage(result.body);
  stats.itemsFound = reports.length;
  console.log(`Found ${reports.length} annual report links`);

  const ingestedSet = new Set(state.ingestedUrls);
  let count = 0;

  for (const report of reports) {
    if (args.limit !== null && count >= args.limit) {
      console.log(
        `  Reached --limit ${args.limit}, stopping reports crawl`,
      );
      break;
    }

    if (args.resume && ingestedSet.has(report.url)) {
      stats.skipped++;
      continue;
    }

    const topics = classifyTopics(report.title);
    const date = report.year ? `${report.year}-01-01` : null;
    const reference = generateReference(date, report.title);

    if (args.dryRun) {
      console.log(
        `  [DRY-RUN] REPORT: ${report.title.slice(0, 90)} (${report.year ?? "N/A"})`,
      );
      console.log(`    url: ${report.url}`);
    } else if (stmts && db) {
      insertGuidelineRecord(
        stmts,
        {
          reference,
          title: report.title,
          date,
          type: "výročná_správa",
          summary: `Výročná správa ÚOOÚ SR: ${report.title}. Obsahuje prehľad dozornej činnosti, rozhodnutí, uložených pokút a štatistík za dané obdobie. Dostupné na: ${report.url}`,
          full_text: `${report.title}\n\nVýročná správa Úradu na ochranu osobných údajov Slovenskej republiky.\n\nDokument dostupný na: ${report.url}\n\nPre úplný text vrátane štatistík dozornej činnosti, uložených pokút a prehľadu rozhodnutí si pozrite PDF dokument.`,
          topics: JSON.stringify(topics),
          language: "sk",
        },
        stats,
      );
    }

    if (!args.dryRun) {
      ingestedSet.add(report.url);
      state.ingestedUrls.push(report.url);
    }

    count++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Section: Control plans
// ---------------------------------------------------------------------------

async function crawlControlPlans(
  db: Database.Database | null,
  args: CliArgs,
  state: IngestState,
  stmts: ReturnType<typeof prepareStatements> | null,
): Promise<CrawlStats> {
  const stats = emptyStats();

  console.log("\n--- Sekcia: Plány kontrol (inšpekčné plány ÚOOÚ SR) ---");

  const ingestedSet = new Set(state.ingestedUrls);
  let count = 0;

  for (const year of CONTROL_PLAN_YEARS) {
    if (args.limit !== null && count >= args.limit) {
      console.log(
        `  Reached --limit ${args.limit}, stopping plans crawl`,
      );
      break;
    }

    const planUrl = `${BASE_URL}${CONTROL_PLANS_BASE_PATH}plan-kontrol-rok-${year}/`;

    if (args.resume && ingestedSet.has(planUrl)) {
      stats.skipped++;
      continue;
    }

    console.log(`  Fetching control plan ${year}: ${planUrl}`);

    try {
      const result = await fetchPage(planUrl);
      if (result.status !== 200) {
        console.log(
          `  No control plan found for ${year} (HTTP ${result.status})`,
        );
        continue;
      }

      stats.pagesScanned++;
      const detail = parseControlPlanPage(result.body, year);

      // Skip pages with very little content (likely placeholder/stub pages)
      if (detail.bodyText.length < 100) {
        console.log(`  Skipping ${year}: page has too little content`);
        continue;
      }

      stats.itemsFound++;
      const title = detail.title;
      const topics = classifyTopics(`${title} ${detail.bodyText}`);
      const reference = generateReference(detail.date, title);
      const summary = makeSummary(detail.bodyText);

      if (args.dryRun) {
        console.log(`  [DRY-RUN] CONTROL PLAN: ${title}`);
        console.log(
          `    topics: ${topics.join(", ") || "none"}`,
        );
        console.log(`    body length: ${detail.bodyText.length} chars`);
      } else if (stmts && db) {
        insertGuidelineRecord(
          stmts,
          {
            reference,
            title,
            date: detail.date,
            type: "plán_kontrol",
            summary,
            full_text: detail.bodyText,
            topics: JSON.stringify(topics),
            language: "sk",
          },
          stats,
        );
      }

      if (!args.dryRun) {
        ingestedSet.add(planUrl);
        state.ingestedUrls.push(planUrl);
      }

      count++;
    } catch (err) {
      console.error(
        `  Error fetching plan for ${year}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("ÚOOÚ SR Ingestion Crawler");
  console.log("=".repeat(60));
  console.log(`  Source:      ${BASE_URL}`);
  console.log(`  Database:    ${DB_PATH}`);
  console.log(`  Mode:        ${args.dryRun ? "DRY-RUN" : "WRITE"}`);
  console.log(`  Resume:      ${args.resume}`);
  console.log(`  Force:       ${args.force}`);
  console.log(`  Section:     ${args.section}`);
  console.log(`  Limit:       ${args.limit ?? "none"}`);
  console.log(`  Rate limit:  ${RATE_LIMIT_MS}ms between requests`);
  console.log(`  Max retries: ${MAX_RETRIES} (exponential backoff)`);
  console.log(`  State file:  ${STATE_FILE}`);
  console.log("=".repeat(60));

  // Open DB (unless dry-run)
  let db: Database.Database | null = null;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  if (!args.dryRun) {
    db = openDb(args.force);
    seedTopics(db);
    stmts = prepareStatements(db);
    console.log("Database initialised and topics seeded");
  }

  const state = args.resume
    ? loadState()
    : { ingestedUrls: [], lastNewsPage: 0, lastRun: "" };

  if (args.resume && state.lastRun) {
    console.log(
      `Resuming from previous run (${state.lastRun}), ${state.ingestedUrls.length} URLs already processed`,
    );
  }

  const allStats = emptyStats();

  // Run selected sections
  if (args.section === "all" || args.section === "news") {
    mergeStats(allStats, await crawlNews(db, args, state, stmts));
  }

  if (args.section === "all" || args.section === "edpb") {
    mergeStats(
      allStats,
      await crawlEdpbMethodologies(db, args, state, stmts),
    );
  }

  if (args.section === "all" || args.section === "methodologies") {
    mergeStats(
      allStats,
      await crawlUoouMethodologies(db, args, state, stmts),
    );
  }

  if (args.section === "all" || args.section === "reports") {
    mergeStats(
      allStats,
      await crawlAnnualReports(db, args, state, stmts),
    );
  }

  if (args.section === "all" || args.section === "plans") {
    mergeStats(
      allStats,
      await crawlControlPlans(db, args, state, stmts),
    );
  }

  // Final state save
  if (!args.dryRun) {
    state.lastRun = new Date().toISOString();
    saveState(state);
  }

  // Report
  console.log("\n" + "=".repeat(60));
  console.log("Ingestion complete");
  console.log("=".repeat(60));
  console.log(`  Pages scanned:        ${allStats.pagesScanned}`);
  console.log(`  Items found:          ${allStats.itemsFound}`);
  console.log(`  Decisions inserted:   ${allStats.decisionsInserted}`);
  console.log(`  Guidelines inserted:  ${allStats.guidelinesInserted}`);
  console.log(`  Skipped:              ${allStats.skipped}`);
  console.log(`  Errors:               ${allStats.errors}`);

  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;
    const topicCount = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as {
        cnt: number;
      }
    ).cnt;

    console.log(`\nDatabase totals:`);
    console.log(`  Topics:     ${topicCount}`);
    console.log(`  Decisions:  ${decisionCount}`);
    console.log(`  Guidelines: ${guidelineCount}`);

    db.close();
  }

  console.log(`\nState file: ${STATE_FILE}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
