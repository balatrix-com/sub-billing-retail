# Project Overview

## Purpose
Subscription billing platform with:
- Customer management
- Plans/subscriptions
- Wallet crediting
- Stripe-based payments
- Webhook-driven payment completion

## Tech Stack
- Node.js + Express
- PostgreSQL
- Stripe API (Checkout Sessions + webhooks)

## Key Runtime Configuration
Expected environment variables (in `.env`):
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `PORT`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `BASE_URL`

## Core Business Concepts
- `customer_id`: internal customer reference (e.g., `U0002`)
- `payment_id`: human-friendly internal payment id (e.g., `PAY-2603-4821`)
- `stripe_session_id`: Stripe Checkout session id (e.g., `cs_test_...`)
- Wallet is credited only after webhook success processing

## Repository Structure (important paths)
- `src/server.js`: app entry point and middleware wiring
- `src/routes/*.js`: route definitions
- `src/controllers/*.js`: request handlers
- `src/services/*.js`: business logic + Stripe integration
- `src/models/*.js`: DB model helpers
- `migrations/*.sql`: schema definitions
- `sync.sh`: code sync + process restart on app server
