# Parts Intelligence Engine

Runnable TypeScript prototype for used auto-parts valuation.

It collects public listing evidence, cleans and scores comps, rejects bad matches, calculates part values, and writes evidence files you can inspect.

## Install

```bash
npm install
cp .env.example .env
```

## Run sample mode without API keys

```bash
npm run sample
```

## Run live mode

Add at least one key to `.env`:

```bash
SERPAPI_KEY=your_serpapi_key
EBAY_OAUTH_TOKEN=your_ebay_oauth_token
```

Then run:

```bash
npm run value -- --year 2017 --make Ford --model "F-150" --engine "5.0L"
```

## Output

- `output/valuation-report.json`
- `output/evidence-comps.csv`
- `output/rejected-comps.csv`

## What it searches

- eBay Browse API when `EBAY_OAUTH_TOKEN` is present
- Public web search through SerpAPI when `SERPAPI_KEY` is present
- Targeted source queries for eBay, LKQ/Pick Your Part, Aesop/Gray & White style listings, Car-Part, Copart, and IAA

This is only the parts valuation proof engine. It is not the marketplace, not the mobile app, and not the full OfferOnly platform.
