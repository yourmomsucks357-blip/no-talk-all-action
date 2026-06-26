import "dotenv/config";
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";

type Vehicle = { year: number; make: string; model: string; engine: string };
type TargetPart = {
  key: string;
  label: string;
  must: string[];
  reject: string[];
  min: number;
  max: number;
  factor: number;
  queries: string[];
};
type RawListing = {
  source: string;
  partKey: string;
  partLabel: string;
  query: string;
  title: string;
  price: number | null;
  shipping: number | null;
  currency: string;
  url: string;
  snippet: string | null;
  dateFound: string;
};
type CleanComp = RawListing & { totalPrice: number; score: number; rejected: boolean; rejectReason: string | null };

const program = new Command()
  .option("--year <n>", "vehicle year", "2017")
  .option("--make <s>", "vehicle make", "Ford")
  .option("--model <s>", "vehicle model", "F-150")
  .option("--engine <s>", "engine", "5.0L")
  .option("--sample", "run sample fixture without live APIs")
  .parse();

const opts = program.opts();
const vehicle: Vehicle = { year: Number(opts.year), make: opts.make, model: opts.model, engine: opts.engine };
const limit = Number(process.env.RESULTS_PER_QUERY || "10");

function buildTargets(v: Vehicle): TargetPart[] {
  const base = `${v.year} ${v.make} ${v.model} ${v.engine}`;
  return [
    { key: "engine", label: "Engine", must: ["engine", "motor"], reject: ["mount", "cover", "gasket", "sensor", "manual", "shirt", "toy"], min: 400, max: 9000, factor: 0.70, queries: [`${base} engine used OEM`, `${base} motor assembly used OEM`] },
    { key: "transmission", label: "Transmission", must: ["transmission"], reject: ["mount", "pan", "filter", "sensor", "line", "cooler"], min: 250, max: 6500, factor: 0.66, queries: [`${base} transmission used OEM`] },
    { key: "headlight", label: "Headlight", must: ["headlight", "headlamp"], reject: ["bulb", "switch", "cover", "film", "trim"], min: 40, max: 1800, factor: 0.58, queries: [`${base} headlight used OEM`, `${base} headlamp used`] },
    { key: "taillight", label: "Taillight", must: ["tail light", "taillight", "lamp"], reject: ["bulb", "cover", "sticker", "trim"], min: 35, max: 1200, factor: 0.55, queries: [`${base} tail light used OEM`, `${base} taillight used`] },
    { key: "wheel", label: "Wheel / Rim", must: ["wheel", "rim"], reject: ["cap", "lug", "nut", "tpms", "sensor"], min: 40, max: 1800, factor: 0.52, queries: [`${base} wheel rim used OEM`] },
    { key: "ecm", label: "ECM / ECU / PCM", must: ["ecm", "ecu", "pcm", "computer", "module"], reject: ["connector", "repair service", "programming only", "plug"], min: 40, max: 1600, factor: 0.48, queries: [`${base} ECM ECU PCM module used OEM`] },
    { key: "catalytic_converter", label: "Catalytic Converter", must: ["catalytic", "converter", "cat"], reject: ["shield", "oxygen sensor", "gasket", "defouler"], min: 50, max: 2500, factor: 0.55, queries: [`${base} catalytic converter used OEM`] }
  ];
}

