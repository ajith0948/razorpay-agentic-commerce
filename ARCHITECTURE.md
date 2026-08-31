# ARCHITECTURE.md

## 1. Project Overview

Project:
Razorpay B2B Agentic Quote-to-Pay

Goal:

Build an AI-native B2B seller gateway that allows a buyer to
submit a natural-language procurement request, receive a
policy-controlled quote, negotiate within merchant-defined
limits, obtain approval when required, and complete payment
through Razorpay.

Demo vertical:

Custom packaging.

Example request:

"I need 5,000 5-ply boxes, 18x12x10 inches, with 2-color
printing, delivered to Chennai within 10 days, under ₹120,000."

The system converts this request into a structured RFQ,
evaluates it against merchant data and policies, negotiates
within predefined limits, and safely executes the approved
payment flow.

---

# 2. Core Architectural Principle

The system must separate:

LLM reasoning
from
deterministic business logic
from
financial execution.

Responsibilities:

LLM:
- Understand requests
- Decide which tool to use
- Generate explanations
- Propose quotes and negotiation actions

Application code:
- Validate inputs
- Enforce business rules
- Calculate prices
- Validate state transitions
- Control database writes
- Control payment operations

Policy Engine:
- Decides what the AI is allowed to do
- Enforces merchant limits
- Blocks unauthorized actions

Razorpay:
- Handles payment infrastructure

Webhook:
- Provides server-side payment confirmation

Database:
- Stores authoritative application state

Audit System:
- Records important agent, policy, payment and order events

The LLM is never the final authority for financial or security
decisions.

---

# 3. High-Level System

                    BUYER
                      |
                      | Natural-language request
                      v
              +----------------+
              |   Next.js App  |
              |   Chat / UI    |
              +-------+--------+
                      |
                      v
              +----------------+
              |   Backend API  |
              +-------+--------+
                      |
                      v
              +----------------+
              |  Seller Agent  |
              |    Gemini      |
              +-------+--------+
                      |
             Tool calls / actions
                      |
        +-------------+-------------+
        |             |             |
        v             v             v
    Catalog       Inventory      Policy
      Tools          Tools        Engine
        |             |             |
        +-------------+-------------+
                      |
                      v
                Quote Engine
                      |
                      v
                Negotiation
                      |
                      v
               Approval Engine
                      |
                      v
                 Razorpay
                      |
                      v
                  Payment
                      |
                      v
                 Webhook
                      |
                      v
              Backend Verification
                      |
                      v
                  Database
                      |
                      v
                Order State
                      |
                      v
                  Audit Log

---

# 4. Frontend

Technology:

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui

The frontend provides two primary interfaces:

## 4.1 Buyer Interface

The buyer can:

- Submit a natural-language RFQ
- View extracted requirements
- View quotes
- Negotiate
- Accept a quote
- View payment status
- View final order status

Example:

Buyer:

"I need 5,000 boxes under ₹120k."

The UI shows:

Extracted request:
- Quantity: 5,000
- Product: Corrugated box
- Material: 5-ply
- Budget: ₹120,000

The buyer can then continue the conversation.

---

## 4.2 Merchant Interface

The merchant can:

- View incoming RFQs
- View generated quotes
- Configure merchant policies
- Review approvals
- Approve/reject high-value transactions
- View payments
- View orders
- View audit history

The merchant dashboard should make agent actions visible.

The merchant should be able to understand:

- What the agent did
- Why it did it
- What policy was applied
- Whether human approval was required

---

# 5. Backend

Technology:

- Next.js server-side APIs
- TypeScript

The backend is the trusted application layer.

It is responsible for:

- Authentication/session handling
- Request validation
- Agent orchestration
- Tool execution
- Policy enforcement
- Quote calculations
- Inventory operations
- Approval workflows
- Razorpay integration
- Webhook processing
- Database access
- Audit logging

The frontend must never directly perform privileged operations.

