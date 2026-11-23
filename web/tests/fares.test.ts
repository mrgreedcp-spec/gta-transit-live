import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFare, FARE_SOURCES, FARE_VERIFIED_AT, type FareInput } from '../lib/fares';

const baseline: FareInput = {
  firstOperator: 'miway', secondOperator: 'ttc', payment: 'presto',
  elapsedMinutes: 45, sameCard: true,
};

test('adult single fares distinguish MiWay PRESTO from contactless and cash', () => {
  const cases = [
    ['ttc', 'presto', 330], ['ttc', 'contactless', 330], ['ttc', 'cash', 335],
    ['miway', 'presto', 350], ['miway', 'contactless', 450], ['miway', 'cash', 450],
  ] as const;
  for (const [firstOperator, payment, totalCents] of cases) {
    const result = calculateFare({ ...baseline, secondOperator: undefined, firstOperator, payment });
    assert.equal(result.status, 'estimate');
    assert.equal(result.totalCents, totalCents);
    assert.equal(result.savingsCents, 0);
  }
});

test('local One Fare keeps the first operator payment price in either direction', () => {
  assert.equal(calculateFare(baseline).totalCents, 350);
  assert.equal(calculateFare({ ...baseline, firstOperator: 'ttc', secondOperator: 'miway' }).totalCents, 330);
  const contactless = calculateFare({ ...baseline, payment: 'contactless' });
  assert.equal(contactless.totalCents, 450);
  assert.equal(contactless.undiscountedCents, 780);
  assert.equal(contactless.savingsCents, 330);
});

test('cash receives no cross-agency One Fare discount', () => {
  const result = calculateFare({ ...baseline, payment: 'cash' });
  assert.equal(result.totalCents, 785);
  assert.equal(result.savingsCents, 0);
  assert.equal(result.reason, 'cash-not-eligible');
});

test('changing from a physical card to another device invalidates the modeled discount', () => {
  const result = calculateFare({ ...baseline, sameCard: false });
  assert.equal(result.totalCents, 680);
  assert.equal(result.reason, 'different-payment-method');
});

test('local transfer expiry is measured from the first tap and treated conservatively at 120 minutes', () => {
  assert.equal(calculateFare({ ...baseline, elapsedMinutes: 119.99 }).totalCents, 350);
  const expired = calculateFare({ ...baseline, elapsedMinutes: 120 });
  assert.equal(expired.totalCents, 680);
  assert.equal(expired.reason, 'transfer-window-expired');
  assert.equal(calculateFare({ ...baseline, elapsedMinutes: 180 }).totalCents, 680);
});

test('GO needs an official user-supplied quote and does not silently assume a fare', () => {
  for (const input of [
    { ...baseline, firstOperator: 'go', secondOperator: undefined },
    { ...baseline, firstOperator: 'go', secondOperator: 'miway' },
    { ...baseline, secondOperator: 'go' },
  ] as FareInput[]) {
    const result = calculateFare(input);
    assert.equal(result.status, 'needs-go-fare');
    assert.equal(result.reason, 'go-fare-required');
    assert.equal(result.totalCents, null);
    assert.equal(result.undiscountedCents, null);
    assert.equal(result.breakdown.find((leg) => leg.operator === 'go')?.baseCents, null);
  }
});

test('GO co-fare removes the local fare in both directions while retaining the quoted GO price', () => {
  // 812 is an input fixture, not an advertised fare for any real route.
  const cases: FareInput[] = [
    { ...baseline, secondOperator: 'go', goFareCents: 812 },
    { ...baseline, firstOperator: 'go', secondOperator: 'miway', goFareCents: 812 },
    { ...baseline, firstOperator: 'ttc', secondOperator: 'go', goFareCents: 812 },
    { ...baseline, firstOperator: 'go', secondOperator: 'ttc', goFareCents: 812 },
  ];
  for (const input of cases) {
    const result = calculateFare(input);
    assert.equal(result.totalCents, 812);
    assert.equal(result.reason, 'eligible-one-fare');
    assert.equal(result.breakdown.find((leg) => leg.operator !== 'go')?.chargedCents, 0);
  }
});

test('a GO-first transfer permits 3 hours, but a local-first transfer to GO only 2', () => {
  assert.equal(calculateFare({ ...baseline, firstOperator: 'go', goFareCents: 812, elapsedMinutes: 150 }).totalCents, 812);
  assert.equal(calculateFare({ ...baseline, secondOperator: 'go', goFareCents: 812, elapsedMinutes: 150 }).totalCents, 1162);
  assert.equal(calculateFare({ ...baseline, firstOperator: 'go', goFareCents: 812, elapsedMinutes: 179.99 }).totalCents, 812);
  assert.equal(calculateFare({ ...baseline, firstOperator: 'go', goFareCents: 812, elapsedMinutes: 180 }).totalCents, 1142);
});

test('an amount smaller than the local fare does not create a negative GO settlement', () => {
  const result = calculateFare({ ...baseline, secondOperator: 'go', goFareCents: 100 });
  assert.equal(result.totalCents, 100);
  assert.equal(result.savingsCents, 350);
  assert.ok(result.breakdown.every((leg) => leg.chargedCents !== null && leg.chargedCents >= 0));
});

test('GO cash is unsupported even if a quote is supplied', () => {
  const result = calculateFare({ ...baseline, secondOperator: 'go', payment: 'cash', goFareCents: 812 });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'go-cash-unsupported');
  assert.equal(result.totalCents, null);
});

test('non-finite, negative, fractional-cent and unsafe quotes fail closed', () => {
  for (const goFareCents of [Number.NaN, Infinity, -Infinity, -1, 330.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = calculateFare({ ...baseline, secondOperator: 'go', goFareCents });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'invalid-go-fare');
    assert.equal(result.totalCents, null);
  }
  assert.equal(calculateFare({ ...baseline, secondOperator: 'go', goFareCents: Number.MAX_SAFE_INTEGER }).status, 'unsupported');
});

test('invalid elapsed time, unknown operators and unsupported products cannot produce a quote', () => {
  for (const elapsedMinutes of [Number.NaN, Infinity, -1]) {
    assert.equal(calculateFare({ ...baseline, elapsedMinutes }).reason, 'invalid-elapsed-minutes');
  }
  assert.equal(calculateFare({ ...baseline, secondOperator: 'miway' }).reason, 'same-operator-unsupported');
  assert.equal(calculateFare({ ...baseline, firstOperator: 'up-express' } as unknown as FareInput).reason, 'invalid-operator');
  assert.equal(calculateFare({ ...baseline, payment: 'e-ticket' } as unknown as FareInput).reason, 'invalid-payment');
  assert.equal(calculateFare({ ...baseline, sameCard: 'yes' } as unknown as FareInput).reason, 'invalid-same-card');
});

test('every valid quote exposes official sources and a stable verification date', () => {
  const result = calculateFare(baseline);
  assert.equal(result.verifiedAt, FARE_VERIFIED_AT);
  assert.ok(result.sources.includes(FARE_SOURCES.ttc));
  assert.ok(result.sources.includes(FARE_SOURCES.miway));
  assert.ok(result.sources.includes(FARE_SOURCES.oneFare));
  assert.equal(new Set(result.sources).size, result.sources.length);
});