function money(text?: string | null): number | null {
  if (!text) return null;
  const match = String(text).match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function collectSerpApi(query: string, part: TargetPart): Promise<RawListing[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  const sourceQueries = [
    "site:ebay.com/itm",
    "site:lkqpickyourpart.com OR site:pyp.com",
    "site:aesopauto.com",
    "site:car-part.com",
    "site:copart.com",
    "site:iaai.com"
  ];
  const out: RawListing[] = [];
  for (const sourceQuery of sourceQueries) {
    const q = `${sourceQuery} ${query}`;
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", q);
    url.searchParams.set("api_key", key);
    url.searchParams.set("num", String(limit));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpAPI failed ${res.status}`);
    const data: any = await res.json();
    const rows = [...(data.shopping_results || []), ...(data.organic_results || [])].slice(0, limit);
    for (const row of rows) {
      if (!row.link || !row.title) continue;
      out.push({
        source: new URL(row.link).hostname.replace(/^www\./, ""),
        partKey: part.key,
        partLabel: part.label,
        query: q,
        title: row.title,
        price: money(`${row.price || ""} ${row.title || ""} ${row.snippet || ""}`),
        shipping: null,
        currency: "USD",
        url: row.link,
        snippet: row.snippet || null,
        dateFound: new Date().toISOString()
      });
    }
  }
  return out;
}

async function collectEbayBrowse(query: string, part: TargetPart): Promise<RawListing[]> {
  const token = process.env.EBAY_OAUTH_TOKEN;
  if (!token) return [];
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query);
  url.searchParams.set("filter", "conditions:{USED}");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US"
    }
  });
  if (!res.ok) throw new Error(`eBay Browse API failed ${res.status}`);
  const data: any = await res.json();
  return (data.itemSummaries || []).map((item: any) => ({
    source: "ebay-browse-api",
    partKey: part.key,
    partLabel: part.label,
    query,
    title: item.title || "",
    price: money(item.price?.value),
    shipping: money(item.shippingOptions?.[0]?.shippingCost?.value),
    currency: item.price?.currency || "USD",
    url: item.itemWebUrl || "",
    snippet: item.shortDescription || null,
    dateFound: new Date().toISOString()
  })).filter((x: RawListing) => x.title && x.url);
}

function hasAny(text: string, words: string[]) {
  return words.some(word => text.includes(word.toLowerCase()));
}

function cleanAndScore(raw: RawListing[], part: TargetPart, v: Vehicle): CleanComp[] {
  const seen = new Set<string>();
  return raw.map(row => {
    const text = `${row.title} ${row.snippet || ""}`.toLowerCase();
    const totalPrice = (row.price || 0) + (row.shipping || 0);
    const reasons: string[] = [];
    let score = 0;

    if (!row.price || row.price <= 0) reasons.push("missing_price");
    if (totalPrice < part.min) reasons.push("below_part_floor");
    if (totalPrice > part.max) reasons.push("above_part_ceiling");
    if (hasAny(text, part.must)) score += 30; else reasons.push("missing_required_part_terms");
    if (hasAny(text, part.reject)) { score -= 35; reasons.push("wrong_part_or_noise_terms"); }
    if (text.includes(String(v.year))) score += 12;
    if (text.includes(v.make.toLowerCase())) score += 10;
    if (text.includes(v.model.toLowerCase()) || text.includes(v.model.toLowerCase().replace("-", ""))) score += 10;
    if (v.engine && text.includes(v.engine.toLowerCase().replace("l", ""))) score += 8;
    if (/used|oem|genuine|recycled|salvage/.test(text)) score += 12;
    if (/new|aftermarket|cover|repair service|programming only/.test(text)) score -= 12;

    const dupKey = `${row.source}|${row.title.toLowerCase().replace(/\s+/g, " ").trim()}|${Math.round(totalPrice)}`;
    if (seen.has(dupKey)) reasons.push("duplicate");
    seen.add(dupKey);

    const rejected = reasons.length > 0 || score < 25;
    return { ...row, totalPrice, score, rejected, rejectReason: rejected ? reasons.join(",") || "low_score" : null };
  });
}

function quantile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function valuePart(part: TargetPart, comps: CleanComp[]) {
  const usable = comps.filter(c => !c.rejected).sort((a, b) => b.score - a.score);
  const rejected = comps.filter(c => c.rejected);
  const prices = usable.map(c => c.totalPrice).filter(n => n > 0);
  let weighted: number | null = null;
  if (usable.length) {
    const weightSum = usable.reduce((sum, c) => sum + Math.max(1, c.score), 0);
    weighted = Math.round(usable.reduce((sum, c) => sum + c.totalPrice * Math.max(1, c.score), 0) / weightSum);
  }
  return {
    partKey: part.key,
    partLabel: part.label,
    rawCount: comps.length,
    usableCount: usable.length,
    rejectedCount: rejected.length,
    low: prices.length ? Math.round(quantile(prices, 0.20)!) : null,
    median: prices.length ? Math.round(quantile(prices, 0.50)!) : null,
    high: prices.length ? Math.round(quantile(prices, 0.80)!) : null,
    weighted,
    confidence: usable.length >= 8 ? "high" : usable.length >= 3 ? "medium" : usable.length ? "low" : "none",
    comps: usable.slice(0, 20),
    rejected: rejected.slice(0, 20)
  };
}

function sampleListings(parts: TargetPart[]): RawListing[] {
  const build = (partKey: string, title: string, price: number): RawListing => {
    const part = parts.find(p => p.key === partKey)!;
    return { source: "sample", partKey: part.key, partLabel: part.label, query: "sample", title, price, shipping: 50, currency: "USD", url: `https://example.com/${partKey}`, snippet: "used OEM salvage part", dateFound: new Date().toISOString() };
  };
  return [
    build("engine", "2017 Ford F150 5.0L Coyote Engine Motor Assembly OEM Used", 3650),
    build("transmission", "2017 Ford F150 Automatic Transmission Used OEM", 1850),
    build("headlight", "2017 Ford F-150 OEM Headlight Left Used", 425),
    build("taillight", "2017 Ford F150 Tail Light Lamp OEM Used", 210),
    build("wheel", "2017 Ford F150 20 inch OEM Wheel Rim Used", 275),
    build("ecm", "2017 Ford F150 5.0 ECM ECU PCM Computer Module OEM Used", 185),
    build("catalytic_converter", "2017 Ford F150 5.0 OEM Catalytic Converter Cat Used", 525)
  ];
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map(row => headers.map(h => escape(row[h])).join(","))].join("\n");
}

