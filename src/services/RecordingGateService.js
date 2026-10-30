const { createClient } = require('redis');

const RECORDING_GATE_KEY = process.env.RECORDING_OVERLIMIT_SET_KEY
  || 'blacklist:customers:recording_overlimit';

let client;
let connecting;

function getClient() {
  if (!client) {
    client = createClient({
      socket: {
        host: process.env.LOOKUP_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.LOOKUP_REDIS_PORT || process.env.REDIS_PORT || 6379),
        connectTimeout: 1000,
        reconnectStrategy: false,
      },
      database: Number(process.env.LOOKUP_REDIS_DB || process.env.REDIS_DB || 2),
      password: process.env.LOOKUP_REDIS_PASSWORD || process.env.REDIS_PASSWORD || undefined,
    });
    client.on('error', (error) => {
      console.error(`[RecordingGate] Redis error: ${error.message}`);
    });
  }
  return client;
}

async function connectedClient() {
  const redisClient = getClient();
  if (!redisClient.isOpen) {
    connecting ||= redisClient.connect().finally(() => { connecting = null; });
    await connecting;
  }
  return redisClient;
}

class RecordingGateService {
  static availablePower(wallet) {
    const fiatBalance = Number(wallet?.fiat_balance || 0);
    const creditLimit = Number(wallet?.credit_limit || 0);
    const creditUsed = Number(wallet?.credit_used || 0);
    return fiatBalance + Math.max(0, creditLimit - creditUsed);
  }

  static async sync(customerId, wallet) {
    if (!customerId || !wallet) return;
    try {
      const redisClient = await connectedClient();
      const availablePower = this.availablePower(wallet);
      if (availablePower > 0) {
        await redisClient.sRem(RECORDING_GATE_KEY, customerId);
        console.log(`[RecordingGate] Customer ${customerId} has purchasing power. Call recording unblocked.`);
      } else {
        await redisClient.sAdd(RECORDING_GATE_KEY, customerId);
        console.log(`[RecordingGate] Customer ${customerId} has no purchasing power. Call recording blocked.`);
      }
    } catch (error) {
      // Wallet mutations remain authoritative; Redis will be reconciled by the
      // next wallet or billing event instead of failing a completed payment.
      console.error(`[RecordingGate] Failed to sync customer ${customerId}: ${error.message}`);
    }
  }
}

module.exports = RecordingGateService;
