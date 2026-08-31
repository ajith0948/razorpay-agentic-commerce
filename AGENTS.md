# AGENTS.md

## 1. Project

Name: Razorpay B2B Agentic Quote-to-Pay

Purpose:
Build an AI-native B2B seller gateway that allows an AI buyer
to submit a procurement request, receive a merchant-approved
quote, negotiate within merchant-defined limits, and complete
an approved transaction through Razorpay.

Demo vertical:
Custom packaging.

The architecture should remain generic enough to support
other B2B products later.

---

## 2. Core User Journey

The primary workflow is:

Buyer Request
→ Parse RFQ
→ Search Catalog
→ Check Inventory
→ Calculate Quote
→ Validate Merchant Policy
→ Negotiate
→ Approval Gate
→ Razorpay Payment
→ Razorpay Webhook
→ Confirm Order

Every financial action must be traceable.

---

## 3. Technology Stack

Frontend:
- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui

Backend:
- Next.js server-side APIs
- TypeScript

Database:
- PostgreSQL through Supabase

Runtime AI:
- Gemini API

Payment:
- Razorpay Test Mode

Development Agent:
- Claude Code

Validation:
- Zod

Testing:
- Playwright
- API/integration tests

Version Control:
- Git
- GitHub

Deployment:
- Vercel

---

## 4. AI Responsibilities

The AI agent may:

- Understand natural-language RFQs
- Extract structured requirements
- Search available products
- Check inventory/capacity
- Calculate or request a quote
- Compare available options
- Negotiate within predefined merchant limits
- Explain decisions
- Request human approval when required
- Initiate allowed payment workflows
- Respond to payment success/failure states

The AI must NOT:

- Invent inventory
- Invent prices
- Exceed discount limits
- Modify merchant policies
- Approve transactions above its authority
- Directly access payment secrets
- Directly modify protected database records
- Claim payment success without verified backend confirmation

---

## 5. Merchant Policy

Merchant policy is deterministic and has higher authority
than LLM output.

Example rules:

- Maximum autonomous order value
- Maximum discount
- Minimum margin
- Minimum order quantity
- Allowed delivery regions
- Allowed products/categories
- Inventory constraints
- Human approval thresholds

The LLM may propose an action.

The policy engine decides whether that action is allowed.

---

## 6. Financial Safety

The LLM must never directly control Razorpay credentials.

All payment operations must pass through backend-controlled
server-side functions.

The backend must validate:

- Amount
- Currency
- Order/quote relationship
- Merchant policy
- Authorization state

Payment success must be confirmed through verified Razorpay
server-side events/webhooks.

Client-side UI state must never be treated as the source of truth
for payment success.

---

## 7. Agent Tools

The agent should interact with the system through explicit tools.

Initial tools:

- search_catalog
- get_product
- check_inventory
- check_delivery
- calculate_quote
- get_customer_pricing
- validate_policy
- negotiate_quote
- request_approval
- create_payment
- get_payment_status

Tools must:
- Have clearly defined inputs/outputs
- Validate input
- Return structured data
- Fail safely
- Avoid exposing secrets

---

## 8. Audit Trail

Record important agent actions.

For each action store:

- Timestamp
- Agent/session ID
- User/merchant
- Action
- Tool used
- Input summary
- Output/result
- Policy decision
- Approval status
- Related quote/order/payment ID

Audit logs must be append-only from normal application flows.

---

## 9. Failure Handling

The system must explicitly handle:

- Product not found
- Insufficient inventory
- Delivery unavailable
- Quote expired
- Negotiation outside allowed limits
- Human approval required
- Payment failure
- Duplicate payment/event
- Razorpay API failure
- Webhook failure/retry

The agent must never silently continue after a financial failure.

---

## 10. Out of Scope

Do NOT build:

- A general-purpose marketplace
- Real merchant onboarding
- Real KYC infrastructure
- A replacement for SAP/ERP
- Real-world supplier logistics
- Real-money transactions
- Autonomous unrestricted spending
- Generic consumer shopping assistant
- Generic AI chatbot
- Full universal commerce protocol
- Production-scale multi-merchant settlement in MVP

---

## 11. Architecture Principles

Prefer:

- Deterministic business logic over LLM decisions
- Server-side validation
- Explicit tool boundaries
- Small modular services
- Strong typing
- Idempotent financial operations
- Event-driven payment confirmation
- Explainable agent decisions
- Human approval for high-risk actions

Avoid:

- Hardcoded secrets
- Client-side payment authority
- Giant monolithic prompts
- Hidden business rules inside prompts
- Unvalidated LLM JSON
- Infinite agent loops
- Unnecessary dependencies
- Overengineering before MVP functionality exists

---

## 12. Development Workflow

Before implementation:

1. Review this specification.
2. Create an implementation plan.
3. Identify affected components.
4. Identify tests.
5. Get human approval for architectural changes.

During implementation:

- Keep changes small.
- Run tests frequently.
- Do not silently change requirements.
- Update documentation when architecture changes.

---

## 13. Definition of Done

A feature is not complete until:

- It works in the intended flow.
- Inputs are validated.
- Failure cases are handled.
- Tests exist where appropriate.
- Financial actions are auditable.
- No secrets are exposed.
- The implementation follows this specification.