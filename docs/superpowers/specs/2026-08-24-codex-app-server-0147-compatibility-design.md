# Codex App Server 0.147 Compatibility Design

## Goal

Make TaskMux start and operate against the locally installed latest Codex CLI,
currently `codex-cli 0.147.0`, while keeping browser startup resilient when a
future App Server handshake is unsupported.

## Verified cause

Codex 0.147.0 exposes a newline-delimited App Server protocol whose generated
`JSONRPCRequest` and `JSONRPCResponse` schemas do not contain a `jsonrpc`
property. A real initialize probe without that property returns immediately.
TaskMux currently writes `jsonrpc: "2.0"` and rejects responses without it, so
the real initialize request times out before the HTTP server starts.

## Protocol behavior

- Outbound App Server requests, notifications, and responses follow the current
  Codex 0.147.0 schema and omit `jsonrpc`.
- Inbound messages accept either the current format with no `jsonrpc` property
  or the former format with exactly `jsonrpc: "2.0"`.
- Any other explicit `jsonrpc` value remains a protocol error.
- Request IDs, method names, parameter payloads, timeouts, privacy filtering,
  approval handling, and lifecycle correlation remain unchanged.
- There is no timeout-based legacy resend because duplicate initialize or turn
  requests would be ambiguous and would slow startup.

## Startup resilience

Handshake timeout and invalid initialize-response failures are classified as
`codex_version_unsupported`. TaskMux still starts its loopback HTTP server and
renders the existing stable diagnostic action instead of terminating before the
browser can connect. Authentication failures retain their existing diagnostic.

## Verification

1. A JSON-RPC client regression test first proves outbound messages incorrectly
   contain `jsonrpc` and current-format responses are rejected.
2. Focused tests prove current-format round trips, former-format inbound
   compatibility, and rejection of invalid explicit versions.
3. Runtime tests prove handshake incompatibility becomes degraded health while
   the HTTP service remains available.
4. The full typecheck, unit, build, and browser E2E gates remain green.
5. A real local launch against Codex 0.147.0 must return HTTP 200 for `/` and a
   healthy `/api/health` response before the change is declared complete.

## Scope

This change does not add ACP, negotiate arbitrary protocol versions, alter the
browser wire contract, or expose raw Codex protocol data to the client.
