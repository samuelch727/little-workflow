# Task: Generate a fake customer-support ticket dataset

## Goal

Produce a realistic, varied dataset of fake customer-support tickets for a
fictional SaaS company called **CloudDesk** (a platform that helps small
businesses manage customer conversations, billing, and team workflows).
Customers reach support via email, chat, an in-app form, or phone.

Each ticket must carry triage labels so the dataset can later benchmark an AI
agent swarm on support-ticket triage (classify, prioritize, summarize, draft a
reply).

## Output

Two files:

1. `support_tickets_fake.json` — a JSON array of ticket objects.
2. `support_tickets_answer_key.csv` — columns:
   `ticket_id,category,urgency,sentiment,summary,recommended_action`

## Ticket schema

Each ticket object must use exactly these fields:

```json
{
  "ticket_id": "TICKET-0001",
  "customer_name": "Jordan Lee",
  "customer_company": "BrightPath Dental",
  "customer_plan": "Pro",
  "channel": "Email",
  "submitted_at": "2026-05-01T09:42:00Z",
  "ticket_subject": "Charged twice after upgrading plan",
  "ticket_body": "Hi, I upgraded our workspace yesterday and noticed two charges...",
  "category": "Billing",
  "urgency": "High",
  "sentiment": "Frustrated",
  "summary": "Customer reports duplicate charge after upgrading their plan.",
  "recommended_action": "Check payment history and refund the duplicate charge if confirmed.",
  "draft_reply": "Hi Jordan, thanks for reaching out. I'm sorry about the duplicate charge..."
}
```

### Field rules

- `ticket_id`: sequential, `TICKET-0001`, `TICKET-0002`, …
- `customer_name`, `customer_company`: realistic but fake; no real entities.
- `customer_plan`: one of `Free | Starter | Pro | Business | Enterprise`.
- `channel`: one of `Email | Chat | In-App Form | Phone Transcript`.
- `submitted_at`: ISO 8601 timestamp between `2026-04-01` and `2026-05-31`.
- `ticket_subject`: concise, like a real support subject line.
- `ticket_body`: a realistic message, 30–180 words, with enough detail to infer
  category, urgency, and sentiment.
- `category`: exactly one of
  `Billing | Account Access | Bug Report | Feature Request | Onboarding |
  Cancellation | Performance | Integration | Data & Privacy | General Question`.
- `urgency`: exactly one of `Low | Medium | High | Critical`.
- `sentiment`: exactly one of `Positive | Neutral | Frustrated | Angry | Confused`.
- `summary`: one sentence summarizing the issue.
- `recommended_action`: one sentence on what support should do next.
- `draft_reply`: a concise, professional reply that matches the customer's
  sentiment, acknowledges the issue, and offers a next step without overpromising.

## Category meanings

| Category | Description |
|---|---|
| Billing | Payments, invoices, refunds, duplicate/failed charges |
| Account Access | Login, password reset, locked accounts, MFA |
| Bug Report | Defects, broken features, unexpected errors |
| Feature Request | New features or product improvements |
| Onboarding | Setup, configuration, import help |
| Cancellation | Cancel, downgrade, or pause an account |
| Performance | Slow loading, outages, sync delays, latency |
| Integration | Third-party tools (Slack, Salesforce, Zapier, Google Workspace) |
| Data & Privacy | Export, deletion, GDPR/CCPA, security concerns |
| General Question | Basic usage, pricing, docs, non-urgent inquiries |

## Target distribution

The dataset should resemble a realistic support queue, not a balanced one.

- Category shares: Billing 15%, Account Access 12%, Bug Report 14%,
  Feature Request 10%, Onboarding 10%, Cancellation 8%, Performance 8%,
  Integration 10%, Data & Privacy 6%, General Question 7%.
- Urgency shares: Low 25%, Medium 45%, High 25%, Critical 5%.
- Sentiment shares: Positive 10%, Neutral 35%, Frustrated 30%, Angry 10%,
  Confused 15%.

## Quality

Vary wording and length. Avoid obvious, repetitive tickets. Include some tricky
cases: a polite customer with a high-urgency issue; an angry customer with a
trivial issue; a confused customer asking a billing question; a ticket that
mentions multiple issues but has one primary category; enterprise customers
skewing higher urgency; free-plan users skewing lower urgency unless there is a
security/data concern. Never use real names, companies, emails, phone numbers,
or payment data.
