# demo-sp500-investor-report

Workflow example that accepts the S&P 500 top-50 reports ZIP as input, calls an
unzip-backed harness tool, and returns a Markdown investor report with
per-company sections plus recommended stocks.

## Run

```bash
export DEEPSEEK_API_KEY=...
# optional; defaults to deepseek-v4-pro
export DEEPSEEK_MODEL_ID=deepseek-v4-pro
# optional; defaults to https://api.deepseek.com/v1
export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

pnpm --filter little-workflow build
pnpm --filter demo-sp500-investor-report demo:live -- \
  --archive path/to/sp500_top50_reports.zip \
  --limit 50 \
  --recommendations 5 \
  --out sp500-investor-report.md
```

Keyless smoke run:

```bash
pnpm --filter demo-sp500-investor-report demo:stub -- \
  --archive path/to/sp500_top50_reports.zip \
  --limit 5
```

The workflow input is the ZIP path. The first workflow step calls
`sp500.unzip_company_dossiers`, which verifies `unzip` is available and reads
the archive contents directly. It compacts holdings, company profiles, filing
indexes, and SEC companyfacts before DeepSeek writes the report.

## Tests

```bash
pnpm --filter demo-sp500-investor-report test:dataset
pnpm --filter demo-sp500-investor-report test:lwir
pnpm --filter demo-sp500-investor-report test:markdown
pnpm --filter demo-sp500-investor-report test:run-cli
```
