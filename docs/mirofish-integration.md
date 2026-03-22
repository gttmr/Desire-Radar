# MiroFish Integration Notes

- Upstream source: `third_party/MiroFish`
- Integration style: keep the Discord bot as the control plane and add a small predictor sidecar that mirrors MiroFish's `collect -> multi-agent reasoning -> report` pattern.
- Reused ideas:
  - separate report generation service
  - explicit bullish/bearish/report agent phases
  - Azure OpenAI-backed chat client contract
- Deliberately excluded from this repository:
  - graph-building pipeline
  - long-running social simulation
  - Zep memory infrastructure

This project now uses a narrower stock-report predictor because the target outcome is a morning Discord briefing, not a general-purpose simulation sandbox.
