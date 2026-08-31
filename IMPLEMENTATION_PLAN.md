# IMPLEMENTATION_PLAN.md

## 1. Purpose

This document defines the implementation sequence for the
Razorpay B2B Agentic Quote-to-Pay project.

Implementation must proceed incrementally.

Do not attempt to build the entire application in one step.

Each phase must produce a working, testable result before the
next dependent phase begins.

Reference documents:

- AGENTS.md
- DATABASE.md
- ARCHITECTURE.md

These documents together form the current project specification.

---

# 2. Development Strategy

Development follows:

PLAN
→ IMPLEMENT
→ TEST
→ VERIFY
→ DOCUMENT
→ NEXT FEATURE

Rules:

- Implement one logical feature at a time.
- Do not silently change architecture.
- Do not invent unsupported Razorpay API behavior.
- Validate external API assumptions against official documentation.
- Prefer deterministic code for business rules.
- Keep AI responsibilities narrow and explicit.
- Keep financial operations server-side.
- Write tests alongside important functionality.
- Do not build future features before the MVP works.

---

# 3. Phase 0 — Project Initialization

Goal:

Create the basic development environment.

Tasks:

1. Initialize Next.js application.
2. Configure TypeScript.
3. Configure Tailwind CSS.
4. Configure shadcn/ui.
5. Initialize Git.
6. Create GitHub repository.
7. Configure environment variable structure.
8. Create .env.example.
9. Create basic project documentation.
10. Verify local application starts successfully.

Expected result:

A clean Next.js application runs locally.

Validation:

- npm/package manager commands work.
- Development server starts.
- TypeScript compiles.
- No secrets are committed.

---

# 4. Phase 1 — Database Foundation

Goal:

Implement the core PostgreSQL schema.

Tasks:

1. Configure Supabase.
2. Create database migration structure.
3. Create Merchant table.
4. Create Buyer table.
5. Create Product table.
6. Create Inventory table.
7. Create Merchant Policy table.
8. Create RFQ table.
9. Create Quote table.
10. Create Negotiation Message table.
11. Create Approval table.
12. Create Payment table.
13. Create Order table.
14. Create Agent Session table.
15. Create Audit Event table.
16. Add required indexes.
17. Add foreign-key relationships.
18. Add constraints required for data integrity.

Validation:

- Migrations execute successfully.
- Foreign keys work.
- Required fields are enforced.
- Inventory cannot become invalid.
- Records can be created and retrieved correctly.

---

# 5. Phase 2 — Database State Machine

Goal:

Implement server-controlled lifecycle transitions.

RFQ:

CREATED
→ PROCESSING
→ QUOTED
→ NEGOTIATING
→ ACCEPTED

ACCEPTED is terminal for the RFQ. See DATABASE.md section 9 for
the complete state list and rules.

Failure states:

PROCESSING
→ FAILED

QUOTED
→ EXPIRED

NEGOTIATING
→ REJECTED

Cancellation where applicable (before acceptance only):

CREATED / PROCESSING / QUOTED / NEGOTIATING
→ CANCELLED

RFQ state is independent from Order/Payment state. Order and
Payment each have their own state machines, defined in
DATABASE.md sections 13-14; this phase and its validation apply
equally to whichever of these state machines a given task is
implementing.

Tasks:

1. Create state constants/types.
2. Create state transition validation.
3. Reject invalid transitions.
4. Create centralized state transition functions.
5. Generate audit events for important transitions.

Validation:

- Valid transitions succeed.
- Invalid transitions fail.
- State cannot be changed directly through uncontrolled input.

---

# 6. Phase 3 — Seed Demo Data

Goal:

Create realistic synthetic data for the custom packaging demo.

Create:

- One merchant
- Multiple buyers
- 10–50 packaging products
- Synthetic inventory
- Pricing rules
- Delivery regions
- Merchant policies

Example product:

