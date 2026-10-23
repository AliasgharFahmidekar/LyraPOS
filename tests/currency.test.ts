import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAccountingAmountInput, formatAccountingMoney, formatCurrency, formatCurrencyForTenant, getCurrencyFractionDigits, parseAccountingAmountToMinor } from '../main/countries';

test('formatCurrency: en-US / USD', () => {
  assert.equal(formatCurrency(1234.5, 'USD', 'en-US'), '$1,234.50');
});

test('formatCurrency: en-IN / INR has rupees symbol and grouping', () => {
  const out = formatCurrency(1234.5, 'INR', 'en-IN');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrency: es-AR / ARS uses comma decimal', () => {
  const out = formatCurrency(1234.5, 'ARS', 'es-AR');
  assert.match(out, /1\.234,50/);
});

test('formatCurrency: zero amount still formats', () => {
  assert.equal(formatCurrency(0, 'USD', 'en-US'), '$0.00');
});

test('formatCurrency: empty currency falls back to fixed', () => {
  assert.equal(formatCurrency(1234.5, '', 'en-US'), '1234.50');
});

test('formatCurrencyForTenant: IN tenant uses en-IN locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'IN', 'INR');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrencyForTenant: AR tenant uses es-AR locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'AR', 'ARS');
  assert.match(out, /1\.234,50/);
});

test('formatCurrencyForTenant: US tenant uses en-US locale', () => {
  assert.equal(formatCurrencyForTenant(1234.5, 'US', 'USD'), '$1,234.50');
});

test('formatCurrencyForTenant: COP follows ISO 4217 two-digit precision', () => {
  const out = formatCurrencyForTenant(11000, 'CO', 'COP');
  assert.match(out, /11\.000,00/);
  assert.equal(getCurrencyFractionDigits('COP'), 2);
});

test('formatCurrencyForTenant: KWD uses three fraction digits', () => {
  const out = formatCurrencyForTenant(1.25, 'KW', 'KWD');
  assert.match(out, /١٫٢٥٠/);
});

test('formatCurrencyForTenant: unknown country falls back to en-US', () => {
  assert.equal(formatCurrencyForTenant(7, 'ZZ', 'USD'), '$7.00');
});

test('formatCurrencyForTenant: missing country defaults to IN', () => {
  const out = formatCurrencyForTenant(7, undefined, 'INR');
  assert.match(out, /7\.00/);
  assert.match(out, /₹/);
});

test('formatCurrencyForTenant: arbitrary currency code avoids Intl placeholder', () => {
  const out = formatCurrencyForTenant(100, 'US', 'XXX');
  assert.match(out, /XXX/);
  assert.doesNotMatch(out, /¤/);
});

