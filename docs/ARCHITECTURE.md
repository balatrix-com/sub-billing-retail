# Architecture

## HTTP Layer
- `src/server.js`
  - Registers payment webhook raw-body route before JSON parser
  - Registers JSON middleware and route groups
  - Initializes Asset and Billing services

## Routes
- `src/routes/index.js`
  - `/api/customers`
  - `/api/plans`
  - `/api/subscriptions/*`
  - `/api/subscriptions/:id/renew` (Manual Renewal)
- `src/routes/paymentRoutes.js`
  - `/api/payments/*`

## Controllers
- `src/controllers/CustomerController.js`
  - create/get/update customer handlers
- `src/controllers/PaymentController.js`
  - initiate, status, success/cancel redirect, webhook, history, cancel

## Services
- `src/services/PaymentService.js`
  - Creates payment records
  - Processes webhook completion
  - Credits wallet in transaction
  - Writes payment/webhook audit rows
- `src/services/StripeService.js`
  - Stripe Checkout session creation
  - Session retrieval
  - Webhook signature verification
- `src/services/BillingService.js`
  - Renewal scheduler and billing cycle logic
- `src/services/AssetService.js`, `EventService.js`
  - provisioning/event workflows
  - Asset state management (Active/Inactive status transitions)

## Data Access
- `src/config/database.js`: pg pool
- models + direct SQL queries in services

## Payment Event Path
1. `POST /api/payments/initiate`
2. Create Stripe session + insert pending payment
3. Stripe redirects customer
4. Stripe sends webhook to `/api/payments/webhook/stripe`
5. Signature verification
6. Mark payment completed + credit wallet
## Asset Lifecycle & State Management
- **Active**: Assets are provisioned and usable.
- **Inactive**: Assets are suspended due to subscription renewal failure (insufficient balance).
- **Released/Cancelled**: Assets are permanently torn down after official subscription cancellation.

### State Transitions:
1. `active` -> `suspended` (Subscription) => Assets -> `inactive`
2. `suspended` -> `active` (Manual Renewal) => Assets -> `active`
3. `active/suspended` -> `cancelled` (Cancellation) => Assets -> `teardown` (released/cancelled)