Name:
5-Ply Corrugated Box

Dimensions:
18 × 12 × 10

Base price:
₹24

MOQ:
1,000

Production capacity:
8,000

Supported region:
Chennai

Production time:
4 days

Validation:

- Products can be searched.
- Inventory can be queried.
- Policies can be retrieved.

---

# 7. Phase 4 — Catalog Service

Goal:

Provide deterministic product lookup.

Tools/functions:

- search_catalog
- get_product

Tasks:

1. Implement product search.
2. Support keyword-based search.
3. Support relevant structured filters.
4. Return validated product data.
5. Prevent nonexistent products from being returned as valid.

Validation:

- Existing products are found.
- Missing products return a controlled result.
- No fabricated products are returned.

---

# 8. Phase 5 — Inventory Service

Goal:

Provide deterministic inventory and production-capacity checks.

Tool:

check_inventory

Tasks:

1. Retrieve product availability.
2. Compare requested quantity with availability.
3. Return structured result.
4. Implement reservation capability.
5. Implement reservation expiry where required.
6. Prevent negative inventory.
7. Release expired/rejected reservations safely.

Validation:

Request:
5,000

Available:
8,000

Result:
AVAILABLE

Request:
12,000

Available:
8,000

Result:
INSUFFICIENT_INVENTORY

The AI must never directly modify inventory.

---

# 9. Phase 6 — Delivery Service

Goal:

Determine whether the merchant can fulfill delivery requirements.

Tool:

check_delivery

Inputs:

- Product
- Quantity
- Destination
- Deadline

Outputs:

- Supported / unsupported
- Estimated delivery time
- Reason

Validation:

If the requested destination or deadline cannot be supported,
the system must not generate an invalid quote.

---

# 10. Phase 7 — Quote Engine

Goal:

Calculate quotes using deterministic application logic.

Tool:

calculate_quote

Inputs:

- Product
- Quantity
- Customer information
- Pricing rules
- Delivery information

Outputs:

- Unit price
- Quantity
- Subtotal
- Discount
- Delivery cost if applicable
- Final amount
- Currency

Rules:

- Arithmetic must be performed by backend code.
- LLM-generated numbers must never be trusted without validation.
- Discounts must respect merchant policy.
- Quote values must be reproducible.

Validation:

Given identical inputs, quote calculation should produce the
same result.

---

# 11. Phase 8 — Policy Engine

Goal:

Enforce merchant authority boundaries.

Policies include:

- Maximum discount
- Minimum margin
- Maximum autonomous order value
- Minimum order quantity
- Allowed categories
- Allowed delivery regions
- Inventory restrictions
- Human approval threshold

Tool:

validate_policy

Tasks:

1. Create deterministic policy evaluator.
2. Validate quote.
3. Validate negotiation proposals.
4. Validate payment requests.
5. Return structured allow/block/approval-required decisions.

Example:

Discount requested:
15%

Maximum allowed:
5%

Result:

BLOCKED

Example:

Order:
₹114,000

Autonomous limit:
₹100,000

Result:

HUMAN_APPROVAL_REQUIRED

The policy engine has higher authority than the LLM.

---

# 12. Phase 9 — RFQ API

Goal:

Allow buyers to submit requests.

Endpoint:

POST /api/rfqs

Tasks:

1. Receive natural-language request.
2. Validate request.
3. Create RFQ.
4. Store raw request.
5. Assign initial state.
6. Create audit event.

Endpoint:

GET /api/rfqs/:id

Returns:

- RFQ
- Current state
- Structured requirements
- Related quote information
- Relevant audit information

---

# 13. Phase 10 — RFQ Parsing

Goal:

Convert natural-language B2B requests into structured requirements.

Example input:

"I need 5,000 5-ply boxes, 18x12x10, with a 2-color logo,
deliver to Chennai within 10 days, under ₹120,000."

Expected structure:

quantity:
5000

