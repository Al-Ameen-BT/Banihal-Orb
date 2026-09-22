'use client';

/**
 * Type definitions for the Squid Outbound Proxy Control Plane
 * Redesigned UI/UX - Full-page proxy management
 */

// ============================================================================
// Core Enums & Constants
// ============================================================================

export type AgentStatus = 'connected' | 'degraded' | 'disconnected' | 'never-connected';
export type ConfigSyncState = 'in-sync' | 'pending-push' | 'build-error' | 'parse-error' | 'unknown';
export type AclAction = 'ALLOW' | 'DENY';
export type AclProtocol = 'HTTP' | 'HTTPS' | 'HTTP/HTTPS' | 'TCP' | 'CUSTOM';
export type DeploymentStatus = 'success' | 'failed' | 'pending' | 'rolled-back';
export type OnboardingStep = 'waiting' | 'installing' | 'handshake' | 'connected' | 'error';

// ============================================================================
// Agent & Connectivity Types
// ============================================================================

export interface ProxyAgentStatus {
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  heartbeatIntervalSec: number;
  agentVersion: string | null;
  squidVersion: string | null;
  hostOs: string | null;
  hostKernel: string | null;
  hostIp: string | null;
  pollIntervalSec: number;
  uptimeSec: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  activeConnections: number;
}

export interface ConfigSyncInfo {
  state: ConfigSyncState;
  currentRevision: number;
  appliedRevision: number;
  pendingRevision: number | null;
  lastSyncAt: string | null;
  errorMessage: string | null;
  buildLog: string | null;
}

// ============================================================================
// Telemetry & Metrics Types
// ============================================================================

export interface ProxyTelemetry {
  requestsPerSec: number;
  activeClientConnections: number;
  cacheHitPercentage: number;
  memoryCacheAllocation: {
    used: number;
    total: number;
    unit: 'MB' | 'GB';
  };
  diskCacheAllocation: {
    used: number;
    total: number;
    unit: 'MB' | 'GB';
  };
  topDestinations: TopDestination[];
  sourceClients: SourceClient[];
}

export interface TopDestination {
  domain: string;
  requestCount: number;
  transferVolume: number;
  transferVolumeUnit: 'MB' | 'GB';
  appliedRule: string | null;
}

export interface SourceClient {
  ip: string;
  requestCount: number;
  lastSeenAt: string;
  appliedRule: string | null;
}

// ============================================================================
// ACL Policy Types
// ============================================================================

export interface AclRule {
  id: string;
  priority: number;
  name: string;
  description: string;
  sourceScope: AclSourceScope;
  destinationTarget: AclDestinationTarget;
  protocolPorts: AclProtocolPorts;
  action: AclAction;
  loggingEnabled: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface AclSourceScope {
  type: 'any' | 'cidr' | 'tag' | 'domain';
  value: string; // CIDR block, tag name, or domain
  label: string; // Human-readable label
}

export interface AclDestinationTarget {
  type: 'domain-wildcard' | 'cidr' | 'category' | 'ip' | 'fqdn';
  value: string; // *.example.com, 192.168.0.0/16, social-media, etc.
  label: string;
  subTargets?: string[]; // For expanded wildcards
}

export interface AclProtocolPorts {
  protocol: AclProtocol;
  ports: number[]; // e.g., [80, 443] or [8080, 8443]
  customPortLabel?: string;
}

export interface AclDraft {
  rules: AclRule[];
  baseRevision: number;
  pendingRevision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  isDirty: boolean;
}

// ============================================================================
// Onboarding & Agent Setup Types
// ============================================================================

export interface AgentInstallInfo {
  proxyId: string;
  authToken: string;
  installCommand: string;
  onboardingStep: OnboardingStep;
  stepStartedAt: string | null;
  handshakeConnectedAt: string | null;
  errorMessage: string | null;
}

export interface AgentConfig {
  hostOs: string;
  kernel: string;
  squidVersion: string;
  agentVersion: string;
  hostIp: string;
  pollIntervalSec: number;
  lastConfigFetchAt: string | null;
}

export interface TokenInfo {
  token: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

// ============================================================================
// Audit & Deployment History Types
// ============================================================================

export interface DeploymentAuditLog {
  id: string;
  revisionId: number;
  author: string;
  authorEmail: string;
  timestamp: string;
  summary: string;
  changes: DeploymentChange[];
  status: DeploymentStatus;
  deployedAt: string | null;
  deployedBy: string | null;
  errorMessage: string | null;
  squidOutput: string | null;
}

export interface DeploymentChange {
  type: 'added' | 'removed' | 'modified' | 'reordered';
  ruleId: string;
  ruleName: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

// ============================================================================
// Proxy Instance Types
// ============================================================================

export interface ProxyInstance {
  id: string;
  name: string;
  tag: string; // Region/Environment tag
  hostIdentifier: string; // e.g., "prod-web-01" or "vpc-12345"
  description: string | null;
  status: 'active' | 'inactive' | 'maintenance' | 'decommissioned';
  createdAt: string;
  updatedAt: string;
  agentStatus: ProxyAgentStatus;
  configSync: ConfigSyncInfo;
  telemetry: ProxyTelemetry | null;
  aclDraft: AclDraft | null;
  aclPublished: AclRule[];
  onboarding: AgentInstallInfo | null;
  agentConfig: AgentConfig | null;
  tokens: TokenInfo[];
  auditLogs: DeploymentAuditLog[];
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateProxyRequest {
  name: string;
  tag: string;
  hostIdentifier: string;
  description?: string;
}

export interface UpdateProxyRequest {
  name?: string;
  tag?: string;
  hostIdentifier?: string;
  description?: string;
  status?: ProxyInstance['status'];
}

export interface CreateAclRuleRequest {
  name: string;
  description: string;
  sourceScope: AclSourceScope;
  destinationTarget: AclDestinationTarget;
  protocolPorts: AclProtocolPorts;
  action: AclAction;
  loggingEnabled: boolean;
  enabled: boolean;
}

export interface UpdateAclRuleRequest extends Partial<CreateAclRuleRequest> {
  priority?: number;
}

export interface ReorderAclRulesRequest {
  ruleIds: string[]; // New order of rule IDs
}

export interface DeployAclRequest {
  revision: number;
  force?: boolean;
}

export interface RegenerateTokenRequest {
  expiresInDays?: number;
}

// ============================================================================
// Validation Helpers
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// ============================================================================
// UI State Types
// ============================================================================

export type ProxyTab = 'overview' | 'access-rules' | 'agent-setup' | 'audit-history';

export interface ProxyPageState {
  activeTab: ProxyTab;
  aclDraft: AclDraft | null;
  showRuleDrawer: boolean;
  editingRule: AclRule | null;
  showDeployBanner: boolean;
  pendingDeployCount: number;
  onboardingStep: OnboardingStep;
  validationErrors: Record<string, ValidationError>;
}