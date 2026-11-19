'use client';
// Tokens, time and cost of one anchor call (judge or REWRITE writer), in the
// same chips a reply shows under its bubble (つよ, 2026-11-19). The price is
// the same messageCost() a reply uses, so the anchor can never be priced
// differently from what the statistics bill. Reports saved before this have
// no usage: nothing is shown rather than a "0".

import React from 'react';
import { messageCost, resolvePrice } from '@/lib/modelPricing';
import { useT } from '@/lib/i18n';
import ClickTip from './ClickTip';
import type { AnchorUsage } from '@/lib/anchor';

export function AnchorCost({ usage, ms, model, family, at }: {
  usage?: AnchorUsage | null;
  ms?: number;
  model: string;
  family?: string;
  at?: number;
}) {
  const t = useT();
  const hasUsage = !!usage && (usage.totalInputTokens > 0 || usage.outputTokens > 0);
  if (!hasUsage && typeof ms !== 'number') return null;
  const pct = usage && usage.totalInputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.totalInputTokens) * 100) : 0;
  const cost = family !== 'Local' && hasUsage ? messageCost(usage, model, undefined, at) : null;
  const priced = family !== 'Local' && !!resolvePrice(model);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {typeof ms === 'number' && (
        <span className="px-1.5 py-0.5 rounded-full bg-muted font-mono">⏱ {(ms / 1000).toFixed(1)}s</span>
      )}
      {hasUsage && (
        <span className={`px-1.5 py-0.5 rounded-full font-mono ${usage!.cachedInputTokens > 0 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted'}`}>
          {usage!.totalInputTokens.toLocaleString()} {t('bubble.cache.in')}
          {usage!.cachedInputTokens > 0 && (
            <span className="ml-1 opacity-80">{t('bubble.cache.cached').replace('{n}', usage!.cachedInputTokens.toLocaleString()).replace('{pct}', String(pct))}</span>
          )}
          {usage!.outputTokens > 0 && (
            <span className="ml-1 opacity-80">{t('bubble.cache.out').replace('{n}', usage!.outputTokens.toLocaleString())}</span>
          )}
        </span>
      )}
      {hasUsage && family !== 'Local' && (cost ? (
        <ClickTip className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-mono cursor-pointer" text={cost.breakdown}>$</ClickTip>
      ) : !priced ? (
        <ClickTip className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/50 font-mono cursor-pointer" text={t('bubble.price.none').replace('{model}', model || '—')}>$</ClickTip>
      ) : null)}
    </div>
  );
}
