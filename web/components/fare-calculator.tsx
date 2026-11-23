'use client';
import { useId, useState } from 'react';
import { calculateFare, FARE_VERIFIED_AT, type FareOperator, type FarePayment } from '@/lib/fares';
import { type Locale, pageUrl } from '@/lib/content';
import { Icon } from './icon';

const names: Record<FareOperator, string> = { ttc: 'TTC', miway: 'MiWay', go: 'GO Transit' };
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const reasons: Record<string, { en: string; zh: string }> = {
  'single-operator': { en: 'Adult single fare for the selected payment method.', zh: '所选付款方式的成人单次票价。' },
  'eligible-one-fare': { en: 'This connection meets the modelled One Fare conditions.', zh: '此衔接符合本计算器覆盖的 One Fare 条件。' },
  'cash-not-eligible': { en: 'Cash does not qualify for cross-agency One Fare. Both fares apply.', zh: '现金不适用跨机构 One Fare，需支付两段票价。' },
  'different-payment-method': { en: 'Use the same physical card or device throughout to qualify. Both fares apply here.', zh: '享受优惠须全程使用同一实体卡或设备。当前计算为两段均收费。' },
  'transfer-window-expired': { en: 'The transfer window has expired. A second fare applies.', zh: '换乘时限已过，需再次付费。' },
  'go-fare-required': { en: 'Add an official GO adult fare quote to calculate a total.', zh: '请输入 GO 官方成人票价，才能计算总额。' },
  'go-cash-unsupported': { en: 'GO cash and e-ticket pricing is outside this calculator. Check GO directly.', zh: 'GO 现金及电子车票不在本计算器范围，请查 GO 官方信息。' },
};

