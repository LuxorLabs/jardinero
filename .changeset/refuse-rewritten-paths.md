---
"jardinero": patch
---

transport: refuse a request whose path the URL parser rewrites, so `/webhooks/github/%2e%2e/%2e%2e/dashboard` no longer reaches the dashboard