product:
corrugated box

dimensions:
18x12x10

material:
5-ply

printing:
2-color

destination:
Chennai

deadline:
10 days

budget:
120000

Tasks:

1. Connect Gemini API.
2. Create structured output schema.
3. Validate output using Zod.
4. Reject malformed output.
5. Request clarification when required fields are missing.
6. Store structured requirements.

The LLM may interpret the request.

The backend validates the resulting structure.

---

# 14. Phase 11 — Seller Agent

Goal:

Create the first functional AI agent.

Runtime model:

Gemini

The agent should:

1. Understand RFQ.
2. Decide which tool is needed.
3. Call catalog tools.
4. Check inventory.
5. Check delivery.
6. Calculate quote.
7. Validate policy.
8. Create quote.
9. Respond to buyer.

Initial tools:

- search_catalog
- get_product
- check_inventory
- check_delivery
- calculate_quote
- validate_policy
- create_quote

The agent must not directly access:

- Database credentials
- Razorpay credentials
- Arbitrary database writes
- Arbitrary financial operations

---

# 15. Phase 12 — Negotiation

Goal:

Allow controlled negotiation.

Endpoint:

POST /api/quotes/:id/negotiate

Workflow:

Buyer proposal
→ Seller Agent
→ Policy Engine
→ Allowed counteroffer
or
→ Rejection
or
→ Human approval

Example:

Initial:

₹120,000

Buyer:

"Can you do ₹110,000?"

Policy:

Maximum discount = 5%

Minimum allowed quote:

₹114,000

Agent:

"Best available price is ₹114,000."

Tasks:

1. Store negotiation messages.
2. Validate proposed values.
3. Calculate permitted counteroffer.
4. Prevent policy bypass.
5. Update quote.
6. Create audit events.

---

# 16. Phase 13 — Approval System

Goal:

Support human authorization for transactions outside
autonomous limits.

Endpoints:

POST /api/approvals

POST /api/approvals/:id/approve

POST /api/approvals/:id/reject

Workflow:

Quote
→ Policy Engine
→ Approval Required
→ Merchant Dashboard
→ Approve / Reject

Payment creation must remain blocked while required approval
is pending.

Validation:

- Approved transaction proceeds.
- Rejected transaction cannot proceed.
- Duplicate approval actions are safely rejected.

---

# 17. Phase 14 — Merchant Dashboard

Goal:

Provide the merchant with control and visibility.

Dashboard sections:

1. RFQs
2. Quotes
3. Pending Approvals
4. Payments
5. Orders
6. Policies
7. Audit Log

Merchant should be able to:

- View incoming RFQs
- View agent-generated quotes
- Configure policies
- Approve/reject transactions
- View transaction state
- Inspect agent decisions
- Inspect policy results
- Inspect audit trail

The UI should prioritize clarity over visual complexity.

---

# 18. Phase 15 — Razorpay Integration

Goal:

Connect approved transactions to Razorpay Test Mode.

Tasks:

1. Configure Razorpay test credentials.
2. Create secure backend Razorpay client.
3. Implement payment creation.
4. Store Razorpay identifiers.
5. Associate Razorpay transaction with:
   - RFQ
   - Quote
   - Order
   - Payment
6. Prevent client-side payment authority.
7. Handle Razorpay API errors safely.

Initial payment approach:

Use the Razorpay payment flow that is verified and supported
for the hackathon implementation, such as Payment Links or the
appropriate Order/payment integration.

Do not assume unsupported API behavior.

---

# 19. Phase 16 — Razorpay Webhooks

Goal:

Use server-side payment confirmation.

Endpoint:

POST /api/webhooks/razorpay

Tasks:

1. Receive webhook.
2. Verify webhook authenticity.
3. Extract event ID.
4. Check idempotency.
5. Identify internal payment/order.
6. Update payment state.
7. Update order state.
8. Create audit event.
9. Return successful acknowledgement.

