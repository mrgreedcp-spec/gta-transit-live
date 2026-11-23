/**
 * Adult, single-journey estimates for at most two different operators.
 *
 * All values are CAD cents. Sources were checked on FARE_VERIFIED_AT; this is
 * a policy verification date, never a live feed or an automatic refresh time.
 * PRESTO fare caps, passes, concession fares and GO loyalty are out of scope.
 */
export type FareOperator = 'ttc' | 'miway' | 'go';
export type FarePayment = 'presto' | 'contactless' | 'cash';

export interface FareInput {
  firstOperator: FareOperator;
  secondOperator?: FareOperator;
  payment: FarePayment;
  elapsedMinutes: number;
  sameCard: boolean;
  /** The user's adult fare quote from GO's official trip planner. No default. */
  goFareCents?: number;
}

export interface FareLeg {
  operator: FareOperator;
  baseCents: number | null;
  discountCents: number;
  chargedCents: number | null;
}

export interface FareResult {
  status: 'estimate' | 'needs-go-fare' | 'unsupported';
  reason: string;
  totalCents: number | null;
  undiscountedCents: number | null;
  savingsCents: number | null;
  breakdown: FareLeg[];
  sources: string[];
  verifiedAt: string;
}

export const FARE_VERIFIED_AT = '2026-11-23';

export const FARE_SOURCES = {
  ttc: 'https://www.ttc.ca/Fares-and-passes',
  miway: 'https://www.mississauga.ca/miway-transit/fares/fare-prices/',
  go: 'https://www.gotransit.com/en/ways-to-pay/fare-information',
  oneFare: 'https://www.ttc.ca/Fares-and-passes/Regional-travel-and-One-Fare',
  miwayTransfers: 'https://www.mississauga.ca/miway-transit/fares/transfers/',
  goTransfers: 'https://www.gotransit.com/en/your-commute-to-go/go-transit-local-transit-partners',
} as const;

const LOCAL_FARES: Record<Exclude<FareOperator, 'go'>, Record<FarePayment, number>> = {
  ttc: { presto: 330, contactless: 330, cash: 335 },
  // MiWay charges the cash fare for debit/credit contactless, NOT the PRESTO fare.
  miway: { presto: 350, contactless: 450, cash: 450 },
};

const isOperator = (value: unknown): value is FareOperator =>
  value === 'ttc' || value === 'miway' || value === 'go';
const isPayment = (value: unknown): value is FarePayment =>
  value === 'presto' || value === 'contactless' || value === 'cash';

function unsupported(reason: string): FareResult {
  return {
    status: 'unsupported', reason, totalCents: null, undiscountedCents: null,
    savingsCents: null, breakdown: [], sources: [], verifiedAt: FARE_VERIFIED_AT,
  };
}

/**
 * This is a bounded, deterministic fare comparison, not a fare-payment service.
 * At exactly 120/180 minutes we conservatively regard the transfer as expired.
 * Published rules say "within" the window; they do not promise an inclusive
 * boundary or account for reader-clock differences.
 *
 * GO co-fare is represented by removing the local fare. Actual payment history
 * may charge local first and refund it at GO; the breakdown is the final cost
 * allocation, not the exact sequence of card-reader transactions.
 */
export function calculateFare(input: FareInput): FareResult {
  if (!input || typeof input !== 'object') return unsupported('invalid-input');
  const { firstOperator, secondOperator, payment, elapsedMinutes, sameCard, goFareCents } = input;

  if (!isOperator(firstOperator) || (secondOperator !== undefined && !isOperator(secondOperator))) {
    return unsupported('invalid-operator');
  }
  if (!isPayment(payment)) return unsupported('invalid-payment');
  if (typeof elapsedMinutes !== 'number' || !Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) {
    return unsupported('invalid-elapsed-minutes');
  }
  if (typeof sameCard !== 'boolean') return unsupported('invalid-same-card');
  if (goFareCents !== undefined && (!Number.isSafeInteger(goFareCents) || goFareCents < 0)) {
    return unsupported('invalid-go-fare');
  }
  if (secondOperator === firstOperator) return unsupported('same-operator-unsupported');

  const operators: FareOperator[] = secondOperator ? [firstOperator, secondOperator] : [firstOperator];
  const hasGo = operators.includes('go');
  const sources: string[] = [...new Set([
    ...operators.map((operator) => FARE_SOURCES[operator]),
    ...(secondOperator ? [FARE_SOURCES.oneFare] : []),
    ...(secondOperator && operators.includes('miway') ? [FARE_SOURCES.miwayTransfers] : []),
    ...(secondOperator && hasGo ? [FARE_SOURCES.goTransfers] : []),
  ])];

  // The MVP has no verified GO cash/e-ticket pricing model; never substitute a
  // PRESTO or contactless quote for a different payment product.
  if (hasGo && payment === 'cash') {
    return { ...unsupported('go-cash-unsupported'), sources };
  }

  const windowMinutes = firstOperator === 'go' ? 180 : 120;
  let reason = 'single-operator';
  let eligible = false;
  if (secondOperator) {
    if (payment === 'cash') reason = 'cash-not-eligible';
    else if (!sameCard) reason = 'different-payment-method';
    else if (elapsedMinutes >= windowMinutes) reason = 'transfer-window-expired';
    else {
      eligible = true;
      reason = 'eligible-one-fare';
    }
  }

  const breakdown: FareLeg[] = operators.map((operator, index) => {
    const baseCents = operator === 'go' ? (goFareCents ?? null) : LOCAL_FARES[operator][payment];
    // A GO journey retains the quoted GO fare and discounts the local portion.
    // A local-to-local journey retains the FIRST operator's fare.
    const discountLocal = eligible && (hasGo ? operator !== 'go' : index === 1);
    const discountCents = discountLocal ? (baseCents ?? 0) : 0;
    return {
      operator, baseCents, discountCents,
      chargedCents: baseCents === null ? null : Math.max(0, baseCents - discountCents),
    };
  });

  if (hasGo && goFareCents === undefined) {
    return {
      status: 'needs-go-fare', reason: 'go-fare-required', totalCents: null,
      undiscountedCents: null, savingsCents: null, breakdown, sources,
      verifiedAt: FARE_VERIFIED_AT,
    };
  }

  const undiscountedCents = breakdown.reduce((total, leg) => total + (leg.baseCents ?? 0), 0);
  const totalCents = breakdown.reduce((total, leg) => total + (leg.chargedCents ?? 0), 0);
  if (!Number.isSafeInteger(undiscountedCents) || !Number.isSafeInteger(totalCents)) {
    return { ...unsupported('invalid-go-fare'), sources };
  }
  return {
    status: 'estimate', reason, totalCents, undiscountedCents,
    savingsCents: undiscountedCents - totalCents, breakdown, sources,
    verifiedAt: FARE_VERIFIED_AT,
  };
}
