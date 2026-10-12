# JEV retry operations

## Observed repository behavior

The answer transaction creates a durable pending assessment for a saved free-text answer. After commit, the batch route uses Next.js `after()` to start one eligible job; this is a best-effort trigger, not a durable scheduler. The repository worker also accepts authenticated calls at `POST /api/internal/jev/retry` and processes at most five due jobs per call.

The worker claims a job with a 45-second lease and compare-and-set state transition. A successful response stores the graded result. Retryable failures return to pending with bounded exponential backoff; eight total attempts or a permanent provider failure ends in `failed`. Provider calls have a 30-second timeout. `?retryFailed=1` requeues failed jobs only when the request has the configured `JEV_RETRY_SECRET` bearer token. The batch save remains committed if the key is missing or a post-response worker trigger fails.

The provider adapter reads `TYPESAFE_API_KEY`, optional `TYPESAFE_MODEL` (default `jev-latest`), and optional `TYPESAFE_BASE_URL`. The request contains the current Q5 question, expected answer, user free text, rubric, and model. It does not include participant name, participant ID, or session cookie. Free text itself may contain identifying information. The current supported question/rubric version pair is `tamami-egg-v1`; raw score must be 0–2 and the presentation contribution is raw score divided by two. Confidence is stored but does not affect score.

## Deployment and response limits

There is no scheduler configuration, alert definition, cadence, or named operator in this repository. Confirm the deployed scheduler and responsibility with the deployment/operator role before promising retry completion. No polling interval or completion SLO is specified.

When investigating a backlog, first use the deployment's existing authenticated scheduler/invocation path and its logs; the repository does not define a monitoring console or a safe production inspection command. To retry terminal failures, an authorized operator must deliberately call the endpoint with `retryFailed=1` and the secret. Do not put secret values in this document, command history shared with others, or logs. Secret rotation process and ownership remain unresolved; see [open decisions](../decisions/open-items.md).

Useful code references: `src/app/api/answers/batch/route.ts`, `src/app/api/internal/jev/retry/route.ts`, `src/lib/db/repository/answer-repository.ts`, and `src/lib/jev/adapter.ts`. See the [product contract](../../openspec/specs/stcirt/spec.md) and [data lifecycle guide](../data-governance.md).