Important:

The frontend must never be the source of truth for payment
success.

---

# 20. Phase 17 — Payment Failure Handling

Goal:

Handle failed payment safely.

Flow:

Payment created
→ Payment pending
→ Failure

The system must:

- Keep payment unpaid
- Keep order unconfirmed
- Record failure reason where appropriate
- Create audit event
- Allow safe retry where appropriate
- Prevent accidental duplicate transactions

Test at least:

1. Successful payment
2. Failed payment
3. Repeated payment attempt
4. Repeated webhook event

---

# 21. Phase 18 — Audit System

Goal:

Make the entire agentic transaction explainable.

Record:

- RFQ creation
- RFQ parsing
- Catalog search
- Inventory check
- Delivery check
- Quote calculation
- Policy evaluation
- Negotiation
- Approval
- Payment creation
- Payment success
- Payment failure
- Order confirmation

Each important event should include enough information to
understand what happened without exposing secrets.

Example:

Actor:
SELLER_AGENT

Action:
PROPOSE_DISCOUNT

Requested:
8%

Maximum:
5%

Policy result:
BLOCKED

Reason:
Requested discount exceeds merchant policy.

---

# 22. Phase 19 — Agent Session Tracking

Goal:

Track each AI workflow.

Tasks:

1. Create agent session.
2. Associate tool calls with session.
3. Associate session with RFQ.
4. Record start/end time.
5. Record success/failure.
6. Link important audit events.

This allows the system to explain:

"Which agent session handled this RFQ?"

---

# 23. Phase 20 — Idempotency and Reliability

Goal:

Make financial actions safe against retries.

Implement safeguards for:

- Payment creation
- Webhook processing
- Approval actions
- State transitions
- Inventory reservation

Examples:

If the same webhook arrives twice:

First:
Processed

Second:
Detected as duplicate

Result:

No duplicate order/payment.

---

# 24. Phase 21 — Testing

Testing must happen at multiple levels.

## Unit Tests

Test:

- Quote calculation
- Discount limits
- Margin limits
- Policy rules
- State transitions
- Inventory validation

## Integration Tests

Test:

- Database
- Agent tools
- Razorpay test APIs
- Webhooks
- Payment state updates

## End-to-End Tests

Test:

Buyer RFQ
→ Agent
→ Quote
→ Negotiation
→ Approval
→ Razorpay
→ Webhook
→ Confirmed Order

---

# 25. Phase 22 — Failure Scenarios

The final system must intentionally demonstrate failures.

Scenario 1:

Requested quantity exceeds inventory.

Expected:
Agent refuses to create invalid quote.

Scenario 2:

Requested discount exceeds merchant policy.

Expected:
Agent counteroffers or rejects.

Scenario 3:

Transaction exceeds autonomous authority.

Expected:
Human approval required.

Scenario 4:

Payment fails.

Expected:
Order remains unconfirmed.

Scenario 5:

Webhook is delivered twice.

Expected:
No duplicate financial action.

Scenario 6:

Buyer requests unsupported delivery.

Expected:
Agent explains limitation.

---

# 26. Phase 23 — Metrics

The system should measure real workflow performance.

Initial metrics:

- RFQs processed
- RFQ → quote time
- Quote acceptance rate
- Negotiation success rate
- Policy violation attempts
- Policy violation blocks
- Approval rate
- Payment completion rate
- Payment failure rate
- Successful order completion rate
- Average agent tool calls
- Agent failure rate

Hackathon demo metrics should use a controlled synthetic
dataset.

Do not fabricate production performance claims.

---

# 27. Phase 24 — Advanced Agent-to-Agent Mode

Only after the single-agent MVP works.

Add:

AI Buyer
    |
    v
Structured RFQ
    |
    v
Seller Agent
    |
    v
Quote / Negotiation
    |
    v
Approval
    |
    v
Razorpay