MVP note: "Authentication/session handling" means a seeded demo
buyer selector/session — the buyer picks/is assigned one of the
synthetic seeded Buyer records (see DATABASE.md section 4). Real
authentication is not part of the MVP and is deferred to a
future phase (see AGENTS.md section 10, Out of Scope).

---

# 6. AI Seller Agent

The seller agent is the central reasoning component.

Runtime model:

Gemini API

The agent receives:

- Buyer request
- Current RFQ state
- Relevant merchant context
- Available tools
- Applicable policy information

The agent determines which action to perform.

Example:

Buyer:
"I need 5,000 boxes."

Agent:

1. Parse requirements
2. Search catalog
3. Check inventory
4. Check delivery availability
5. Calculate quote
6. Validate policy
7. Present quote

The agent must not directly access the database or Razorpay.

It must interact through controlled tools.

---

# 7. Agent Tool Layer

Tools are controlled backend functions exposed to the AI.

Initial tools:

- search_catalog
- get_product
- check_inventory
- check_delivery
- calculate_quote
- validate_policy
- create_quote
- negotiate_quote
- request_approval
- create_payment
- get_payment_status

get_customer_pricing is deferred to P1 (see IMPLEMENTATION_PLAN.md
section 33, Implementation Priority) and is not part of the MVP
tool set.

Every tool must:

- Validate input
- Use typed schemas
- Perform authorization checks
- Return structured output
- Handle errors safely
- Avoid exposing secrets

The AI chooses tools.

The backend executes them.

---

# 8. Tool Execution Flow

Example:

Buyer:

"I need 5,000 5-ply boxes."

The agent may execute:

search_catalog()
        |
        v
get_product()
        |
        v
check_inventory()
        |
        v
check_delivery()
        |
        v
calculate_quote()
        |
        v
validate_policy()
        |
        v
create_quote()

The agent may not skip required deterministic checks.

---

# 9. Policy Engine

The Policy Engine is deterministic.

It does not use an LLM to decide whether an action is legal
within merchant rules.

Example:

Merchant policy:

Maximum discount:
5%

Maximum autonomous order:
₹100,000

Minimum margin:
12%

Inventory reservation:
30 minutes

Allowed regions:
- Chennai
- Bangalore
- Hyderabad

Policy examples:

If requested discount > 5%:
    reject negotiation

If order value > ₹100,000:
    require human approval

If requested quantity > available inventory:
    reject or propose alternative

If delivery region is unsupported:
    reject or propose alternative

The LLM may propose an action.

The Policy Engine decides whether it is permitted.

---

# 10. Quote Engine

The Quote Engine is deterministic.

It calculates the financial values used by the application.

Inputs may include:

- Product
- Quantity
- Base price
- Customer pricing
- Quantity discount
- Merchant pricing rules
- Delivery cost
- Taxes when applicable

The quote engine must not rely on the LLM for arithmetic.

Example:

Base price:
₹24

Quantity:
5,000

Base total:
₹120,000

Maximum discount:
5%

Maximum allowed discount:
₹6,000

Minimum allowed quote:
₹114,000

The LLM may explain the quote, but the backend computes it.

---

# 11. Negotiation Engine

The negotiation system controls how much the seller agent
can negotiate.

Example:

Initial quote:
₹120,000

Buyer:
"Can you do ₹110,000?"

Policy:
Maximum discount = 5%

Lowest permitted quote:
₹114,000

Agent response:

"I can offer ₹114,000, which is the maximum discount allowed
under the merchant's pricing policy."

Negotiation must never allow the LLM to bypass the policy engine.

Each negotiation step is stored.

---

# 12. Approval Engine

Some actions require human approval.

Example:

Merchant policy:

Maximum autonomous transaction:
₹100,000

Quote:
₹114,000

Result:

APPROVAL REQUIRED

The approval engine creates an approval request.

Merchant sees:

Order:
5,000 boxes

Amount:
₹114,000

Reason:
Transaction exceeds autonomous approval limit.

Available actions:

APPROVE
REJECT

Payment creation must remain blocked until the required
approval is complete.

---

# 13. Razorpay Integration

Razorpay is the payment execution layer.

