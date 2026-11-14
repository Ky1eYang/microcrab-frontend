/**
 * Dashboard & Admin Data Type Contracts (sbclaw v0.3.14)
 * Comprehensive typing for all user metrics, gateway telemetry, and admin management modules.
 */

// ============================================================================
// 1. Time & Metric Enums
// ============================================================================

export type TimeRange = "24h" | "7d" | "30d";

export type Granularity = "hour" | "day" | "week";

export type ModelMetricMode = "token" | "cost";

// ============================================================================
// 2. Overview & KPI Types
// ============================================================================

export interface KpiSummary {
  /** Available user balance in USD */
  balanceUsd: number;
  balanceStatus: string;

  /** API Key counts */
  activeKeys: number;
  totalKeys: number;

  /** Request volume */
  todayRequests: number;
  totalRequests: number;

  /** Financial spend (Actual paid vs Standard uncached pricing) */
  todayActualCost: number;
  todayStdCost: number;
  totalActualCost: number;
  totalStdCost: number;

  /** Token telemetry */
  todayTokens: string; // Formatted e.g. "135.1M"
  todayTokensValue: number;
  todayInputTokens: string;
  todayOutputTokens: string;
  todayCacheTokens: string;
  totalTokens: string;
  totalTokensValue: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheTokens: string;

  /** Realtime throughput & latency */
  rpm: number;
  tpm: string;
  avgLatency: string;
  latencyUnit?: string;
}

export interface PlatformStats {
  platform: "Claude" | "OpenAI" | "Grok" | string;
  totalCost: number;
  todayCost: number;
  requests: number;
  tokens: string;
  tokenVal?: number;
  activeModelsCount?: number;
}

export interface ModelDistribution {
  model: string;
  platform: "Claude" | "OpenAI" | "Grok" | string;
  req: number;
  tokenStr: string;
  tokenVal: number; // In millions (M) for proportional chart calculation
  actual: string; // Formatted e.g. "$68.5498"
  actualVal: number;
  std: string; // Formatted e.g. "$431.7026"
  stdVal: number;
  color: string;
}

// ============================================================================
// 3. Trends & Timeseries
// ============================================================================

export interface TrendPoint {
  label: string; // e.g. "04:00" or "2026-10-14"
  input: number; // in M tokens
  output: number; // in M tokens
  cacheCreate: number; // in M tokens
  cacheRead: number; // in M tokens
  hitRate: number; // in percentage 0 - 100
}

export interface RangeDataset {
  rangeText: string;
  kpi: KpiSummary;
  points: TrendPoint[];
}

// ============================================================================
// 4. Cache Telemetry & Diagnostics
// ============================================================================

export interface CacheModelDetail {
  model: string;
  totalInput: string;
  cacheRead: string;
  cacheWrite: string;
  hitRate: number; // e.g. 96.4
  savedCost: number; // e.g. 363.1528
}

export interface CacheRootCause {
  id: string;
  title: string;
  status: string;
  statusColor?: string;
  desc: string;
}

export interface CacheStats {
  todayHitRate: number;
  todayHitTokens: string;
  todayTotalTokens: string;
  totalHitRate: number;
  totalHitTokens: string;
  totalTotalTokens: string;
  todaySavedCost: number;
  todayActualCost: number;
  todayStdCost: number;
  totalSavedCost: number;
  totalActualCost: number;
  totalStdCost: number;
  modelBreakdown: CacheModelDetail[];
  rootCauses: CacheRootCause[];
}

// ============================================================================
// 5. Detailed Invocation Logs & Inspector
// ============================================================================

export type CacheCategory = "HIGH" | "MED" | "LOW" | "MISS" | "WRITE";

export interface CallLog {
  id: string;
  time: string;
  platform: string;
  model: string;
  keyName: string;
  statusCode: number; // 200 | 429 | 500

  // 3-Color Token Breakdown (Cache Read, Uncached In, Output)
  inputUncached: number;
  cacheRead: number;
  cacheCreate?: number;
  output: number;
  totalTokens?: number;

  hitRate: number;
  cacheCategory: CacheCategory;

  actualCost: number;
  stdCost: number;

  duration: string; // e.g. "10.8s"
  durationMs?: number;
  ttft: string; // Time-to-First-Token e.g. "0.68s"
  tps: string; // Tokens per second e.g. "44.5"

  argsJson: Record<string, unknown> | string;
  outputJson: Record<string, unknown> | string;
}

// ============================================================================
// 6. Plugins Ecosystem
// ============================================================================

export interface PluginItem {
  id: string;
  name: string;
  author: string;
  version: string;
  desc: string;
  enabled: boolean;
  category: string;
  icon?: string;
  downloads?: number;
  rating?: number;
}

