const { randomUUID, timingSafeEqual } = require('crypto');

const ASSETS = {
  did: { table: 'did_assets', value: 'did_number', resource: 'numbers' },
  tfn: { table: 'tfn_assets', value: 'tfn_number', resource: 'numbers' },
  extension: { table: 'extension_assets', value: 'extension_number', resource: 'extensions' },
  monitoring: { table: 'monitoring_assets', value: 'user_id', resource: 'monitoring_extensions' },
};
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function periodEnd(start, unit, count) {
  if (!['days', 'months'].includes(unit) || !Number.isInteger(count) || count < 1 || count > 3660) throw fail('Invalid subscription duration');
  const end = new Date(start);
  if (unit === 'days') end.setUTCDate(end.getUTCDate() + count);
  else {
    const day = end.getUTCDate();
    end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + count);
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, last));
  }
  return end;
}
function serviceAuth(req, res, next) {
  const expected = process.env.SUBSCRIPTION_SERVICE_TOKEN || '';
  const provided = String(req.headers['x-subscription-token'] || '');
  if (!expected || Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).json({ success: false, message: 'Subscription service authentication required' });
  }
  next();
}

function createSubscriptionLifecycle(pool) {
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async function subscription(c, identifier, lock = false) {
    const r = await c.query(`SELECT s.*,p.name AS plan_name,c.lifecycle_status AS customer_lifecycle_status FROM subscriptions s JOIN plans p ON p.plan_id=s.plan_id JOIN customers c ON c.customer_id=s.customer_id
      WHERE s.id::text=$1 OR s.subscription_id=$1 ${lock ? 'FOR UPDATE OF s' : ''}`, [identifier]);
    if (!r.rows[0]) throw fail('Subscription not found', 404);
    if (lock && r.rows[0].customer_lifecycle_status === 'ARCHIVED') throw fail('Archived customer cannot change subscriptions',409);
    return r.rows[0];
  }
  async function event(c, s, action, actor, metadata = {}) {
    await c.query('INSERT INTO subscription_history(subscription_id,event,actor_id,metadata) VALUES($1,$2,$3,$4)', [s.id, action, actor || 'worker', metadata]);
    await c.query('INSERT INTO subscription_outbox(subscription_id,action,payload) VALUES($1,$2,$3)', [s.id, action, { customer_id: s.customer_id, subscription_id: s.id, actor_id: actor || 'worker', ...metadata }]);
  }
  async function debit(c, s, amount, reference, override = false, invoiceId = null) {
    if (!Number.isFinite(amount) || amount < 0) throw fail('Invalid subscription price');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s.customer_id]);
    const r = await c.query('SELECT * FROM customer_wallets WHERE customer_id=$1 FOR UPDATE', [s.customer_id]);
    const w = r.rows[0]; if (!w) throw fail('Customer wallet not found', 404);
    if (String(w.currency).toLowerCase() !== String(s.currency_snapshot).toLowerCase()) throw fail('Plan and wallet currencies must match');
    const before = Number(w.fiat_balance), credit = Number(w.credit_used || 0);
    if (!override && before + Math.max(0, Number(w.credit_limit || 0) - credit) < amount) throw fail('Insufficient wallet balance and credit limit', 402);
    const fiat = Math.min(Math.max(0, before), amount), after = before - fiat, used = credit + amount - fiat;
    await c.query('UPDATE customer_wallets SET fiat_balance=$2,credit_used=$3,version=version+1,last_updated=now() WHERE customer_id=$1', [s.customer_id, after, used]);
    if (amount > 0) await c.query(`INSERT INTO wallet_transactions(id,customer_id,amount,currency,before_balance,after_balance,transaction_type,reference,metadata)
      VALUES($1,$2,$3,$4,$5,$6,'subscription',$7,$8)`, [randomUUID(), s.customer_id, -amount, String(s.currency_snapshot).toLowerCase(), before, after, reference, { subscription_id: s.id, credit_debit: amount - fiat, approved_override: override }]);
    if (invoiceId) await c.query("UPDATE invoices SET status='paid',updated_at=now(),metadata=metadata || $2::jsonb WHERE id=$1", [invoiceId, JSON.stringify({ payment_operation_key: reference })]);
    else await c.query(`INSERT INTO invoices(id,subscription_id,customer_id,amount,currency,status,metadata) VALUES($1,$2,$3,$4,$5,'paid',$6)`,
      [randomUUID(), s.id, s.customer_id, amount, String(s.currency_snapshot).toLowerCase(), { operation_key: reference }]);
  }
  async function assets(identifier, c = pool) {
    const s = await subscription(c, identifier);
    const result = [];
    for (const [type, a] of Object.entries(ASSETS)) {
      const r = await c.query(`SELECT id,${a.value} AS value,status,metadata,subscription_id FROM ${a.table} WHERE subscription_id=$1 AND ${a.value} IS NOT NULL ORDER BY assigned_date`, [s.id]);
      result.push(...r.rows.map(row => ({ ...row, type })));
    }
    return result;
  }
  async function list(customerId) {
    const r = await pool.query(`SELECT s.*,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.plan_id=s.plan_id
      WHERE s.customer_id=$1 ORDER BY s.subscription_type,s.created_at DESC`, [customerId]);
    for (const s of r.rows) {
      s.assets = await assets(s.id);
      s.usage = { numbers: 0, extensions: 0, monitoring_extensions: 0, frozen: 0 };
      for (const a of s.assets) {
        if (a.status === 'released') continue;
        s.usage[ASSETS[a.type].resource]++;
        if (a.status === 'frozen') s.usage.frozen++;
      }
    }
    return r.rows;
  }
  async function listAll() {
    const r = await pool.query(`SELECT s.*,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.plan_id=s.plan_id
      ORDER BY s.subscription_type,s.created_at DESC`);
    for (const s of r.rows) {
      s.assets = await assets(s.id);
      s.usage = { numbers: 0, extensions: 0, monitoring_extensions: 0, frozen: 0 };
      for (const a of s.assets) {
        if (a.status === 'released') continue;
        s.usage[ASSETS[a.type].resource]++;
        if (a.status === 'frozen') s.usage.frozen++;
      }
    }
    return r.rows;
  }
  async function quote(input) {
    const p=(await pool.query('SELECT * FROM plans WHERE plan_id=$1',[input.plan_id])).rows[0];
    if(!p)throw fail('Plan not found',404);
    const start=new Date(),unit=input.duration_unit || p.duration_unit || 'months',count=Number(input.duration_count || p.duration_count || p.validity_months || 1);
    const end=periodEnd(start,unit,count),catalogEnd=periodEnd(start,p.duration_unit || 'months',Number(p.duration_count || p.validity_months || 1));
    const price=Math.round(Number(p.amount)*(end-start)/(catalogEnd-start)*100)/100;
    return {renewal_price:price,setup_fee:Number(p.setup_fees || 0),initial_charge:price+Number(p.setup_fees || 0),currency:p.currency,start_date:start,end_date:end};
  }
  async function activate(input, actor) {
    return transaction(async c => {
      const key = input.operation_key;
      if (typeof key!=='string' || !key || key.length > 200) throw fail('A request operation key is required');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`activation:${key}`]);
      const previous = await c.query('SELECT result FROM subscription_operations WHERE operation_key=$1', [key]);
      if (previous.rows[0]) {
        if (previous.rows[0].result.customer_id !== input.customer_id || previous.rows[0].result.plan_id !== input.plan_id) throw fail('Operation key belongs to a different activation',409);
        return previous.rows[0].result;
      }
      const pr = await c.query('SELECT * FROM plans WHERE plan_id=$1', [input.plan_id]);
      const p = pr.rows[0]; if (!p) throw fail('Plan not found', 404);
      const customer = (await c.query('SELECT lifecycle_status FROM customers WHERE customer_id=$1', [input.customer_id])).rows[0];
      if (!customer || customer.lifecycle_status === 'ARCHIVED') throw fail('Customer is missing or archived',409);
      const type = p.plan_category || 'base';
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscriptions:${input.customer_id}`]);
      const base = await c.query("SELECT * FROM subscriptions WHERE customer_id=$1 AND subscription_type='base' AND status IN ('active','grace') ORDER BY created_at DESC LIMIT 1", [input.customer_id]);
      if (type === 'base' && base.rows[0]) throw fail('Customer already has an active base subscription', 409);
      if (type === 'capacity' && !base.rows[0]) throw fail('An active base subscription is required for capacity plans');
      const unit = input.duration_unit || p.duration_unit || 'months';
      const count = Number(input.duration_count || p.duration_count || p.validity_months || 1);
      const start = new Date(); const end = periodEnd(start, unit, count);
      // Custom durations are priced in proportion to the catalog duration.
      const catalogEnd = periodEnd(start, p.duration_unit || 'months', Number(p.duration_count || p.validity_months || 1));
      const price = Math.round(Number(p.amount) * (end - start) / (catalogEnd - start) * 100) / 100;
      const mode = input.payment_mode || 'wallet';
      if (!['wallet', 'pending', 'credit_override'].includes(mode)) throw fail('Invalid activation payment mode');
      const id = randomUUID();
      const r = await c.query(`INSERT INTO subscriptions(id,subscription_id,customer_id,plan_id,status,start_date,next_billing,end_date,
        subscription_type,parent_subscription_id,duration_unit,duration_count,auto_renew,renewal_price,currency_snapshot,entitlement_snapshot,base_plan_price,total_recurring_price,rate_card_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$13,$13,$16) RETURNING *`,
      [id, `SUB-${Date.now()}-${id.slice(0, 6)}`, input.customer_id, p.plan_id, mode === 'pending' ? 'pending_activation' : 'active', start, end,
        type, type === 'capacity' ? base.rows[0].id : null, unit, count, input.auto_renew === true, price, String(p.currency).toLowerCase(),
        { numbers: Number(p.numbers || 0), extensions: Number(p.extensions || 0), monitoring_extensions: Number(p.monitoring_extensions || 0), storage_gb: Number(p.metadata?.storage_gb || 0) }, null]);
      const s = r.rows[0];
      if (mode !== 'pending') {
        await debit(c, s, price + Number(p.setup_fees || 0), key, mode === 'credit_override');
        await provisionExtensions(c, s);
      } else {
        await c.query(`INSERT INTO invoices(id,subscription_id,customer_id,amount,currency,status,metadata) VALUES($1,$2,$3,$4,$5,'pending',$6)`,
          [randomUUID(), id, s.customer_id, price + Number(p.setup_fees || 0), s.currency_snapshot, { operation_key: key }]);
      }
      await event(c, s, mode === 'pending' ? 'pending_activation' : 'reactivate', actor, { reason: 'activation' });
      await c.query('INSERT INTO subscription_operations(operation_key,subscription_id,result) VALUES($1,$2,$3)', [key, id, s]);
      return s;
    });
  }
  async function provisionExtensions(c, s) {
    const count = Number(s.entitlement_snapshot.extensions || 0);
    const used = await c.query('SELECT COUNT(*)::int AS count FROM extension_assets WHERE subscription_id=$1', [s.id]);
    if (used.rows[0].count > 0 || count === 0) return;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`extension-numbers:${s.customer_id}`]);
    const r = await c.query("SELECT extension_number FROM extension_assets WHERE customer_id=$1 AND status NOT IN ('released','unassigned')", [s.customer_id]);
    const taken = new Set(r.rows.map(a => a.extension_number));
    const m = await c.query("SELECT metadata FROM monitoring_assets WHERE customer_id=$1 AND status NOT IN ('released','unassigned')", [s.customer_id]);
    for (const a of m.rows) if (a.metadata?.extension) taken.add(a.metadata.extension);
    let index = 1;
    for (let i = 0; i < count; i++) {
      while (taken.has(`${s.customer_id}${String(index).padStart(2, '0')}`)) index++;
      if(index>99)throw fail('Customer SIP suffix range 01–99 is full; reduce extension quantity or release unused assets',409);
      const number = `${s.customer_id}${String(index++).padStart(2, '0')}`; taken.add(number);
      await c.query(`INSERT INTO extension_assets(customer_id,subscription_id,source_type,source_id,extension_number,extension_name,status)
        VALUES($1,$2,'plan',$3,$4,$5,'active')`, [s.customer_id, s.id, s.plan_id, number, `Extension ${number}`]);
    }
  }
  async function renew(identifier, key, actor, automatic = false) {
    if(typeof key!=='string' || !key || key.length>200)throw fail('Renewal operation key is required');
    return transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`renewal:${key}`]);
      const s = await subscription(c, identifier, true);
      if (!key) throw fail('Renewal operation key is required');
      const previous = await c.query('SELECT result FROM subscription_operations WHERE operation_key=$1', [key]);
      if (previous.rows[0]) {
        if (previous.rows[0].result.id !== s.id) throw fail('Operation key belongs to a different subscription',409);
        return previous.rows[0].result;
      }
      if (['expired', 'cancelled'].includes(s.status)) throw fail('Released or cancelled subscriptions cannot be renewed');
      if (automatic && (!s.auto_renew || !['active', 'grace'].includes(s.status) || new Date(s.end_date) > new Date())) return s;
      if(automatic && s.status==='grace' && s.last_renewal_attempt_at && Date.now()-new Date(s.last_renewal_attempt_at).getTime()<3600000)return s;
      const pending = s.status === 'pending_activation'
        ? await c.query("SELECT id,amount FROM invoices WHERE subscription_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [s.id]) : { rows: [] };
      const charge = pending.rows[0] ? Number(pending.rows[0].amount) : Number(s.renewal_price);
      try {
        if (s.subscription_type === 'capacity') {
          const b = await c.query("SELECT id FROM subscriptions WHERE customer_id=$1 AND subscription_type='base' AND status IN ('active','grace')", [s.customer_id]);
          if (!b.rows.length) throw fail('Renew the base subscription first',automatic ? 402 : 400);
        }
        await debit(c, s, charge, key, false, pending.rows[0]?.id);
      }
      catch (e) {
        if (!automatic || e.statusCode !== 402) throw e;
        const grace = s.grace_ends_at || new Date(new Date(s.end_date).getTime() + Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7) * 86400000);
        const r = await c.query(`UPDATE subscriptions SET status='grace',grace_ends_at=$2,renewal_attempts=renewal_attempts+1,last_renewal_attempt_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [s.id, grace]);
        if (s.status !== 'grace') await event(c, s, 'grace', actor, { reason: e.message });
        return r.rows[0];
      }
      const start = s.status === 'pending_activation' ? new Date() : new Date(Math.max(Date.now(), new Date(s.end_date).getTime()));
      const end = periodEnd(start, s.duration_unit, Number(s.duration_count));
      const r = await c.query(`UPDATE subscriptions SET status='active',start_date=$2,end_date=$3,next_billing=$3,grace_ends_at=NULL,frozen_at=NULL,
        renewal_attempts=0,last_renewal_attempt_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [s.id, start, end]);
      for (const a of Object.values(ASSETS)) await c.query(`UPDATE ${a.table} SET status='active',updated_at=now() WHERE subscription_id=$1 AND status IN ('frozen','suspended')`, [s.id]);
      await provisionExtensions(c, r.rows[0]);
      await event(c, s, 'reactivate', actor, { reason: 'renewal', charged: charge, operation_key: key });
      await c.query('INSERT INTO subscription_operations(operation_key,subscription_id,result) VALUES($1,$2,$3)', [key, s.id, r.rows[0]]);
      return r.rows[0];
    });
  }
  async function transition(identifier, action, actor) {
    return transaction(async c => {
      const s = await subscription(c, identifier, true);
      if (!['freeze', 'cancel', 'release'].includes(action)) throw fail('Unsupported transition');
      if (action === 'release' && !['frozen', 'cancelled'].includes(s.status)) throw fail('Only frozen/cancelled subscriptions may release assets');
      const status = action === 'freeze' ? 'frozen' : action === 'cancel' ? 'cancelled' : 'expired';
      if (s.status === status) return s;
      if (['expired','cancelled'].includes(s.status) && action !== 'release') throw fail('This subscription is already closed');
      if(action==='freeze' && !['active','grace'].includes(s.status))throw fail('Only an active/grace subscription can be frozen');
      if (action === 'release' && new Date(s.frozen_at).getTime() + Number(process.env.SUBSCRIPTION_RETENTION_DAYS || 30) * 86400000 > Date.now()) throw fail('Asset retention period has not ended');
      await c.query(`UPDATE subscriptions SET status=$2,frozen_at=COALESCE(frozen_at,now()),auto_renew=false,updated_at=now() WHERE id=$1`, [s.id, status]);
      for (const a of Object.values(ASSETS)) await c.query(`UPDATE ${a.table} SET status=$2,updated_at=now() WHERE subscription_id=$1 AND status NOT IN ('released','unassigned')`, [s.id, action === 'release' ? 'released' : 'frozen']);
      await event(c, s, action === 'cancel' ? 'freeze' : action, actor);
      return { ...s, status };
    });
  }
  async function autoRenew(identifier, enabled, actor) {
    if (typeof enabled !== 'boolean') throw fail('auto_renew must be a boolean');
    return transaction(async c => {
      const s = await subscription(c, identifier, true);
      if (!['active', 'grace', 'frozen'].includes(s.status)) throw fail('Subscription is not renewable');
      await c.query('UPDATE subscriptions SET auto_renew=$2,updated_at=now() WHERE id=$1', [s.id, enabled]);
      await c.query('INSERT INTO subscription_history(subscription_id,event,actor_id,metadata) VALUES($1,$2,$3,$4)', [s.id, 'auto_renew_changed', actor, { enabled }]);
      return { ...s, auto_renew: enabled };
    });
  }
  async function assignMonitoring(input, actor) {
    return transaction(async c => {
      const s = await subscription(c, input.subscription_id, true);
      if (!['active', 'grace'].includes(s.status)) throw fail('Subscription is not active');
      const old = await c.query('SELECT * FROM monitoring_assets WHERE user_id=$1 FOR UPDATE', [input.user_id]);
      if (old.rows[0] && old.rows[0].customer_id !== s.customer_id) throw fail('User belongs to another customer', 403);
      const used = await c.query("SELECT COUNT(*)::int AS used FROM monitoring_assets WHERE subscription_id=$1 AND status IN ('active','frozen') AND user_id<>$2", [s.id, input.user_id]);
      if (used.rows[0].used >= Number(s.entitlement_snapshot.monitoring_extensions || 0)) throw fail('Subscription monitoring capacity is full', 409);
      await c.query(`INSERT INTO monitoring_assets(customer_id,subscription_id,source_type,source_id,user_id,user_name,user_email,metadata,status)
        VALUES($1,$2,'plan',$3,$4,$5,$6,$7,'active') ON CONFLICT(user_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,
        metadata=EXCLUDED.metadata,status='active',updated_at=now()`,
      [s.customer_id, s.id, s.plan_id, input.user_id, input.name || input.user_id, input.email || '', { extension: input.extension }]);
      await event(c, s, 'reconcile', actor);
      return { success: true };
    });
  }
  async function unassignMonitoring(userId, customerId) {
    await pool.query("UPDATE monitoring_assets SET status='released',updated_at=now() WHERE user_id=$1 AND customer_id=$2", [userId, customerId]);
  }
  async function transferMonitoring(input, actor) {
    return transaction(async c => {
      const s = await subscription(c, input.subscription_id, true);
      if (!['active','grace'].includes(s.status)) throw fail('Subscription is not active');
      const old = await c.query("SELECT * FROM monitoring_assets WHERE subscription_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",[s.id,input.from_user_id]);
      if (!old.rows.length) throw fail('Source monitoring seat not found',404);
      await c.query("UPDATE monitoring_assets SET status='released',updated_at=now() WHERE user_id=$1 AND customer_id=$2 AND status='released'",[input.to_user_id,s.customer_id]);
      const dest = await c.query('SELECT * FROM monitoring_assets WHERE user_id=$1 FOR UPDATE',[input.to_user_id]);
      if (dest.rows[0] && (dest.rows[0].status !== 'released' || dest.rows[0].customer_id !== s.customer_id)) throw fail('Destination already owns a monitoring seat');
      // Retain the source history row; create/reactivate the destination row in the same locked transaction.
      await c.query("UPDATE monitoring_assets SET status='released',metadata=metadata || $2::jsonb,updated_at=now() WHERE id=$1",[old.rows[0].id,JSON.stringify({transferred_to:input.to_user_id})]);
      await c.query(`INSERT INTO monitoring_assets(customer_id,subscription_id,source_type,source_id,user_id,user_name,user_email,metadata,status)
        VALUES($1,$2,'plan',$3,$4,$5,$6,$7,'active') ON CONFLICT(user_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,metadata=EXCLUDED.metadata,status='active',updated_at=now()`,
        [s.customer_id,s.id,s.plan_id,input.to_user_id,input.name || input.to_user_id,input.email || '',{extension:input.extension}]);
      await event(c,s,'reconcile',actor,{from_user_id:input.from_user_id,to_user_id:input.to_user_id});
      return {success:true};
    });
  }
  async function move(input, actor) {
    // Assets are always assigned under a subscription lock; regular extensions follow the same rule.
    const a = ASSETS[input.type]; if (!a) throw fail('Invalid asset type');
    return transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`asset-move:${input.asset_id}`]);
      const r = await c.query(`SELECT * FROM ${a.table} WHERE id=$1`, [input.asset_id]);
      const asset = r.rows[0]; if (!asset) throw fail('Asset not found', 404);
      const ids = [asset.subscription_id, input.target_subscription_id].sort();
      for (const id of ids) await subscription(c, id, true);
      const locked = await c.query(`SELECT * FROM ${a.table} WHERE id=$1 FOR UPDATE`,[input.asset_id]);
      if (locked.rows[0].subscription_id !== asset.subscription_id) throw fail('Asset owner changed; refresh and retry',409);
      const target = await subscription(c, input.target_subscription_id);
      if (target.customer_id !== asset.customer_id) throw fail('Cannot transfer assets between customers', 403);
      if (!['active', 'grace'].includes(target.status)) throw fail('Destination subscription is not active');
      if (!['active','frozen','suspended'].includes(asset.status)) throw fail('Released assets cannot be moved');
      const rows = await assets(target.id, c);
      const used = rows.filter(x => ASSETS[x.type].resource === a.resource && x.status !== 'released' && x.id !== asset.id).length;
      if (used >= Number(target.entitlement_snapshot[a.resource] || 0)) throw fail('Destination subscription has no remaining capacity', 409);
      await c.query(`UPDATE ${a.table} SET subscription_id=$2,status='active',updated_at=now() WHERE id=$1`, [asset.id, target.id]);
      await event(c, target, 'reconcile', actor, { asset_id: asset.id, asset_type: input.type, previous_subscription_id: asset.subscription_id });
      await event(c, await subscription(c, asset.subscription_id), 'reconcile', actor);
      return { success: true };
    });
  }
  async function dispatch() {
    if (!process.env.SUBSCRIPTION_SERVICE_TOKEN) return;
    await transaction(async c => {
      const r = await c.query('SELECT * FROM subscription_outbox WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED');
      for (const e of r.rows) {
        try {
          const root = (process.env.PBX_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');
          const url = root.endsWith('/api') ? root : `${root}/api`;
          const endpoint = `${url}/internal/subscriptions/events`;
          const body = JSON.stringify({ ...e.payload, event_id: e.id, action: e.action, occurred_at: e.created_at });
          const { signedHeaders } = require('../middleware/serviceAuth');
          const response = await fetch(endpoint, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-subscription-token': process.env.SUBSCRIPTION_SERVICE_TOKEN,
              ...signedHeaders('POST', endpoint, body) },
            body, signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error(`PBX responded ${response.status}`);
          await c.query('UPDATE subscription_outbox SET delivered_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1', [e.id]);
        } catch (err) {
          await c.query('UPDATE subscription_outbox SET attempts=attempts+1,last_error=$2 WHERE id=$1', [e.id, err.message]);
          break; // Preserve customer event order across retries.
        }
      }
    });
  }
  async function tick(dryRun = false) {
    const r = await pool.query(`SELECT s.* FROM subscriptions s JOIN customers c ON c.customer_id=s.customer_id WHERE c.lifecycle_status='ACTIVE' AND (
      (s.status IN ('active','grace') AND s.end_date<=now()) OR
      (s.status IN ('frozen','cancelled') AND s.frozen_at IS NOT NULL)) ORDER BY s.subscription_type,s.end_date`);
    const result = { processed: 0, failed: 0, results: [], failures: [] };
    for (const s of r.rows) {
      if (dryRun) { result.results.push({ id: s.id, status: s.status, auto_renew: s.auto_renew }); continue; }
      try {
        if (['frozen','cancelled'].includes(s.status)) {
          const days = Math.ceil((new Date(s.frozen_at).getTime() + Number(process.env.SUBSCRIPTION_RETENTION_DAYS || 30)*86400000 - Date.now())/86400000);
          for (const reminder of [14,7,1]) if (days <= reminder && days > 0) await transaction(async c => {
            await subscription(c,s.id,true);
            const sent = await c.query('SELECT 1 FROM subscription_history WHERE subscription_id=$1 AND event=$2 AND created_at>=$3',[s.id,`retention_reminder_${reminder}`,s.frozen_at]);
            if (!sent.rows.length) await event(c,s,`retention_reminder_${reminder}`,'worker',{days_remaining:days,automatic_release:process.env.SUBSCRIPTION_AUTO_RELEASE==='true'});
          });
          if (days <= 0 && process.env.SUBSCRIPTION_AUTO_RELEASE === 'true') await transition(s.id, 'release', 'worker');
        }
        else if (s.status === 'grace' && new Date(s.grace_ends_at) <= new Date()) await transition(s.id, 'freeze', 'worker');
        else if (!s.auto_renew) await transition(s.id, 'freeze', 'worker');
        else if (!s.last_renewal_attempt_at || Date.now() - new Date(s.last_renewal_attempt_at) > 3600000) await renew(s.id, `renew:${s.id}:${new Date(s.end_date).toISOString()}`, 'worker', true);
        result.processed++;
      } catch (e) { result.failed++; result.failures.push({ id: s.id, error: e.message }); }
    }
    await dispatch(); // Manual operations must propagate even while automatic charging is in dry-run.
    return result;
  }
  async function assignExtension(input,actor) {
    return transaction(async c=>{
      const s=await subscription(c,input.subscription_id,true);
      if(!['active','grace'].includes(s.status))throw fail('Subscription is not active');
      if(!String(input.extension).startsWith(s.customer_id))throw fail('Extension must use the customer prefix');
      const used=await c.query("SELECT COUNT(*)::int AS used FROM extension_assets WHERE subscription_id=$1 AND status IN ('active','frozen')",[s.id]);
      if(used.rows[0].used>=Number(s.entitlement_snapshot.extensions || 0))throw fail('Extension capacity is full; activate a capacity plan',409);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`extension-numbers:${s.customer_id}`]);
      const existing=await c.query("SELECT id FROM extension_assets WHERE extension_number=$1 AND status IN ('active','frozen')",[input.extension]);
      if(existing.rows.length)throw fail('Extension is already reserved',409);
      await c.query(`INSERT INTO extension_assets(customer_id,subscription_id,source_type,source_id,extension_number,extension_name,status)
        VALUES($1,$2,'plan',$3,$4,$5,'active') ON CONFLICT(customer_id,subscription_id,extension_number) DO UPDATE SET status='active',extension_name=EXCLUDED.extension_name,updated_at=now()`,[s.customer_id,s.id,s.plan_id,input.extension,input.name]);
      await event(c,s,'reconcile',actor);return {success:true};
    });
  }
  async function unassignExtension(input,actor) {
    return transaction(async c=>{
      const s=await subscription(c,input.subscription_id,true);
      const result=await c.query("UPDATE extension_assets SET status='released',updated_at=now() WHERE subscription_id=$1 AND extension_number=$2 AND status<>'released'",[s.id,input.extension]);
      if(!result.rowCount)throw fail('Extension ownership not found',404);
      await event(c,s,'reconcile',actor);return {success:true};
    });
  }
  return { list, listAll, quote, subscription: id => subscription(pool, id), assets, activate, renew, transition, autoRenew, assignMonitoring, unassignMonitoring, transferMonitoring, assignExtension,unassignExtension, move, dispatch, tick,
    history: async id => (await pool.query('SELECT * FROM subscription_history WHERE subscription_id=$1 ORDER BY created_at DESC', [(await subscription(pool, id)).id])).rows };
}
module.exports = { createSubscriptionLifecycle, periodEnd, serviceAuth, ASSETS };
