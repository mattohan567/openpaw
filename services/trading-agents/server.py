"""
TradingAgents FastAPI sidecar for OpenPaw.

Wraps the TradingAgents framework in a REST API so the Node.js agent can call it.
Requires TradingAgents to be cloned and installed alongside this service.

Usage:
    cd services/trading-agents
    pip install -r requirements.txt
    python server.py
"""

import os
import sys
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Add TradingAgents to path if cloned locally
TRADING_AGENTS_PATH = Path(__file__).parent.parent.parent / "clone-references" / "TradingAgents"
if TRADING_AGENTS_PATH.exists():
    sys.path.insert(0, str(TRADING_AGENTS_PATH))

app = FastAPI(title="OpenPaw TradingAgents Sidecar", version="0.1.0")


class AnalyzeRequest(BaseModel):
    ticker: str
    date: str | None = None
    analysts: list[str] | None = None
    llm_provider: str | None = None
    deep_think_llm: str | None = None
    quick_think_llm: str | None = None


class AnalyzeResponse(BaseModel):
    ticker: str
    date: str
    decision: str  # BUY, SELL, HOLD
    reasoning: str
    analysts_used: list[str]
    raw_state: dict | None = None


@app.get("/health")
async def health():
    return {"status": "ok", "service": "trading-agents-sidecar"}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    try:
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.default_config import DEFAULT_CONFIG
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail=(
                "TradingAgents not installed. "
                "Run: cd clone-references/TradingAgents && pip install -r requirements.txt"
            ),
        )

    config = DEFAULT_CONFIG.copy()

    # Override LLM settings if provided
    if req.llm_provider:
        config["llm_provider"] = req.llm_provider
    if req.deep_think_llm:
        config["deep_think_llm"] = req.deep_think_llm
    if req.quick_think_llm:
        config["quick_think_llm"] = req.quick_think_llm

    # Default to Anthropic/Claude if ANTHROPIC_API_KEY is set
    if not req.llm_provider and os.environ.get("ANTHROPIC_API_KEY"):
        config["llm_provider"] = "anthropic"
        config["deep_think_llm"] = "claude-sonnet-4-20250514"
        config["quick_think_llm"] = "claude-haiku-4-5-20251001"

    analysts = req.analysts or ["market", "social", "news", "fundamentals"]
    date = req.date or datetime.now().strftime("%Y-%m-%d")

    try:
        ta = TradingAgentsGraph(
            selected_analysts=analysts,
            debug=False,
            config=config,
        )
        final_state, decision = ta.propagate(req.ticker.upper(), date)

        # Extract reasoning from the final state
        reasoning_parts = []
        if isinstance(final_state, dict):
            for key in ["market_report", "sentiment_report", "news_report", "fundamentals_report",
                        "bull_report", "bear_report", "investment_plan", "risk_report"]:
                if key in final_state and final_state[key]:
                    reasoning_parts.append(f"**{key.replace('_', ' ').title()}**:\n{final_state[key]}")

        return AnalyzeResponse(
            ticker=req.ticker.upper(),
            date=date,
            decision=decision or "HOLD",
            reasoning="\n\n".join(reasoning_parts) if reasoning_parts else str(final_state),
            analysts_used=analysts,
            raw_state=final_state if isinstance(final_state, dict) else None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


if __name__ == "__main__":
    port = int(os.environ.get("TRADING_AGENTS_PORT", "8100"))
    print(f"Starting TradingAgents sidecar on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port)
