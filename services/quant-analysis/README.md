# Quant Analysis Sidecar

Pure math stock analysis service. No LLM calls. Deterministic signals for technical, fundamental, and sentiment analysis.

## Setup

```bash
cd services/quant-analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn server:app --host 0.0.0.0 --port 8200
```

## Endpoints

- `GET /health` — Health check
- `GET /analyze/{symbol}?period=6mo` — Full pipeline (technical + fundamentals + sentiment)
- `GET /technical/{symbol}?period=6mo` — Technical analysis only (5 strategies)
- `GET /fundamentals/{symbol}` — Fundamental scoring (profitability, growth, health, valuation)
- `GET /sentiment/{symbol}` — News headline sentiment

## Data Source

All data from yfinance (free, no API key). Cached for 5 minutes.