// ============================================================================
// 7. Admin Ops & Monitoring
// ============================================================================

export interface CircuitBreakerStatus {
  channel: string;
  status: "closed" | "open" | "half-open";
  failedPings: number;
  lastFailureTime?: string;
}

export interface OpsMetricsPoint {
  time: string;
  qps: number;
  latencyMs: number;
  errorRate: number; // percentage e.g. 0.02
}

export interface OpsMetrics {
  qps: number;
  activeConnections: number;
  uptimeSeconds: number;
  cpuUsagePercent: number;
  memoryUsageMb: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  circuitBreakers: CircuitBreakerStatus[];
  historySeries: OpsMetricsPoint[];
}

// ============================================================================
// 8. Admin Gateway Channels
// ============================================================================

export type ChannelStatus = "healthy" | "degraded" | "down" | "disabled";

export interface ChannelItem {
  id: string;
  name: string;
  provider: "OpenAI" | "Anthropic" | "Grok" | "Azure" | "Cloudflare" | string;
  baseUrl: string;
  models: string[];
  weight: number;
  priority: number;
  latencyMs: number;
  status: ChannelStatus;
  enabled: boolean;
  balance?: number;
  lastCheckedAt: string;
}

// ============================================================================
// 9. Admin Users & Tenant Groups
// ============================================================================

export type UserRole = "super_admin" | "admin" | "user";
export type UserStatus = "active" | "suspended" | "pending";

export interface UserItem {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  quotaLimitUsd: number;
  quotaUsedUsd: number;
  balanceUsd: number;
  group: string;
  activeKeysCount: number;
  createdAt: string;
  lastLoginAt: string;
}

export interface GroupItem {
  id: string;
  name: string;
  desc: string;
  rpmLimit: number;
  tpmLimit: number;
  dailyQuotaUsd: number;
  allowedChannels: string[];
  modelRateMultipliers: Record<string, number>;
  userCount: number;
  isDefault?: boolean;
}

// ============================================================================
// 10. Commercialization (Plans, Redeems, Coupons)
// ============================================================================

export type PlanTier = "free" | "pro" | "team" | "enterprise";

export interface SubscriptionPlan {
  id: string;
  name: string;
  tier: PlanTier;
  priceMonthly: number;
  priceYearly: number;
  monthlyTokenQuota: string;
  rpmLimit: number;
  tpmLimit: number;
  features: string[];
  activeSubscribers: number;
  status: "active" | "deprecated";
}

export type AccountProvider = "github" | "google" | "oidc" | "credentials";

export interface AccountItem {
  id: string;
  provider: AccountProvider;
  identityId: string;
  email: string;
  boundUser: string;
  credentialPoolRef?: string;
  status: "linked" | "unlinked" | "error";
  createdAt: string;
}

export interface NoticeItem {
  id: string;
  title: string;
  contentMarkdown: string;
  level: "info" | "warning" | "alert" | "maintenance";
  active: boolean;
  targetAudience: "all" | "admins" | "users";
  publishedAt: string;
  expiresAt?: string;
}

export interface IpRuleItem {
  id: string;
  ipOrCidr: string;
  type: "allow" | "deny";
  reason: string;
  hitsCount: number;
  lastHitAt?: string;
  createdAt: string;
  enabled: boolean;
}

export type RedeemStatus = "unused" | "redeemed" | "expired" | "revoked";

export interface RedeemCodeItem {
  id: string;
  code: string;
  batchId: string;
  amountUsd: number;
  status: RedeemStatus;
  redeemedBy?: string;
  redeemedAt?: string;
  expiresAt: string;
  createdAt: string;
}

export type CouponStatus = "active" | "expired" | "exhausted" | "disabled";

export interface CouponItem {
  id: string;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  minSpendUsd: number;
  maxUses: number;
  usedCount: number;
  validFrom: string;
  validTo: string;
  status: CouponStatus;
}

// ============================================================================
// 11. System Global Settings
// ============================================================================

export interface SystemSettings {
  siteTitle: string;
  gatewayPort: number;
  defaultModel: string;
  fallbackModel: string;
  cacheTtlMinutes: number;
  billingRateMultiplier: number;
  maxRequestPayloadMb: number;
  logRetentionDays: number;
  allowPublicRegistration: boolean;
  maintenanceMode: boolean;
  enforceIpWhitelist: boolean;
}

// ============================================================================
// 12. API Key Entity
// ============================================================================

export interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  platform: string;
  tokens: string;
  hitRate: string;
  spent: number;
  limit: number;
  active: boolean;
  createdAt?: string;
}
