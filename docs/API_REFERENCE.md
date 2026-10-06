# API Reference

## Health
```bash
curl http://10.10.0.8:5000/health
```

## Create Customer
```bash
curl -X POST http://10.10.0.8:5000/api/customers \
  -H "Content-Type: application/json" \
  -d '{
    "customer_type": "company",
    "fr_cusid": "ext-ref-001",
    "company_name": "Acme Corp",
    "company_tax_id": "12-3456789",
    "admin_email": "admin@acme.com",
    "phone": "+1-555-9876",
    "address_st": "456 Business Ave",
    "city": "San Francisco",
    "state": "CA",
    "country": "USA",
    "credit_limit": 0
  }'
```

## Initiate Payment
```bash
curl -X POST http://10.10.0.8:5000/api/payments/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "U0002",
    "amount": 500,
    "currency": "usd",
    "description": "Wallet top-up for U0002"
  }'
```

## Payment Status
```bash
curl http://10.10.0.8:5000/api/payments/PAY-2603-0001/status
```

## Manual Webhook Test (Signed)
Run this from app server (`10.10.0.8`) so secrets and networking are simple:

```bash
WHSEC='whsec_replace'
SESSION_ID='cs_test_replace'
PI_ID='pi_test_manual_001'

PAYLOAD='{"id":"evt_test_001","object":"event","type":"checkout.session.completed","data":{"object":{"id":"'"$SESSION_ID"'","payment_intent":"'"$PI_ID"'"}}}'
TS=$(date +%s)
SIG=$(printf "%s.%s" "$TS" "$PAYLOAD" | openssl dgst -sha256 -hmac "$WHSEC" | awk '{print $2}')
# API Reference

## Health
```bash
curl http://10.10.0.8:5000/health
```

## Create Customer
```bash
curl -X POST http://10.10.0.8:5000/api/customers \
  -H "Content-Type: application/json" \
  -d '{
    "customer_type": "company",
    "fr_cusid": "ext-ref-001",
    "company_name": "Acme Corp",
    "company_tax_id": "12-3456789",
    "admin_email": "admin@acme.com",
    "phone": "+1-555-9876",
    "address_st": "456 Business Ave",
    "city": "San Francisco",
    "state": "CA",
    "country": "USA",
    "credit_limit": 0
  }'
```

## Initiate Payment
```bash
curl -X POST http://10.10.0.8:5000/api/payments/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "U0002",
    "amount": 500,
    "currency": "usd",
    "description": "Wallet top-up for U0002"
  }'
```

## Payment Status
```bash
curl http://10.10.0.8:5000/api/payments/PAY-2603-0001/status
```

## Manual Webhook Test (Signed)
Run this from app server (`10.10.0.8`) so secrets and networking are simple:

```bash
WHSEC='whsec_replace'
SESSION_ID='cs_test_replace'
PI_ID='pi_test_manual_001'

PAYLOAD='{"id":"evt_test_001","object":"event","type":"checkout.session.completed","data":{"object":{"id":"'"$SESSION_ID"'","payment_intent":"'"$PI_ID"'"}}}'
TS=$(date +%s)
SIG=$(printf "%s.%s" "$TS" "$PAYLOAD" | openssl dgst -sha256 -hmac "$WHSEC" | awk '{print $2}')

curl -X POST http://10.10.0.8:5000/api/payments/webhook/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=$TS,v1=$SIG" \
  --data-raw "$PAYLOAD"
```
## Manual Subscription Renewal
```bash
curl -X POST http://10.10.0.8:5005/api/subscriptions/SUB-2601/renew
```
*Note: This command will charge the customer's wallet for the plan + recurring addons and reactivate all associated assets.*
