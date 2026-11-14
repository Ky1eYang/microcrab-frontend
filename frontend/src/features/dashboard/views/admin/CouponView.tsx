import React, { useState } from "react";
import type { CouponItem, CouponStatus } from "../../types";
import { mockCoupons } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const CouponView: React.FC = () => {
  const [coupons, setCoupons] = useState<CouponItem[]>(mockCoupons);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newType, setNewType] = useState<"percentage" | "fixed">("percentage");
  const [newValue, setNewValue] = useState("20");
  const [newMinSpend, setNewMinSpend] = useState("50");
  const [newMaxUses, setNewMaxUses] = useState("500");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const handleCreateCoupon = () => {
    if (!newCode.trim()) return;
    const item: CouponItem = {
      id: `cpn_${Date.now()}`,
      code: newCode.trim().toUpperCase(),
      discountType: newType,
      discountValue: parseFloat(newValue) || 10,
      minSpendUsd: parseFloat(newMinSpend) || 0,
      maxUses: parseInt(newMaxUses, 10) || 100,
      usedCount: 0,
      validFrom: "2026-10-01",
      validTo: "2026-12-31",
      status: "active" as CouponStatus,
    };
    setCoupons([item, ...coupons]);
    setNewCode("");
    setIsModalOpen(false);
    showToast(`优惠码 ${item.code} 创建成功`);
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            优惠码管理 (Coupons & Discounts)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置充值折扣码、满减券、有效周期与最大核销次数
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 创建优惠码</span>
        </button>
      </div>

      {toastMessage && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{toastMessage}</span>
        </div>
      )}

      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">优惠代码</th>
                <th className="py-3 px-4">折扣力度</th>
                <th className="py-3 px-4 text-center">门槛限制</th>
                <th className="py-3 px-4 text-center">已用 / 上限</th>
                <th className="py-3 px-4">有效期</th>
                <th className="py-3 px-4">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {coupons.map((c) => {
                const isActive = c.status === "active";
                return (
                  <tr
                    key={c.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4 font-bold text-neutral-200">
                      {c.code}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-emerald-400 font-bold">
                        {c.discountType === "percentage"
                          ? `${c.discountValue}% 折扣`
                          : `立减 $${c.discountValue}`}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center text-neutral-400">
                      {c.minSpendUsd > 0 ? `满 $${c.minSpendUsd}` : "无门槛"}
                    </td>
                    <td className="py-3 px-4 text-center text-neutral-300">
                      {c.usedCount} / {c.maxUses}
                    </td>
                    <td className="py-3 px-4 text-[11px] text-neutral-500">
                      {c.validFrom} 至 {c.validTo}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                          isActive
                            ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                            : "text-neutral-500 bg-neutral-800 border-neutral-700"
                        }`}
                      >
                        {isActive ? "生效中" : "已停用"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="创建新优惠码"
        confirmText="保存优惠码"
        onConfirm={handleCreateCoupon}
        confirmDisabled={!newCode.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              优惠代码 (Code)
            </label>
            <input
              type="text"
              className="sb-input w-full font-mono uppercase"
              placeholder="例如: SPRING2026"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                折扣类型
              </label>
              <select
                className="sb-select w-full"
                value={newType}
                onChange={(e) => setNewType(e.target.value as any)}
              >
                <option value="percentage">百分比打折 (Percentage %)</option>
                <option value="fixed">固定满减 (Fixed USD $)</option>
              </select>
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                优惠数值
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                最低消费门槛 (USD)
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newMinSpend}
                onChange={(e) => setNewMinSpend(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                最大核销次数
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(e.target.value)}
              />
            </div>
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
