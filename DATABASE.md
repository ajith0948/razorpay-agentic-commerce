# DATABASE.md

## 1. Purpose

This document defines the data model and state transitions for
the Razorpay B2B Agentic Quote-to-Pay system.

The database must preserve:
- Buyer requirements
- Merchant products and inventory
- Merchant policies
- RFQs
- Quotes
- Negotiation history
- Approval decisions
- Payment state
- Final order state
- Agent activity and audit history

The database is the source of truth for application state.

The LLM is NOT the source of truth.

---

# 2. Main Entities

The initial system contains these entities:

1. Merchant
2. Buyer
3. Product
4. Inventory
5. Merchant Policy
6. RFQ
7. Quote
8. Negotiation Message
9. Approval
10. Payment
11. Order
12. Agent Session
13. Audit Event

---

# 3. Merchant

Represents the seller/business using our platform.

Example:

Merchant:
ACME Packaging

Fields:

- id
- business_name
- email
- phone
- currency
- created_at
- updated_at

A merchant owns:
- Products
- Inventory
- Policies
- RFQs
- Quotes
- Orders
- Audit events

---

# 4. Buyer

Represents the business/customer requesting a purchase.

Example:

Buyer:
ABC Textiles

Fields:

- id
- merchant_id
- business_name
- email
- phone
- created_at
- updated_at

A buyer may create multiple RFQs and orders.

---

# 5. Product

Represents something the merchant can sell.

For the initial demo, products are custom packaging products.

Example:

Product:
5-Ply Corrugated Box

Fields:

- id
- merchant_id
- name
- description
- category
- sku
- base_price
- currency
- minimum_quantity
- active
- created_at
- updated_at

Additional packaging attributes may include:

- length
- width
- height
- material
- ply
- printing_type

The schema should remain flexible enough to support other B2B
product categories later.

---

# 6. Inventory

Represents available stock or production capacity for a product.

Fields:

- id
- product_id
- available_quantity
- reserved_quantity
- unit
- updated_at

Available quantity must never become negative.

Reserved inventory is tracked separately from available inventory.

Available inventory calculation:

available = total available quantity - reserved quantity

Inventory changes must be deterministic and server-controlled.

The AI must never directly modify inventory values.

---

# 7. Merchant Policy

Defines what the seller's AI agent is allowed to do.

Fields:

- id
- merchant_id
- max_autonomous_order_value
- max_discount_percent
- minimum_margin_percent
- inventory_reservation_minutes
- approval_required_above_amount
- active
- created_at
- updated_at

Additional policy data may include:

- allowed_categories
- allowed_delivery_regions
- allowed_payment_methods
- allowed_customer_types

Policy enforcement must happen in deterministic application code.

The LLM may suggest an action.

The policy engine decides whether the action is permitted.

---

# 8. RFQ

RFQ = Request for Quote.

Represents the buyer's purchase request.

An RFQ begins as natural language and is converted into structured
requirements.

Example request:

"I need 5,000 5-ply boxes, 18x12x10, with a 2-color logo,
deliver to Chennai within 10 days, budget ₹120,000."

Structured data:

- quantity
- product requirements
- dimensions
- material
- printing
- delivery location
- delivery deadline
- budget

Fields:

- id
- merchant_id
- buyer_id
- raw_request
- structured_requirements
- status
- created_at
- updated_at
- expires_at

---

# 9. RFQ State Machine

An RFQ follows this lifecycle:

CREATED
→ PROCESSING
→ QUOTED
→ NEGOTIATING
→ ACCEPTED

ACCEPTED is a terminal state for the RFQ. Once a quote is
accepted, the RFQ's job is done; the Order/Payment lifecycle
(see sections 13-14) takes over financial execution
independently.

Possible failure/terminal states:

PROCESSING
→ FAILED

QUOTED
→ EXPIRED

NEGOTIATING
→ REJECTED

Possible cancellation (before acceptance only):

CREATED / PROCESSING / QUOTED / NEGOTIATING
→ CANCELLED

Full set of RFQ states:

- CREATED
- PROCESSING
- QUOTED
- NEGOTIATING
- ACCEPTED
- REJECTED
- EXPIRED
- CANCELLED
- FAILED

Rules:

- Only valid state transitions are allowed.
- State changes must happen through backend logic.
- The LLM cannot directly change RFQ state.
- Important state changes create audit events.
- RFQ state is independent from Order/Payment state. Once a
  quote is accepted, the RFQ becomes ACCEPTED and the
  Order/Payment lifecycle handles financial execution (see
  section 14).

---

# 10. Quote

Represents an offer made by the seller.

Fields:

- id
- rfq_id
- merchant_id
- buyer_id
- total_amount
- currency
- discount_percent
- delivery_days
- delivery_location
- valid_until
- status
- created_at
- updated_at

Quote status:

DRAFT
→ SENT
→ NEGOTIATING
→ ACCEPTED

Alternative terminal states:

SENT
→ EXPIRED

SENT
→ REJECTED

NEGOTIATING
→ ACCEPTED

NEGOTIATING
→ REJECTED

A quote must reference the RFQ that created it.

A quote must never exceed merchant policy limits.

---

# 11. Negotiation Message

Stores every important negotiation step.

Fields:

- id
- quote_id
- sender_type
- message
- proposed_amount
- proposed_discount_percent
- created_at

sender_type may be:

- BUYER
- SELLER_AGENT
- HUMAN_MERCHANT
- SYSTEM

Example:

BUYER:
"Can you do ₹112,000?"

SELLER_AGENT:
"Best permitted price is ₹114,000."

Each negotiation step should be preserved for auditability.