test('getCurrencyFractionDigits: resolves ISO 4217 standard precision', () => {
  const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } = require('../main/countries');
  assert.equal(getCurrencyFractionDigits('JPY'), 0);
  assert.equal(getCurrencyMinorUnitFactor('JPY'), 1);

  assert.equal(getCurrencyFractionDigits('KRW'), 0);
  assert.equal(getCurrencyMinorUnitFactor('KRW'), 1);

  assert.equal(getCurrencyFractionDigits('VND'), 0);
  assert.equal(getCurrencyMinorUnitFactor('VND'), 1);

  assert.equal(getCurrencyFractionDigits('USD'), 2);
  assert.equal(getCurrencyMinorUnitFactor('USD'), 100);

  assert.equal(getCurrencyFractionDigits('EUR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('EUR'), 100);

  assert.equal(getCurrencyFractionDigits('INR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('INR'), 100);

  assert.equal(getCurrencyFractionDigits('IRR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('IRR'), 100);

  assert.equal(getCurrencyFractionDigits('KWD'), 3);
  assert.equal(getCurrencyMinorUnitFactor('KWD'), 1000);

  assert.equal(getCurrencyFractionDigits('BHD'), 3);
  assert.equal(getCurrencyMinorUnitFactor('BHD'), 1000);

  // Fallback for unknown / empty / non-string
  assert.equal(getCurrencyFractionDigits(''), 2);
  assert.equal(getCurrencyFractionDigits(null as any), 2);
  assert.equal(getCurrencyFractionDigits('INVALID'), 2);
});

test('getCurrencyUnitAdapter: zero-decimal currencies use whole integer steps', () => {
  const { getCurrencyUnitAdapter, getCurrencyFractionDigits } = require('../main/countries');
  const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
  assert.equal(jpyAdapter.scale, 1);
  assert.equal(jpyAdapter.label, 'JPY');
  assert.equal(jpyAdapter.step, '1');
  assert.equal(jpyAdapter.maxDecimals, 0);
  assert.equal(jpyAdapter.toDisplay(1234.5), 1235);
  assert.equal(jpyAdapter.toStored(1235), 1235);
  assert.equal(jpyAdapter.formatInput(1235), '1235');

  const krwAdapter = getCurrencyUnitAdapter('KRW', 'KR');
  assert.equal(krwAdapter.step, '1');
  assert.equal(krwAdapter.maxDecimals, 0);

  const clfAdapter = getCurrencyUnitAdapter('CLF', 'CL');
  assert.equal(clfAdapter.step, '0.0001');
  assert.equal(clfAdapter.maxDecimals, 4);

  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  assert.equal(usdAdapter.scale, 1);
  assert.equal(usdAdapter.label, 'USD');
  assert.equal(usdAdapter.step, '0.01');
  assert.equal(usdAdapter.maxDecimals, 2);
  assert.equal(usdAdapter.toDisplay(12.34), 12.34);
  assert.equal(usdAdapter.toStored(12.34), 12.34);
  assert.equal(usdAdapter.formatInput(12.34), '12.34');
});


test('accounting money display honors the tenant toman preference without changing stored rials', () => {
  const prefs = { currencyDisplay: 'toman' as const, digits: 'latin' as const, calendar: 'gregorian' as const };
  assert.match(formatAccountingMoney(123450, { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', countryCode: 'IR', preferences: prefs }), /تومان/);
  assert.doesNotMatch(formatAccountingMoney(123450, { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', countryCode: 'IR', preferences: prefs }), /ریال/);
  assert.equal(formatAccountingAmountInput(1234, { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', countryCode: 'IR', preferences: prefs }), '123.4');
  assert.equal(parseAccountingAmountToMinor('۱۲۳٫۴', { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', countryCode: 'IR', preferences: prefs }), 1234);
  assert.equal(parseAccountingAmountToMinor('1234', { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', preferences: { currencyDisplay: 'rial', digits: 'latin', calendar: 'gregorian' } }), 1234);
});

test('accounting money parser preserves ISO minor units for non-IRR currencies and rejects inexact values', () => {
  assert.equal(parseAccountingAmountToMinor('12.34', { currency: 'USD', fractionDigits: 2, locale: 'en-US' }), 1234);
  assert.equal(formatAccountingMoney(1234, { currency: 'USD', fractionDigits: 2, locale: 'en-US' }), '$12.34');
  assert.equal(parseAccountingAmountToMinor('-1', { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR' }), null);
  assert.equal(parseAccountingAmountToMinor('0', { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR' }), null);
  assert.equal(parseAccountingAmountToMinor('0', { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR' }, true), 0);
  assert.equal(parseAccountingAmountToMinor('1.001', { currency: 'USD', fractionDigits: 2, locale: 'en-US' }), null);
});

test('accounting amount parser validates locale grouping and decimal separators', () => {
  const en = { currency: 'USD', fractionDigits: 2, locale: 'en-US' };
  assert.equal(parseAccountingAmountToMinor('1,234.56', en), 123456, 'US thousands and decimal separators parse exactly');
  assert.equal(parseAccountingAmountToMinor('12,34', en), null, 'malformed US grouping is rejected rather than stripped into a larger amount');
  assert.equal(parseAccountingAmountToMinor('1,234', en), 123400, 'valid US grouping is interpreted as an integer amount');

  const de = { currency: 'EUR', fractionDigits: 2, locale: 'de-DE' };
  assert.equal(parseAccountingAmountToMinor('12,34', de), 1234, 'comma decimal separator follows German locale');
  assert.equal(parseAccountingAmountToMinor('1.234,56', de), 123456, 'German grouping and decimal separators parse exactly');
  assert.equal(parseAccountingAmountToMinor('12.34', de), 1234, 'dot-decimal keyboard entry is accepted when it is not valid grouping');

  const toman = { currency: 'IRR', fractionDigits: 0, locale: 'fa-IR', countryCode: 'IR',
    preferences: { currencyDisplay: 'toman' as const, digits: 'latin' as const, calendar: 'gregorian' as const } };
  assert.equal(parseAccountingAmountToMinor('۱۲۳٬۴۵۶٫۷', toman), 1234567, 'Persian digits, grouping and decimal convert toman to canonical rials');
  assert.equal(parseAccountingAmountToMinor('123,4', toman), null, 'ambiguous comma input in a Persian locale is rejected');
  assert.equal(parseAccountingAmountToMinor('123.4', toman), 1234, 'dot decimal keyboard entry is accepted for toman');
  assert.equal(parseAccountingAmountToMinor('123.45', toman), null, 'input representing fractional rial is rejected');
});
