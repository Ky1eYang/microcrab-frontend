import React, { useState } from "react";
import type { SubscriptionPlan } from "../../types";
import { mockSubscriptionPlans } from "../../mockData";

export const SubscriptionView: React.FC = () => {
  const [plans] = useState<SubscriptionPlan[]>(mockSubscriptionPlans);

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            订阅管理 (Subscription Plans)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置与监控商业化订阅套餐、周期配额、RPM/TPM 限额及在保付费租户
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {plans.map((p) => {
          const isPro = p.tier === "pro";
          const isTeam = p.tier === "team";
          const isEnt = p.tier === "enterprise";

          const borderHighlight = isEnt
            ? "border-purple-500/30"
            : isTeam
              ? "border-cyan-500/30"
              : isPro
                ? "border-emerald-500/30"
                : "border-dash-line";

          return (
            <div
              key={p.id}
              className={`sb-card p-4 flex flex-col justify-between space-y-3 ${borderHighlight}`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-neutral-200">
                    {p.name}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-mono bg-dash-terminal text-neutral-400 border border-dash-line">
                    {p.tier}
                  </span>
                </div>

                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-2xl font-extrabold text-white font-mono">
                    ${p.priceMonthly}
                  </span>
                  <span className="text-xs text-neutral-500 font-mono">
                    / 月
                  </span>
                </div>

                <div className="text-[11px] text-neutral-500 font-mono mt-0.5">
                  年付: ${p.priceYearly} / 年
                </div>

                <div className="sb-terminal-box p-3 my-3 space-y-1.5 text-xs font-mono">
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>月度 Token:</span>
                    <strong className="text-cyan-400">
                      {p.monthlyTokenQuota}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>RPM / TPM:</span>
                    <span className="text-neutral-300">
                      {p.rpmLimit} / {(p.tpmLimit / 1000).toFixed(0)}K
                    </span>
                  </div>
                </div>

                <ul className="space-y-1 text-xs text-neutral-400">
                  {p.features.map((f, idx) => (
                    <li key={idx} className="flex items-center gap-1.5">
                      <span className="text-emerald-400 text-xs">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pt-3 border-t border-dash-line flex items-center justify-between text-xs">
                <span className="text-neutral-500 font-mono">
                  当前订阅用户:
                </span>
                <span className="font-mono text-emerald-400 font-bold">
                  {p.activeSubscribers} 人
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
