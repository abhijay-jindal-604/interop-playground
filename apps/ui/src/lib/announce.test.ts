import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_DELAY_MS, POLITE_WINDOW_MS, announce, resetAnnouncer } from './announce.js';

describe('ui.live-regions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncer();
    document.body.innerHTML = '<div id="live-polite"></div><div id="live-assertive"></div>';
  });
  afterEach(() => vi.useRealTimers());
  const text = (id: string) => document.getElementById(id)?.textContent;

  it('clears, waits 50 ms, then sets the text', () => {
    announce('Copied.');
    expect(text('live-polite')).toBe('');
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(text('live-polite')).toBe('Copied.');
  });

  it('keeps one polite message per 1.5 s, the last one wins; assertive is never dropped', () => {
    announce('one');
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    announce('two');
    announce('three');
    announce('Waiting for you: scan the QR.', 'assertive');
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(text('live-assertive')).toBe('Waiting for you: scan the QR.');
    expect(text('live-polite')).toBe('one');
    vi.advanceTimersByTime(POLITE_WINDOW_MS);
    expect(text('live-polite')).toBe('three');
  });
});
