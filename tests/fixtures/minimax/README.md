MiniMax Coding/Token Plan quota fixtures (hand-written from the documented shapes, no real account data).
Times are relative to NOW = 2026-10-21T12:00:00Z (1792584000000): the 5h window runs NOW-3h..NOW+2h, the week NOW-4d..NOW+3d.
Shapes: MiniMax-AI/cli (38aba5f) src/types/api.ts QuotaModelRemain, test/fixtures/quota-response.json, src/utils/quota.ts,
src/output/quota-table.ts (status 1 normal, 2 used up, 3 unlimited). error-usage-limit.json: MiniMax documents no body for a
plan's limit error; this one only carries the wording the parser looks for ("usage limit").
models-list.json: GET /v1/models as platform.minimax.io/docs/api-reference/models/openai/list-models documents it (object "list",
data[].id/object/created/owned_by; its sample lists MiniMax-M3, MiniMax-M2.7, MiniMax-M2.5), with MiniMax-M3.1-Flash and the
platform's video, speech and image models (platform.minimax.io/docs/faq/models) added to check that only M text models are kept.
