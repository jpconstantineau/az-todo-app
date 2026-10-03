# Isolated Cosmos workload measurements (#27)

The existing [isolated rehearsal runner](cosmos-rehearsal.md) can collect synthetic
storage measurements using the production v1 store. From `api/` with Node 22.x
and locked dependencies installed:

```text
npm run test:cosmos -- --measure --isolated-account <new-report.jsonl>
```

Use the dedicated `COSMOS_REHEARSAL_CONNECTION_STRING` environment variable for
a **disposable** Cosmos NoSQL account. This creates and deletes a fresh database,
consumes Azure resources, and may incur charges. The same preflight, generated
target, non-overwritten report, interruption checkpoints and cleanup rules apply
as in the protocol rehearsal. Existing application credentials, databases,
records, receipts and client queues are not inputs. Run the protocol rehearsal
separately without `--measure`; measurement mode does not replace its checks.

## Fixed workload

Each of six cases gets its own synthetic account partition: small and near-limit
records, each with 1, 2 and 8 concurrent store callers. Callers share one SDK
client/session cache; these are not independent browsers or SDK clients.

Each case creates 100 items and edits each five times. The near-limit fixture
uses 16,000 original-text, 8,000 selection, 4,000 notes and 2,000 source-title
characters, producing approximately 30 KiB records below the 32 KiB record cap.
All operations pass the current contract validator. Independent item writes
still contend on the account state ETag. After the store exhausts its five batch
attempts, `account_busy` is recorded and the identical intent is retried once,
sequentially. Unexpected failures or failed recovery stop the run after all
in-flight writers settle, retain partial summaries, and trigger cleanup.

The runner reads initial history from cursor zero, incremental history after
the five edit rounds, and full history from zero again. It requests 50 entries
per page and checks contiguous sequences through the expected 100/600 cutoff.
Near-limit entries also exercise the store's approximately 1 MB page bound.
An acknowledged final edit is replayed unchanged and must require no new batch.

The complete workload makes 3,600 original commits, six receipt replays, and
bounded recovery attempts and reads. Cases run serially and remain in the
temporary container until cleanup, so later cases share its accumulated history
and provisioned resources. This is a repeatable workload, not a capacity sweep.

## Reading the evidence

The JSONL report includes the existing commit/dirty state, Node/locked SDK
versions, UTC times, consistency, write regions, partition/index configuration,
checks and cleanup status. Read its last complete line. `measurements` contains
case parameters, status, page totals/cutoffs and per-phase summaries:

- Sample count and nearest-rank p50/p95/p99 duration in milliseconds. Each sample
  is one store call, including its internal retries. Recovery calls have their
  own `retry-busy` phase. A small sample's p99 is often its maximum.
- Point-read count and batch-attempt count. Counts include failed calls; they
  exclude resource setup, cleanup and SDK-internal metadata/network requests.
- Known request charge, split by point reads and batches, from the SDK response
  header or an explicit `requestCharge`. Failed reads/batches contribute when
  they expose a charge. `missingChargeResponses` counts unavailable metrics;
  total `requestCharge` becomes `null` if any response lacks a charge. The known
  subtotal is not a complete RU cost in that case. A default-zero SDK getter
  does not establish that a missing header actually represents zero cost.
- SDK-visible 409/412/429/503 counts. Each response counts once per status,
  including batch suboperation statuses without double-counting them. These
  are **not** network-attempt totals: SDK retries can hide throttles, and SDK
  errors can omit numeric status/charge. Store `account_busy`, durable conflict,
  success and other failure outcomes are separate from SDK statuses.
- Serialized application response bytes, including pagination overhead, plus
  page count and total payload bytes. These are not HTTP transfer, compressed,
  database, index or billed-storage sizes.

Only numeric metrics, fixed phase labels and generated target IDs enter this
report. Task contents, credentials, raw SDK errors/diagnostics, endpoints and
response headers are not serialized. Failed work retains its summaries. A
killed process may leave only the prior checkpoint and require manual cleanup
of the exact recorded database, as described in the rehearsal guide.

SDK references: [item response charge](https://learn.microsoft.com/en-us/javascript/api/%40azure/cosmos/itemresponse)
and the installed SDK's batch response headers. No inference from mock timings
or JSON bytes is used to estimate RU.

## Verification and remaining gates

`api/test/cosmos-measurements.test.mjs` checks metric attribution with interleaved
calls, numeric/error redaction, missing charges, surfaced throttles, percentiles,
and all six workload shapes against the production store with in-memory Cosmos.
The local workload test uses 20 records/one edit round to keep the regression
small; the CLI always uses 100/five. Existing rehearsal tests retain preflight,
resource ownership, failure cleanup and report preservation coverage, including
measurement-mode opt-in. Run these with the existing Node test runner.

**Actual Azure RU, latency and capacity remain unverified until an isolated run
is recorded.** PASS means these checks completed and cleanup succeeded, not that
performance met a release budget. Agree numeric budgets and sample sizes first.
Attach the report and operator/environment identity to the release record, along
with provisioned/autoscale/serverless throughput, observed container/account and
indexed storage (including measurement time and units), and relevant Azure
metrics. This runner does not read those operational metrics.

Also still required for #27: independent-client session behavior, real SWA
authentication/isolation and browser conflict recovery; HTTP end-to-end latency;
physical device evidence; representative longer workloads and competing account
traffic. Cursor-zero catch-up is not a cold Cosmos/SDK cache guarantee. Do not
change partitioning, purge history, close #27, or certify paid-pilot readiness
from a local test or this synthetic benchmark alone.