---

# 12. Approval

Represents human authorization for actions that exceed autonomous authority.

Fields:

- id
- merchant_id
- rfq_id
- quote_id
- requested_amount
- reason
- status
- approved_by
- approved_at
- created_at

Status:

PENDING
→ APPROVED

PENDING
→ REJECTED

Example:

Quote amount:
₹114,000

Autonomous limit:
₹100,000

Result:

HUMAN APPROVAL REQUIRED

The payment operation cannot proceed until the required approval
has been completed.

---

# 13. Payment

Represents the financial transaction associated with a quote/order.

Fields:

- id
- order_id
- quote_id
- razorpay_order_id
- razorpay_payment_link_id
- amount
- currency
- status
- created_at
- updated_at

Payment state:

CREATED
→ PENDING
→ PAID

Failure:

PENDING
→ FAILED

Payment state must be updated from verified Razorpay events.

Client-side success messages are not the source of truth.

---

# 14. Order

Represents the confirmed commercial transaction.

Fields:

- id
- merchant_id
- buyer_id
- rfq_id
- quote_id
- total_amount
- currency
- status
- created_at
- updated_at

An order does not store a payment_id. Payment.order_id is the
only link between the two records. This is intentional: it
avoids a circular foreign-key relationship and allows multiple
payment attempts against the same order (for example, a retry
after a failed payment). An order's authoritative payment is
its most recent Payment row with status PAID.

Order status:

CREATED
→ PAYMENT_PENDING
→ PAID
→ CONFIRMED

Possible failure:

PAYMENT_PENDING
→ PAYMENT_FAILED

Possible cancellation:

CREATED
→ CANCELLED

An order must reference the RFQ and accepted quote that produced it.

Order state is independent from RFQ state (see section 9). The
RFQ reaches its own terminal ACCEPTED state once a quote is
accepted; this Order/Payment lifecycle then manages financial
execution on its own.

---

# 15. Agent Session

Represents one continuous AI interaction.

Fields:

- id
- merchant_id
- buyer_id
- rfq_id
- session_type
- status
- started_at
- ended_at

session_type may include:

- SELLER_AGENT
- BUYER_AGENT

The MVP will primarily use:

SELLER_AGENT

The BUYER_AGENT can be added later.

---

# 16. Audit Event

Stores important system and agent actions.

Fields:

- id
- merchant_id
- buyer_id
- rfq_id
- quote_id
- order_id
- agent_session_id
- event_type
- actor_type
- action
- input_summary
- output_summary
- policy_result
- created_at

actor_type may include:

- BUYER
- SELLER_AGENT
- HUMAN_MERCHANT
- SYSTEM
- RAZORPAY

Examples:

- RFQ_CREATED
- RFQ_PARSED
- PRODUCT_SEARCHED
- INVENTORY_CHECKED
- QUOTE_CREATED
- NEGOTIATION_STARTED
- POLICY_CHECKED
- POLICY_REJECTED
- APPROVAL_REQUESTED
- APPROVAL_GRANTED
- PAYMENT_CREATED
- PAYMENT_FAILED
- PAYMENT_CONFIRMED
- ORDER_CONFIRMED

Audit events should be append-only during normal application operation.

---

# 17. Entity Relationships

Main relationships:

Merchant
  |
  ├── Products
  ├── Inventory
  ├── Policies
  ├── Buyers
  ├── RFQs
  ├── Quotes
  ├── Orders
  └── Audit Events

Buyer
  |
  └── RFQs
       |
       └── Quote
            |
            └── Order
                 |
                 └── Payment

RFQ
  |
  ├── Agent Session
  ├── Quote
  ├── Approval
  └── Audit Events

Quote
  |
  ├── Negotiation Messages
  ├── Approval
  ├── Payment
  └── Order

Order
  |
  └── Payment

---

# 18. Core Data Integrity Rules

1. Every RFQ belongs to one merchant and one buyer.

2. Every quote belongs to one RFQ.

3. An accepted quote can create only the appropriate payment/order
   flow.

4. Payment amount must match the approved transaction amount.

5. Payment success must be confirmed by the backend.

6. Inventory cannot become negative.

7. AI actions must pass through application-controlled tools.

8. Policy limits must be checked before financial actions.

9. High-value actions must require human approval when configured.

10. Important state changes must generate audit events.

11. Duplicate financial events must not create duplicate payments
    or orders.

12. Razorpay IDs must be stored so external financial events can be
    linked to internal records.

13. An order may have multiple payment attempts (for example, a
    retry after a failed payment). Payment.order_id is the only
    link between the two records; the order does not store a
    payment_id.

---

# 19. Financial State Source of Truth

The following hierarchy is used:

User interface
    ↓
Application state
    ↓
Verified backend state
    ↓
Razorpay event

The frontend must never independently declare a payment successful.

The backend verifies the Razorpay event and updates the internal
payment/order state.

---

# 20. Initial MVP Data Scope

The first version should contain:

- 1 merchant
- 10-50 products
- Synthetic inventory
- 5-20 buyers
- Merchant pricing policies
- RFQs
- Quotes
- Negotiations
- Approvals
- Razorpay test payments
- Webhook events
- Audit events

The architecture should support multiple merchants later, but
multi-tenant production infrastructure is not required for the MVP.

---

# 21. Future Extensions

Possible future entities:

- Supplier
- Customer Pricing Tier
- Delivery Rule
- Inventory Reservation
- Purchase Order
- Shipment
- Refund
- Route Transfer
- Agent Identity
- Permission
- Consent
- MCP Tool Registry

These are NOT required for the initial MVP.