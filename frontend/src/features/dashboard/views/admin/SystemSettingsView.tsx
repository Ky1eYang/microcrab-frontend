import React, { useState } from "react";
import type { SystemSettings } from "../../types";
import { mockSystemSettings } from "../../mockData";

export const SystemSettingsView: React.FC = () => {
  const [settings, setSettings] = useState<SystemSettings>(mockSystemSettings);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    showToast("网关全局系统配置已成功保存并立即生效");
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            系统全局设置 (System Settings)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置网关服务端口、站点标题、Prompt Caching
            窗口、计费乘数与默认路由策略
          </p>
        </div>
      </div>

      {toastMessage && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{toastMessage}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        {/* Basic Configuration */}
        <div className="sb-card p-4 md:p-5 space-y-4">
          <h3 className="text-xs font-semibold text-neutral-200">
            基础服务与路由配置
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                站点标题
              </label>
              <input
                type="text"
                className="sb-input w-full"
                value={settings.siteTitle}
                onChange={(e) =>
                  setSettings({ ...settings, siteTitle: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                网关监听端口
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={settings.gatewayPort}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    gatewayPort: parseInt(e.target.value, 10) || 8080,
                  })
                }
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                默认主选模型
              </label>
              <input
                type="text"
                className="sb-input w-full font-mono"
                value={settings.defaultModel}
                onChange={(e) =>
                  setSettings({ ...settings, defaultModel: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                容灾降级模型 (Fallback)
              </label>
              <input
                type="text"
                className="sb-input w-full font-mono"
                value={settings.fallbackModel}
                onChange={(e) =>
                  setSettings({ ...settings, fallbackModel: e.target.value })
                }
              />
            </div>
          </div>
        </div>

        {/* Cache & Billing Configuration */}
        <div className="sb-card p-4 md:p-5 space-y-4">
          <h3 className="text-xs font-semibold text-neutral-200">
            缓存优化与计费配置
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                缓存 TTL 窗口 (分钟)
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={settings.cacheTtlMinutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    cacheTtlMinutes: parseInt(e.target.value, 10) || 5,
                  })
                }
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                计费率乘数 (Multiplier)
              </label>
              <input
                type="number"
                step="0.05"
                className="sb-input w-full font-mono"
                value={settings.billingRateMultiplier}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    billingRateMultiplier: parseFloat(e.target.value) || 1.0,
                  })
                }
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                日志保留天数
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={settings.logRetentionDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    logRetentionDays: parseInt(e.target.value, 10) || 30,
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* Security Switches */}
        <div className="sb-card p-4 md:p-5 space-y-3">
          <h3 className="text-xs font-semibold text-neutral-200">
            运行模式与安全开关
          </h3>
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between py-2 border-b border-dash-line">
              <div>
                <div className="text-neutral-200 font-medium">
                  公开注册 (Public Registration)
                </div>
                <div className="text-neutral-500 text-[11px]">
                  允许用户通过登录页自主注册账号
                </div>
              </div>
              <label className="sb-switch">
                <input
                  type="checkbox"
                  checked={settings.allowPublicRegistration}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      allowPublicRegistration: e.target.checked,
                    })
                  }
                />
                <span className="sb-switch-slider" />
              </label>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-dash-line">
              <div>
                <div className="text-neutral-200 font-medium">
                  强制 IP 白名单过滤
                </div>
                <div className="text-neutral-500 text-[11px]">
                  仅允许在 IP 管理中显式登记的地址发起请求
                </div>
              </div>
              <label className="sb-switch">
                <input
                  type="checkbox"
                  checked={settings.enforceIpWhitelist}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      enforceIpWhitelist: e.target.checked,
                    })
                  }
                />
                <span className="sb-switch-slider" />
              </label>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-neutral-200 font-medium">
                  系统维护模式 (Maintenance Mode)
                </div>
                <div className="text-neutral-500 text-[11px]">
                  非管理员访问将提示维护页面并暂停推理请求
                </div>
              </div>
              <label className="sb-switch">
                <input
                  type="checkbox"
                  checked={settings.maintenanceMode}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      maintenanceMode: e.target.checked,
                    })
                  }
                />
                <span className="sb-switch-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <button type="submit" className="sb-btn sb-btn-primary">
            保存配置生效
          </button>
        </div>
      </form>
    </div>
  );
};