The backend communicates with Razorpay.

The AI must never receive Razorpay secret credentials.

Basic flow:

Agent
  |
  v
Backend
  |
  v
Policy validation
  |
  v
Razorpay API
  |
  v
Payment Order / Payment Link
  |
  v
Buyer Payment
  |
  v
Razorpay
  |
  v
Webhook
  |
  v
Backend
  |
  v
Database

The initial MVP should use Razorpay Test Mode.

No real money should be processed.

---

# 14. Payment Creation Flow

Payment creation must follow these steps:

1. Confirm quote exists.
2. Confirm quote is accepted.
3. Confirm required approval exists.
4. Confirm quote has not expired.
5. Confirm amount matches approved amount.
6. Confirm merchant policy allows the transaction.
7. Create Razorpay payment/order.
8. Store Razorpay identifiers.
9. Set internal payment status to PENDING.
10. Wait for verified Razorpay confirmation.

The backend must prevent multiple payment creations for the same
transaction unless the retry is explicitly safe.

---

# 15. Webhook Architecture

Razorpay webhook events are treated as external financial
events.

Flow:

Razorpay
   |
   | webhook
   v
/api/webhooks/razorpay
   |
   v
Verify webhook authenticity
   |
   v
Check event ID / idempotency
   |
   v
Map Razorpay event to internal payment
   |
   v
Update payment state
   |
   v
Update order state
   |
   v
Create audit event

The webhook handler must be idempotent.

Processing the same webhook multiple times must not create
multiple payments or multiple orders.

The frontend must never decide that a payment succeeded by
itself.

---

# 16. Payment State

Internal payment states:

CREATED
    |
    v
PENDING
   / \
  /   \
FAILED  PAID

Important rule:

PAID must only be reached after verified backend
confirmation.

---

# 17. Order State

Order lifecycle:

CREATED
    |
    v
PAYMENT_PENDING
   / \
  /   \
PAYMENT_FAILED
       |
       v
     PAID
       |
       v
   CONFIRMED

The database controls state.

The LLM cannot directly change order state.

Order state is independent from RFQ state. The RFQ reaches its
own terminal ACCEPTED state once a quote is accepted (see
DATABASE.md section 9); the Order/Payment lifecycle then manages
financial execution on its own.

---

# 18. Inventory Architecture

Inventory is server-controlled.

Agent requests:

check_inventory(product_id, quantity)

Backend returns:

- Requested quantity
- Available quantity
- Reservation status

The agent cannot directly change inventory.

Inventory operations are performed through deterministic
application functions.

Example:

Available:
8,000

Requested:
5,000

Result:

AVAILABLE

Requested:
12,000

Result:

INSUFFICIENT_INVENTORY

Possible response:

- Offer available quantity
- Offer delayed delivery
- Offer split shipment

---

# 19. Inventory Reservation

When required, the backend can reserve inventory for a quote.

Example:

Available:
8,000

Requested:
5,000

Reserved:
5,000

Remaining available:
3,000

Reservation expires after the configured period.

If the quote expires or is rejected:

Reserved quantity is released.

The AI cannot extend or remove reservations without passing
through backend rules.

---

# 20. Database Layer

Database:

Supabase PostgreSQL

The database stores:

- Merchants
- Buyers
- Products
- Inventory
- Policies
- RFQs
- Quotes
- Negotiations
- Approvals
- Payments
- Orders
- Agent Sessions
- Audit Events

The database is the authoritative source of application state.

See DATABASE.md for the detailed schema and lifecycle rules.

---

# 21. Audit Architecture

Every important action produces an audit event.

Example:

RFQ_CREATED
RFQ_PARSED
PRODUCT_SEARCHED
INVENTORY_CHECKED
QUOTE_CREATED
NEGOTIATION_STARTED
POLICY_CHECKED
POLICY_REJECTED
APPROVAL_REQUESTED
APPROVAL_GRANTED
PAYMENT_CREATED
PAYMENT_FAILED
PAYMENT_CONFIRMED
ORDER_CONFIRMED