export function FareCalculator({ locale, compact = false }: { locale: Locale; compact?: boolean }) {
  const zh = locale === 'zh';
  const id = useId();
  const [first, setFirst] = useState<FareOperator>('miway');
  const [second, setSecond] = useState<FareOperator | ''>('ttc');
  const [payment, setPayment] = useState<FarePayment>('presto');
  const [minutes, setMinutes] = useState('45');
  const [sameCard, setSameCard] = useState(true);
  const [goQuote, setGoQuote] = useState('');
  const hasGo = first === 'go' || second === 'go';
  const quoteCents = !hasGo || goQuote.trim() === '' ? undefined : /^\d+(\.\d{1,2})?$/.test(goQuote) ? Math.round(Number(goQuote) * 100) : -1;
  const result = calculateFare({ firstOperator: first, secondOperator: second || undefined, payment, elapsedMinutes: minutes.trim() === '' ? NaN : Number(minutes), sameCard, goFareCents: quoteCents });
  const message = reasons[result.reason]?.[locale] || (zh ? '请检查输入的数字和付款选项。' : 'Please check the entered amounts and payment options.');
  function changeFirst(value: FareOperator) { setFirst(value); if (value === second) setSecond(''); }

  return <section className={`calculator ${compact ? 'calculator-compact' : ''}`} aria-labelledby={`${id}-title`}>
    <div className="calculator-heading"><span className="calculator-icon"><Icon name="ticket" size={22}/></span><div><h2 id={`${id}-title`}>{zh ? '出发前，算清票价。' : 'Know your fare before you go.'}</h2><p>{zh ? '成人单次行程 · 加元' : 'Adult single journey · Canadian dollars'}</p></div></div>
    <form onSubmit={event => event.preventDefault()} className="fare-form">
      <div className="field-pair">
        <label htmlFor={`${id}-first`}>{zh ? '首先乘坐' : 'Start with'}<select id={`${id}-first`} value={first} onChange={event => changeFirst(event.target.value as FareOperator)}>{Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label htmlFor={`${id}-second`}>{zh ? '然后换乘' : 'Then connect to'}<select id={`${id}-second`} value={second} onChange={event => setSecond(event.target.value as FareOperator | '')}><option value="">{zh ? '不换乘' : 'No connection'}</option>{Object.entries(names).filter(([key]) => key !== first).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </div>
      <fieldset className="payment-field"><legend>{zh ? '如何付款？' : 'How will you pay?'}</legend><div className="payment-options">{(['presto', 'contactless', 'cash'] as const).map(method => <label key={method} className={payment === method ? 'selected' : ''}><input type="radio" name={`${id}-payment`} value={method} checked={payment === method} onChange={() => setPayment(method)}/><span>{method === 'presto' ? 'PRESTO' : method === 'contactless' ? (zh ? '银行卡' : 'Debit / credit') : (zh ? '现金' : 'Cash')}</span></label>)}</div></fieldset>
      {second && <div className="transfer-fields"><label htmlFor={`${id}-minutes`}>{zh ? '首次刷卡至换乘的分钟数' : 'Minutes from first tap to connection'}<div className="input-suffix"><input id={`${id}-minutes`} inputMode="numeric" type="number" min="0" max="1440" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} required/><span>{zh ? '分钟' : 'min'}</span></div></label><label className="checkbox-label" htmlFor={`${id}-same`}><input id={`${id}-same`} type="checkbox" checked={sameCard} onChange={event => setSameCard(event.target.checked)} disabled={payment === 'cash'}/><span>{zh ? '全程使用同一张卡或同一设备' : 'Same card or device for the whole trip'}</span></label></div>}
      {hasGo && <div className="go-quote"><label htmlFor={`${id}-go`}>{zh ? 'GO 官方成人行程报价（CAD）' : 'Your official GO adult fare quote (CAD)'}<input id={`${id}-go`} inputMode="decimal" type="text" value={goQuote} onChange={event => setGoQuote(event.target.value)} placeholder={zh ? '输入官方查询金额' : 'Enter your quoted fare'}/></label><a href="https://www.gotransit.com/en/ways-to-pay/fare-information" target="_blank" rel="noopener noreferrer">{zh ? '在 GO 官方查询票价' : 'Get a quote from GO Transit'} <Icon name="external" size={14}/></a><p>{zh ? '请使用相同付款方式的官方报价。本网站不会自动获取 GO 票价。' : 'Use a quote for the same payment method. GO prices are not fetched automatically.'}</p></div>}
    </form>
    <div className="fare-result" aria-live="polite" aria-atomic="true">
      <div className="fare-total"><div><span className="fare-label">{zh ? '预计行程合计' : 'Estimated journey total'}</span><strong data-testid="fare-total">{result.totalCents === null ? (zh ? '待核实' : 'Check fare') : money(result.totalCents)}{result.totalCents !== null && <small> CAD</small>}</strong></div>{result.savingsCents !== null && result.savingsCents > 0 && <span className="saving-badge"><Icon name="check" size={15}/>{zh ? '换乘减免' : 'Transfer saving'} {money(result.savingsCents)}</span>}</div>
      <p className={`result-message ${result.status !== 'estimate' ? 'result-attention' : ''}`}>{message}</p>
      <dl className="fare-breakdown">{result.breakdown.map((leg, i) => <div key={`${leg.operator}-${i}`}><dt>{names[leg.operator]}{leg.discountCents > 0 && <small>{zh ? ' · 含换乘减免' : ' · transfer applied'}</small>}</dt><dd>{leg.chargedCents === null ? (zh ? '待报价' : 'Quote needed') : money(leg.chargedCents)}</dd></div>)}</dl>
    </div>
    <p className="calculator-note">{zh ? '不含通票、累计封顶及优惠票种。换乘到期瞬间保守按失效处理。' : 'Excludes passes, accumulated fare caps and concession fares. The exact expiry boundary is treated conservatively.'} <a href={pageUrl('one-fare', locale)}>{zh ? '查看规则' : 'Read the rules'}</a></p>
    <div className="calculator-source"><Icon name="shield" size={15}/><a href={pageUrl('sources', locale)}>{zh ? '官方规则核实于' : 'Official rules reviewed'} {FARE_VERIFIED_AT}</a></div>
  </section>;
}
