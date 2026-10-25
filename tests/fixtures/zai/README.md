Z.AI GLM Coding Plan quota fixtures (hand-written from the documented shapes, no real account data).
Times are relative to NOW = 2026-10-21T12:00:00Z (1792584000000): 5h reset NOW+2h, weekly NOW+3d, MCP NOW+10d.
Shapes: docs.z.ai/api-reference/api-code (errors); CodexBar docs/zai.md + Plugins/zai.js and opencode-glm-quota (quota/limit).
models-list.json: Z.AI and BigModel document no model list (checked 2026-10-25); the plugin asks the coding endpoint's
OpenAI-compatible GET /api/coding/paas/v4/models. This fixture is that OpenAI shape with GLM ids from docs.z.ai (GLM-5.3,
GLM-5.3-Flash, GLM-5.2, older GLM-4.x) plus vision, OCR, embedding and image ids that must be left out. It is not a captured answer.