Example audit record:

Actor:
SELLER_AGENT

Action:
PROPOSE_DISCOUNT

Requested:
8%

Policy:
Maximum 5%

Result:
REJECTED

Reason:
Discount exceeds merchant policy.

The audit trail must allow a merchant or judge to understand
the complete transaction lifecycle.

---

# 22. Security Boundaries

The following boundaries must be enforced:

## Browser → Backend

The browser can request operations.

The backend validates the request.

The browser cannot bypass backend authorization.

## Agent → Tools

The agent only has access to explicitly defined tools.

## Tools → Database

Tools access only the data required for their operation.

## Agent → Razorpay

The agent cannot directly access Razorpay credentials.

All Razorpay operations happen through the backend.

## Webhook → Database

Only verified webhook events can change payment state.

---

# 23. Secret Management

Secrets include:

- Gemini API key
- Razorpay API key
- Razorpay secret
- Database credentials
- Webhook secret

Secrets must:

- Exist only in environment variables / secret storage
- Never be committed to Git
- Never be returned to the client
- Never be inserted into LLM prompts
- Never be written to normal audit logs

Use:

.env.local

for local development.

Provide:

.env.example

with variable names only.

---

# 24. API Structure

Initial backend routes:

POST /api/rfqs
GET  /api/rfqs/:id

POST /api/quotes
GET  /api/quotes/:id

POST /api/quotes/:id/negotiate

POST /api/approvals
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject

POST /api/payments
GET  /api/payments/:id

POST /api/webhooks/razorpay

GET  /api/orders/:id

The exact route naming can be adjusted during implementation
while preserving the architecture and responsibilities.

---

# 25. AI Request Flow

Example complete request:

1. Buyer sends natural-language RFQ.
2. Backend creates RFQ record.
3. Seller Agent receives the request.
4. Agent extracts structured requirements.
5. Backend validates the structured RFQ.
6. Agent calls catalog tools.
7. Agent calls inventory tools.
8. Backend calculates quote.
9. Policy Engine validates quote.
10. Quote is stored.
11. Buyer negotiates.
12. Agent proposes allowed counteroffer.
13. Quote is updated.
14. Buyer accepts quote.
15. Approval Engine determines whether approval is required.
16. Human approves when necessary.
17. Backend creates Razorpay payment/order.
18. Buyer completes payment.
19. Razorpay sends webhook.
20. Backend verifies webhook.
21. Payment becomes PAID.
22. Order becomes CONFIRMED.
23. Audit events document the complete flow.

---

# 26. Error Handling

Every major layer must have explicit failure handling.

## RFQ Failure

Examples:

- Invalid request
- Missing quantity
- Missing product requirements

Response:

Ask the buyer for the missing information.

---

## Catalog Failure

If no matching product exists:

Do not invent a product.

Return:

"No matching product was found."

Offer alternatives when available.

---

## Inventory Failure

If insufficient inventory exists:

Do not create a quote pretending inventory exists.

Offer alternatives.

---

## Policy Failure

If the requested action violates policy:

Block the action.

Explain why.

Do not silently override the rule.

---

## Approval Failure

If approval is rejected:

Do not create payment.

Mark the request appropriately.

---

## Payment Failure

If Razorpay payment fails:

- Keep the order unpaid
- Record the failure
- Do not mark the order confirmed
- Allow a controlled retry where appropriate
- Do not create duplicate orders unnecessarily

---

## Webhook Failure

If webhook processing fails:

- Do not silently lose the event
- Record the error
- Support safe retry
- Maintain idempotency

---

# 27. AI Failure Protection

The system must assume the LLM can be wrong.

Examples:

LLM says:
"Inventory = 20,000"

Database says:
"Inventory = 8,000"

Result:

Database wins.

LLM says:
"Discount = 15%"

Policy says:
"Maximum = 5%"

Result:

Policy wins.

LLM says:
"Payment succeeded"

Razorpay webhook says:
"Payment failed"

Result:

Razorpay/backend state wins.

General rule:

LLM proposal
    ↓
