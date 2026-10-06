# Operations Runbook

## Common Hosts
- App server: `10.10.0.8`
- DB server: `10.10.0.7`

## Start/Restart App
For stable background run:
```bash
cd /opt/sub
pkill -f nodemon
pkill -f "node src/server.js"
nohup npm start > /tmp/sub.log 2>&1 &
```

For interactive debugging:
```bash
cd /opt/sub
npm run dev
```

## Logs
```bash
tail -f /tmp/sub.log
```

## Known nodemon issue
Running `nohup npm run dev` can crash with `EBADF`. Use `npm start` for background mode.

## Sync from local workspace
Local `sync.sh` pushes files to app server and restarts process.

## DB Permissions (required for app user)
Run as DB superuser if permission errors appear:
```sql
GRANT USAGE ON SCHEMA public TO bill_eng1;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bill_eng1;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO bill_eng1;
```

## Schema patches often needed
If errors mention missing columns in `payments`, add as needed:
```sql
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
```

## Manual Service Restoration
If a customer is suspended due to non-payment:
1. Ensure the customer has topped up their wallet balance via the payment API.
2. Trigger the manual renewal API call:
   ```bash
   curl -X POST http://10.10.0.8:5005/api/subscriptions/SUB-2601/renew
   ```
3. Verify in logs (`pm2 logs sub-billing`) that assets were reactivated:
   `[AssetService] Reactivating assets for subscription: ...`

## Troubleshooting checklist
1. `/health` responds
2. Payment initiate returns pending with `stripe_session_id`
3. Webhook endpoint receives and verifies signature
4. `payments.status` transitions to `completed`
5. Wallet balance increases
6. Manual renewal reactivates `inactive` assets (status -> `active`)