async function main() {
  const parts = buildTargets(vehicle);
  let raw: RawListing[] = [];

  if (opts.sample) {
    raw = sampleListings(parts);
  } else {
    if (!process.env.SERPAPI_KEY && !process.env.EBAY_OAUTH_TOKEN) {
      throw new Error("Add SERPAPI_KEY or EBAY_OAUTH_TOKEN, or run npm run sample.");
    }
    for (const part of parts) {
      for (const query of part.queries) {
        console.log(`Collecting ${part.label}: ${query}`);
        raw.push(...await collectEbayBrowse(query, part));
        raw.push(...await collectSerpApi(query, part));
      }
    }
  }

  const partReports = parts.map(part => valuePart(part, cleanAndScore(raw.filter(r => r.partKey === part.key), part, vehicle)));
  const gross = Math.round(partReports.reduce((sum, report) => sum + (report.weighted || 0) * (parts.find(p => p.key === report.partKey)?.factor || 0.5), 0));
  const recovery = {
    grossPartRecoveryEstimate: gross,
    realisticRecoveryLow: Math.round(gross * 0.68),
    realisticRecoveryHigh: Math.round(gross * 0.88)
  };

  const report = { generatedAt: new Date().toISOString(), vehicle, rawListingCount: raw.length, parts: partReports, recovery };
  await mkdir("output", { recursive: true });
  await writeFile("output/valuation-report.json", JSON.stringify(report, null, 2));
  await writeFile("output/evidence-comps.csv", toCsv(partReports.flatMap((p: any) => p.comps.map((c: any) => ({ part: p.partLabel, source: c.source, title: c.title, totalPrice: c.totalPrice, score: c.score, url: c.url })))));
  await writeFile("output/rejected-comps.csv", toCsv(partReports.flatMap((p: any) => p.rejected.map((c: any) => ({ part: p.partLabel, source: c.source, title: c.title, totalPrice: c.totalPrice, reason: c.rejectReason, url: c.url })))));
  console.log(JSON.stringify({ vehicle, rawListings: raw.length, recovery }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