Deterministic verification
    ↓
Allowed?
   / \
 NO   YES
 |      |
BLOCK  EXECUTE

---

# 28. Idempotency

Financial operations must be safe against retries.

Example:

create_payment()

If the request is accidentally sent twice:

First request:
Payment created

Second request:
System detects existing payment state

Result:

Do not create another payment unnecessarily.

The same principle applies to webhook events.

---

# 29. Observability

The application should expose enough information to debug the
system.

Track:

- Request ID
- RFQ ID
- Agent Session ID
- Quote ID
- Approval ID
- Razorpay Order ID
- Payment ID
- Webhook Event ID

Logs should help connect:

RFQ
→ Quote
→ Approval
→ Payment
→ Webhook
→ Order

Sensitive payment credentials and private secrets must not be
logged.

---

# 30. MVP Architecture

The initial MVP contains:

Frontend
    |
Backend
    |
Seller Agent
    |
Tools
    |
Policy Engine
    |
Quote Engine
    |
Supabase
    |
Razorpay
    |
Webhook
    |
Audit Log

MVP uses:

- One merchant
- Synthetic catalog
- Synthetic buyers
- Synthetic inventory
- One seller agent
- Razorpay Test Mode
- Payment Link or Order flow
- Manual approval for high-value orders

---

# 31. Future Architecture

After MVP works, possible additions include:

## AI Buyer

Buyer Agent
    |
Structured RFQ
    |
Seller Agent

This enables agent-to-agent commerce.

---

## MCP

Expose seller capabilities through MCP so external AI agents
can interact with the merchant using standardized tools.

Possible tools:

- search products
- check inventory
- request quote
- negotiate
- check order
- initiate payment

MCP is an extension layer and must not be required for the
core MVP.

---

## Razorpay Route

Possible future settlement flow:

Buyer payment
      |
      v
Razorpay
   /  |  \
  /   |   \
Seller Logistics Platform

This is optional and should only be implemented after the core
payment flow is stable and the required Razorpay account/setup
requirements are confirmed.

---

# 32. Development Order

Implementation must proceed incrementally.

Phase 1:
Project setup
- Next.js
- TypeScript
- Supabase
- GitHub

Phase 2:
Database
- migrations
- tables
- relationships
- state model

Phase 3:
Catalog
- products
- search
- inventory

Phase 4:
RFQ
- request creation
- structured requirements
- validation

Phase 5:
Quote
- quote calculation
- policy engine
- quote persistence

Phase 6:
Agent
- Gemini
- tools
- orchestration
- negotiation

Phase 7:
Approval
- merchant approval UI
- approval state

Phase 8:
Razorpay
- test credentials
- order/payment flow
- payment state

Phase 9:
Webhooks
- verification
- idempotency
- order confirmation

Phase 10:
Audit
- agent events
- policy events
- payment events

Phase 11:
Testing
- unit tests
- integration tests
- end-to-end tests
- failure scenarios

Phase 12:
Deployment
- Vercel
- production-like environment
- final demo

---

# 33. Non-Goals

Do NOT implement these in the MVP:

- General marketplace
- Real supplier onboarding
- Real KYC
- Real logistics integration
- Real-money transactions
- Unlimited autonomous payments
- Full ERP replacement
- Universal commerce protocol
- Production-scale multi-tenant infrastructure
- Complex multi-agent orchestration
- Route settlement unless required and verified

---

# 34. Final Architecture Principle

The system follows this responsibility model:

                AI
                 |
                 v
          "I propose this"
                 |
                 v
          Tool / Backend
                 |
                 v
        Deterministic checks
                 |
          +------+------+
          |             |
        BLOCK         ALLOW
          |             |
          |             v
          |         Razorpay
          |             |
          |          Webhook
          |             |
          +------> Database
                       |
                       v
                  Audit Log

The AI is intelligent.

The backend is trusted.

The policy engine is authoritative.

Razorpay is the payment authority.

The database is the application source of truth.

The webhook is the payment confirmation mechanism.

The audit log provides traceability.