The AI Buyer is initially optional.

The seller agent remains the primary production-like component.

---

# 28. Phase 25 — MCP Integration

Optional advanced feature.

Expose selected seller capabilities through MCP.

Potential tools:

- search products
- check inventory
- request quote
- negotiate
- check quote
- check order
- initiate approved payment workflow

MCP must remain an interface layer.

Core backend business rules must continue working without MCP.

---

# 29. Phase 26 — Razorpay Route

Optional advanced feature.

Only implement after:

- Core payment flow works
- Test setup is confirmed
- Linked Account requirements are confirmed
- Transfer behavior is verified

Possible flow:

Buyer Payment
    |
    v
Razorpay
   / | \
  /  |  \
Seller Logistics Platform

Route must never be allowed to bypass the policy and approval
system.

---

# 30. Phase 27 — Production-Like Hardening

Before final submission:

- Remove debug code.
- Remove unused dependencies.
- Validate all environment variables.
- Verify no secret is committed.
- Verify webhook validation.
- Verify idempotency.
- Verify error handling.
- Verify all important actions are audited.
- Verify documentation matches implementation.
- Verify test suite passes.

---

# 31. Phase 28 — Deployment

Target:

Vercel

Deployment tasks:

1. Connect GitHub repository.
2. Configure environment variables.
3. Deploy application.
4. Configure database environment.
5. Configure Razorpay test credentials.
6. Configure webhook endpoint.
7. Test complete deployed flow.
8. Verify logs.
9. Verify failure scenarios.

---

# 32. Phase 29 — Final Demo Preparation

The demo should tell one clear story.

Example:

Buyer:

"I need 5,000 5-ply boxes, 18x12x10,
2-color printing, Chennai, within 10 days."

Agent:

1. Extracts requirements.
2. Finds matching product.
3. Checks inventory.
4. Checks delivery.
5. Generates quote.
6. Negotiates within policy.
7. Requests human approval if necessary.
8. Creates Razorpay payment.
9. Receives payment confirmation.
10. Confirms order.

Then intentionally demonstrate:

- Impossible inventory request
- Excessive discount
- High-value approval
- Payment failure

The purpose is to demonstrate intelligence,
control, financial safety and real transaction execution.

---

# 33. Implementation Priority

Priority levels:

P0 = Must work for MVP

P1 = Strong enhancement

P2 = Advanced / optional

P0:

- Project setup
- Database
- Catalog
- Inventory
- RFQ
- RFQ parsing
- Quote engine
- Policy engine
- Seller agent
- Negotiation
- Approval
- Razorpay payment
- Webhook
- Order state
- Audit log
- Failure handling
- Tests
- Deployment

P1:

- Inventory reservation
- Better merchant dashboard
- Customer pricing
- Agent session visualization
- Advanced analytics

P2:

- AI Buyer
- MCP
- Route
- Multi-merchant support
- Advanced agent-to-agent protocols

---

# 34. Definition of MVP Complete

The MVP is complete when this entire flow works:

Natural-language RFQ
→ Structured RFQ
→ Product search
→ Inventory validation
→ Delivery validation
→ Quote calculation
→ Policy validation
→ Negotiation
→ Approval when required
→ Razorpay Test Mode payment
→ Verified webhook
→ PAID
→ CONFIRMED order
→ Complete audit trail

And the system can demonstrate at least three controlled
failure cases without violating financial state.

---

# 35. Rule for Claude Code

Claude Code must not implement future phases prematurely.

When given a task:

1. Read AGENTS.md.
2. Read DATABASE.md.
3. Read ARCHITECTURE.md.
4. Read this implementation plan.
5. Identify the current phase.
6. Implement only the requested scope.
7. Run relevant tests.
8. Report changed files.
9. Report tests performed.
10. Report any assumptions or blockers.

If an implementation requires changing the architecture,
stop and request human review rather than silently changing
the specification.