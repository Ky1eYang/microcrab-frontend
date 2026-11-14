import React from "react";
import { useApp } from "../../../../state";

export const AuditLogView: React.FC = () => {
  const { state } = useApp();
  const board = state.board;

  // Real audit rows from `/api/admin/v1/audit/logs`
  const realAudit = board.audit || [];
  const hasRealAudit = realAudit.length > 0;

  // High-fidelity fallback audit events
  const fallbackAudit = [
    {
      id: "aud_01JM5ABT990001",
      action: "API_KEY_REVOKE",
      target: "key_01JM5A7C93V65E",
      operatorKeyId: "sk-sbclaw-adm-master",
      timestamp: "2026-10-20 14:32:10",
      ip: "192.168.1.10",
      status: "SUCCESS",
    },
    {
      id: "aud_01JM5ABT990002",
      action: "QUOTA_UPDATE",
      target: "usr_01JM5A8D12F98C (Alex Morgan)",
      operatorKeyId: "sk-sbclaw-adm-master",
      timestamp: "2026-10-20 13:15:00",
      ip: "192.168.1.10",
      status: "SUCCESS",
    },
    {
      id: "aud_01JM5ABT990003",
      action: "CHANNEL_UPDATE",
      target: "Anthropic-Main",
      operatorKeyId: "sk-sbclaw-adm-master",
      timestamp: "2026-10-20 11:04:22",
      ip: "192.168.1.15",
      status: "SUCCESS",
    },
    {
      id: "aud_01JM5ABT990004",
      action: "SESSION_PURGE",
      target: "sess_01JM5A9E45G12H",
      operatorKeyId: "sk-sbclaw-adm-dev",
      timestamp: "2026-10-20 09:20:18",
      ip: "10.0.4.88",
      status: "SUCCESS",
    },
  ];

  const displayList = hasRealAudit ? realAudit : fallbackAudit;

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            操作审计日志 (Admin Audit Logs)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            超级管理员与运营动作全链路溯源（删除会话、修改配额、吊销特权密钥）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-neutral-500 font-mono">
            {hasRealAudit
              ? "已连接后端实时审计库"
              : "Mock 数据就绪 (等待后端记录产生)"}
          </span>
        </div>
      </div>

      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">操作类型 (Action)</th>
                <th className="py-3 px-4">操作目标 (Target)</th>
                <th className="py-3 px-4">操作者身份 / 密钥</th>
                <th className="py-3 px-4">时间</th>
                <th className="py-3 px-4 text-right">执行结果</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {displayList.map((row: any, idx: number) => {
                const actionText = row.action || "OPERATION";
                const isSuccess = (row.status || "SUCCESS") === "SUCCESS";
                return (
                  <tr
                    key={row.id || idx}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4 font-bold text-neutral-200">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-dash-terminal text-neutral-300 border border-dash-line">
                        {actionText}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-neutral-300 font-sans max-w-[240px] truncate">
                      {row.target || "-"}
                    </td>
                    <td className="py-3 px-4 text-neutral-400">
                      <span className="text-neutral-300">
                        {row.operatorKeyId || row.operator || "system"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-neutral-500 text-[11px]">
                      {row.timestamp || row.createdAt || "刚刚"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${
                          isSuccess
                            ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
                            : "text-rose-400 bg-rose-500/10 border border-rose-500/20"
                        }`}
                      >
                        {isSuccess ? "成功" : "失败"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
