'use client';

/**
 * Client-side validation utilities for Squid Proxy ACL inputs
 */

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  warning?: boolean;
}

// ============================================================================
// Domain & Wildcard Validation
// ============================================================================

export const DOMAIN_WILDCARD_REGEX = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
export const FQDN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export function validateDomainWildcard(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const trimmed = value.trim();

  if (!trimmed) {
    errors.push({ field: 'domain', message: 'Domain is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  // Check for wildcard pattern (*.example.com)
  if (trimmed.startsWith('*.')) {
    const domainPart = trimmed.slice(2);
    if (!FQDN_REGEX.test(domainPart)) {
      errors.push({ field: 'domain', message: 'Invalid domain format after wildcard', code: 'INVALID_DOMAIN' });
    }
  } else if (!FQDN_REGEX.test(trimmed)) {
    errors.push({ field: 'domain', message: 'Invalid domain format', code: 'INVALID_DOMAIN' });
  }

  if (trimmed.length > 255) {
    errors.push({ field: 'domain', message: 'Domain must be 255 characters or less', code: 'TOO_LONG' });
  }

  return { valid: errors.length === 0, errors };
}

export function validateDomainList(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const domains = value.split(',').map(d => d.trim()).filter(Boolean);

  if (domains.length === 0) {
    errors.push({ field: 'domains', message: 'At least one domain is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  domains.forEach((domain, index) => {
    const result = validateDomainWildcard(domain);
    if (!result.valid) {
      errors.push({
        field: `domains[${index}]`,
        message: result.errors[0]?.message || 'Invalid domain',
        code: result.errors[0]?.code || 'INVALID_DOMAIN'
      });
    }
  });

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// CIDR Validation
// ============================================================================

export const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export function validateCidr(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const trimmed = value.trim();

  if (!trimmed) {
    errors.push({ field: 'cidr', message: 'CIDR is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  if (!CIDR_REGEX.test(trimmed)) {
    errors.push({ field: 'cidr', message: 'Invalid CIDR format (e.g., 192.168.1.0/24)', code: 'INVALID_CIDR' });
    return { valid: false, errors };
  }

  const [ip, prefixStr] = trimmed.split('/');
  const prefix = parseInt(prefixStr, 10);
  const octets = ip.split('.').map(Number);

  if (octets.some(o => o < 0 || o > 255)) {
    errors.push({ field: 'cidr', message: 'Invalid IP address in CIDR', code: 'INVALID_IP' });
  }

  if (prefix < 0 || prefix > 32) {
    errors.push({ field: 'cidr', message: 'CIDR prefix must be between 0 and 32', code: 'INVALID_PREFIX' });
  }

  // Validate network address (host bits should be 0)
  if (prefix < 32) {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const ipNum = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
    if ((ipNum & ~mask) !== 0) {
      errors.push({ field: 'cidr', message: 'Host bits must be zero for network address', code: 'INVALID_NETWORK_ADDRESS' });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateCidrList(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const cidrs = value.split(',').map(c => c.trim()).filter(Boolean);

  if (cidrs.length === 0) {
    errors.push({ field: 'cidrs', message: 'At least one CIDR is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  cidrs.forEach((cidr, index) => {
    const result = validateCidr(cidr);
    if (!result.valid) {
      errors.push({
        field: `cidrs[${index}]`,
        message: result.errors[0]?.message || 'Invalid CIDR',
        code: result.errors[0]?.code || 'INVALID_CIDR'
      });
    }
  });

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Port Validation
// ============================================================================

export function validatePort(value: string | number): ValidationResult {
  const errors: ValidationError[] = [];
  const num = typeof value === 'string' ? parseInt(value, 10) : value;

  if (isNaN(num)) {
    errors.push({ field: 'port', message: 'Port must be a number', code: 'NOT_A_NUMBER' });
    return { valid: false, errors };
  }

  if (num < 1 || num > 65535) {
    errors.push({ field: 'port', message: 'Port must be between 1 and 65535', code: 'OUT_OF_RANGE' });
  }

  // Warn about privileged ports
  if (num < 1024) {
    errors.push({ field: 'port', message: 'Ports below 1024 require root privileges', code: 'PRIVILEGED_PORT', warning: true });
  }

  return { valid: errors.filter(e => !e.warning).length === 0, errors };
}

export function validatePortList(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const ports = value.split(',').map(p => p.trim()).filter(Boolean);

  if (ports.length === 0) {
    errors.push({ field: 'ports', message: 'At least one port is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  const seen = new Set<number>();
  ports.forEach((portStr, index) => {
    const result = validatePort(portStr);
    if (!result.valid) {
      errors.push({
        field: `ports[${index}]`,
        message: result.errors[0]?.message || 'Invalid port',
        code: result.errors[0]?.code || 'INVALID_PORT'
      });
    } else {
      const num = parseInt(portStr, 10);
      if (seen.has(num)) {
        errors.push({ field: `ports[${index}]`, message: 'Duplicate port', code: 'DUPLICATE_PORT' });
      }
      seen.add(num);
    }
  });

  return { valid: errors.filter(e => !e.warning).length === 0, errors };
}

// ============================================================================
// Tag Validation
// ============================================================================

export const TAG_REGEX = /^[a-zA-Z0-9-_]{1,64}$/;

export function validateTag(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const trimmed = value.trim();

  if (!trimmed) {
    errors.push({ field: 'tag', message: 'Tag is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  if (!TAG_REGEX.test(trimmed)) {
    errors.push({
      field: 'tag',
      message: 'Tag must be alphanumeric with hyphens/underscores only (1-64 chars)',
      code: 'INVALID_TAG'
    });
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Rule Name Validation
// ============================================================================

export function validateRuleName(value: string): ValidationResult {
  const errors: ValidationError[] = [];
  const trimmed = value.trim();

  if (!trimmed) {
    errors.push({ field: 'name', message: 'Rule name is required', code: 'REQUIRED' });
    return { valid: false, errors };
  }

  if (trimmed.length < 2) {
    errors.push({ field: 'name', message: 'Rule name must be at least 2 characters', code: 'TOO_SHORT' });
  }

  if (trimmed.length > 128) {
    errors.push({ field: 'name', message: 'Rule name must be 128 characters or less', code: 'TOO_LONG' });
  }

  // Check for invalid characters
  if (!/^[a-zA-Z0-9\s\-_\.]+$/.test(trimmed)) {
    errors.push({ field: 'name', message: 'Rule name can only contain letters, numbers, spaces, hyphens, underscores, and periods', code: 'INVALID_CHARS' });
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Comprehensive ACL Rule Validation
// ============================================================================

import type { AclSourceScope, AclDestinationTarget, AclProtocolPorts, AclAction } from '@/types/squid-proxy';

export interface AclRuleFormData {
  name: string;
  description: string;
  sourceScope: AclSourceScope;
  destinationTarget: AclDestinationTarget;
  protocolPorts: AclProtocolPorts;
  action: AclAction;
  loggingEnabled: boolean;
  enabled: boolean;
}

export function validateAclRule(data: AclRuleFormData): ValidationResult {
  const errors: ValidationError[] = [];

  // Name
  const nameResult = validateRuleName(data.name);
  errors.push(...nameResult.errors.map(e => ({ ...e, field: `name.${e.field}` })));

  // Source scope
  if (!data.sourceScope?.type) {
    errors.push({ field: 'sourceScope.type', message: 'Source type is required', code: 'REQUIRED' });
  } else if (!data.sourceScope?.value?.trim()) {
    errors.push({ field: 'sourceScope.value', message: 'Source value is required', code: 'REQUIRED' });
  } else if (data.sourceScope.type === 'cidr') {
    const cidrResult = validateCidr(data.sourceScope.value);
    errors.push(...cidrResult.errors.map(e => ({ ...e, field: `sourceScope.${e.field}` })));
  } else if (data.sourceScope.type === 'domain') {
    const domainResult = validateDomainWildcard(data.sourceScope.value);
    errors.push(...domainResult.errors.map(e => ({ ...e, field: `sourceScope.${e.field}` })));
  } else if (data.sourceScope.type === 'tag') {
    const tagResult = validateTag(data.sourceScope.value);
    errors.push(...tagResult.errors.map(e => ({ ...e, field: `sourceScope.${e.field}` })));
  }

  // Destination target
  if (!data.destinationTarget?.type) {
    errors.push({ field: 'destinationTarget.type', message: 'Destination type is required', code: 'REQUIRED' });
  } else if (!data.destinationTarget?.value?.trim()) {
    errors.push({ field: 'destinationTarget.value', message: 'Destination value is required', code: 'REQUIRED' });
  } else {
    switch (data.destinationTarget.type) {
      case 'domain-wildcard':
      case 'fqdn':
        const domainResult = validateDomainWildcard(data.destinationTarget.value);
        errors.push(...domainResult.errors.map(e => ({ ...e, field: `destinationTarget.${e.field}` })));
        break;
      case 'cidr':
        const cidrResult = validateCidr(data.destinationTarget.value);
        errors.push(...cidrResult.errors.map(e => ({ ...e, field: `destinationTarget.${e.field}` })));
        break;
      case 'ip':
        // Basic IP validation
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(data.destinationTarget.value)) {
          errors.push({ field: 'destinationTarget.value', message: 'Invalid IP address format', code: 'INVALID_IP' });
        }
        break;
    }
  }

  // Protocol & ports
  if (!data.protocolPorts?.ports || data.protocolPorts.ports.length === 0) {
    errors.push({ field: 'protocolPorts.ports', message: 'At least one port is required', code: 'REQUIRED' });
  } else {
    const portResult = validatePortList(data.protocolPorts.ports.join(','));
    errors.push(...portResult.errors.map(e => ({ ...e, field: `protocolPorts.${e.field}` })));
  }

  // Action
  if (!data.action || !['ALLOW', 'DENY'].includes(data.action)) {
    errors.push({ field: 'action', message: 'Action must be ALLOW or DENY', code: 'INVALID_ACTION' });
  }

  return { valid: errors.filter(e => !e.warning).length === 0, errors };
}

// ============================================================================
// Helper: Get first error message for a field
// ============================================================================

export function getFieldError(errors: ValidationError[], field: string): string | undefined {
  return errors.find(e => e.field === field || e.field.startsWith(`${field}.`))?.message;
}

export function hasFieldError(errors: ValidationError[], field: string): boolean {
  return errors.some(e => e.field === field || e.field.startsWith(`${field}.`));
}

// ============================================================================
// Constants for UI components
// ============================================================================

export const PROTOCOL_OPTIONS = [
  { value: 'HTTP/HTTPS', label: 'HTTP/HTTPS (80, 443)', ports: [80, 443] },
  { value: 'HTTPS', label: 'HTTPS Only (443)', ports: [443] },
  { value: 'HTTP', label: 'HTTP Only (80)', ports: [80] },
  { value: 'CUSTOM', label: 'Custom Ports', ports: [] },
] as const;

export const CATEGORIES = [
  'social-media', 'gambling', 'adult', 'streaming', 'gaming',
  'file-sharing', 'malware', 'phishing', 'proxy-vpn', 'ads-tracking',
  'crypto-mining', 'weapons', 'violence', 'hate-speech'
] as const;