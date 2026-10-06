class ProrationService {
  /**
   * Calculate mid-cycle proration quote for purchasing an add-on item.
   * 
   * Formula:
   * Remaining Days (R) = CEIL((end_date - current_date) in days)
   * Daily Rate (D)     = Monthly Unit Price / Total Cycle Days (30)
   * Immediate Charge   = D * R * Quantity
   */
  static calculateProrationQuote({ unitPrice, quantity = 1, startDate, endDate }) {
    const now = new Date(startDate || Date.now());
    const targetEnd = new Date(endDate);

    const diffTime = Math.max(0, targetEnd.getTime() - now.getTime());
    const remainingDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const totalCycleDays = 30; // 30-day billing cycle standard

    const dailyRate = Number(unitPrice) / totalCycleDays;
    const proratedCharge = Number((dailyRate * remainingDays * Number(quantity)).toFixed(2));

    return {
      remaining_days: remainingDays,
      total_cycle_days: totalCycleDays,
      unit_price: Number(unitPrice),
      quantity: Number(quantity),
      prorated_charge_due: proratedCharge
    };
  }
}

module.exports = ProrationService;
