# OpenAI Executive Agent

LionOS now includes a controlled OpenAI executive-planning endpoint inside the existing executive orchestrator.

## Purpose

The agent converts an operator command into a structured execution plan that can be reviewed before LionOS creates issues, queues jobs, sends communications, publishes content, changes data, or performs financial actions.

This first release is intentionally **plan-only**. It does not directly execute external side effects.

## Required environment variables

```bash
OPENAI_API_KEY=<encrypted secret>
OPENAI_EXECUTIVE_MODEL=gpt-5.4
EXECUTIVE_API_TOKEN=<existing executive API bearer token>
```

Store secrets in the deployment provider and GitHub Actions secret store. Never commit them to the repository.

## Start locally

```bash
npm install
npm run executive
```

The executive service exposes:

```text
GET  /health
GET  /status
POST /ai/command
POST /run/:job
```

## Example request

```bash
curl -X POST http://localhost:10000/ai/command \
  -H "Authorization: Bearer $EXECUTIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "Create a launch plan for the new Lion Elite Beauty client progress portal",
    "brands": ["lion-elite-beauty"],
    "objective": "Produce the safest, highest-value implementation sequence",
    "constraints": ["Do not publish or contact clients without approval"],
    "approvalMode": "human-required",
    "requestedBy": "alexander"
  }'
```

## Response contract

The response contains:

- `model`
- `generatedAt`
- `approvalMode`
- `requestedBy`
- `plan.summary`
- `plan.priority`
- `plan.actions[]`
- `plan.risks[]`
- `plan.successMetrics[]`
- `plan.nextDecision`

Every action includes an owner, target system, action type, rationale, payload, and `requiresApproval` flag.

## Safety boundaries

The executive agent must not claim an action happened without tool evidence. Customer communications, financial actions, publishing, deployments, mutations, and medical or legal decisions default to human approval.

Lion Elite Wellness outputs remain research-education only. The agent must not provide dosing, treatment, diagnosis, or human-use instructions.

## Next implementation stage

After this endpoint is validated in production, connect approved plan actions to a narrow dispatcher:

1. `github-issue` actions create draft GitHub issues.
2. `queue-job` actions enter allowlisted BullMQ queues.
3. `draft` actions are stored for review.
4. `external-action` items remain blocked until a human explicitly authorizes them.

Each dispatch must create an immutable audit event and use an idempotency key.
