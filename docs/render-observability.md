# Render observability and resilience

This layer makes Lion Elite OS observable and safer to operate on Render.

## Structured logs

Application and worker events are emitted as one-line JSON. Each event includes timestamp, level, event name, service, environment, instance, and relevant request or job identifiers. Render log search can filter on fields such as `event`, `queue`, `jobId`, `requestId`, and `level`.

## Worker heartbeat

The outreach worker writes a Redis heartbeat every 15 seconds. The heartbeat includes worker count, configured concurrency, queue backlog, process uptime, and memory usage. The key expires automatically, so a missing key indicates that the worker is unavailable or stalled.

## Health surfaces

The worker exposes:

- `/health` for liveness
- `/ready` for readiness
- `/metrics` for Redis, queue, runtime, memory, and worker metrics

## Automated operations monitor

The `lion-elite-operations-monitor` Render cron job runs every five minutes and checks:

- PostgreSQL health
- Redis health
- Worker heartbeat freshness
- Total waiting jobs
- Total failed jobs
- Queue-by-queue status

It stores the most recent result in Redis under `ops:last-check` and emits a structured warning when any threshold is exceeded.

## Default alert thresholds

- Worker heartbeat older than 60 seconds
- Waiting queue jobs at or above 100
- Failed jobs at or above 10

All thresholds are configurable through environment variables.

## Graceful shutdown

On SIGTERM or SIGINT, the worker stops accepting new work, closes BullMQ workers, closes Redis, shuts down its health server, and exits. A 30-second forced-shutdown timeout prevents indefinite deploy hangs.

## Recommended Render usage

Use Render log filters for `level=warn` and `level=error`, and connect Render log streaming or notification integrations to route these events to the team. Scale worker concurrency or instance count when `queue.lag_high` appears repeatedly rather than only increasing API capacity.
