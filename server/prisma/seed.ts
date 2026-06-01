import 'dotenv/config';
import { PrismaClient, type ServiceStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (pw: string) => bcrypt.hash(pw, 12);

// ─── Cybersecurity service catalog (name → monthly price USD) ───────────────
const SERVICE_CATALOG: Record<string, { price: number; description: string }> = {
  'SIEM':                    { price: 8000,  description: 'Security Information & Event Management with ML correlation' },
  'SOC-as-a-Service':        { price: 15000, description: '24/7 managed Security Operations Center coverage' },
  'EDR':                     { price: 4000,  description: 'Endpoint Detection & Response with behavioral analysis' },
  'Threat Intel':            { price: 2500,  description: 'Real-time threat intelligence feed + IOC enrichment' },
  'Vulnerability Mgmt':      { price: 3000,  description: 'Continuous vulnerability scanning + remediation guidance' },
  'Zero Trust':              { price: 5000,  description: 'Zero Trust Network Access with conditional policies' },
  'DLP':                     { price: 3500,  description: 'Data Loss Prevention with PII/PCI/PHI detection' },
  'Cloud Security':          { price: 4500,  description: 'CSPM + CWPP across AWS, Azure, GCP workloads' },
  'Compliance Monitoring':   { price: 2000,  description: 'SOC 2, HIPAA, PCI-DSS, GDPR continuous compliance' },
  'Incident Response':       { price: 6000,  description: '4-hour IR SLA with forensics and containment' },
  'Penetration Testing':     { price: 4000,  description: 'Quarterly external + internal penetration testing' },
  'Deception Technology':    { price: 3500,  description: 'Honeypot grid for adversary detection' },
};

// Plan → base monthly credit limit
const CREDIT_LIMITS: Record<string, number> = { FREE: 500, PRO: 5000, ENTERPRISE: 25000 };

const now = new Date();
const daysFromNow = (d: number) => new Date(now.getTime() + d * 86400_000);
const daysAgo     = (d: number) => new Date(now.getTime() - d * 86400_000);
const hoursAgo    = (h: number) => new Date(now.getTime() - h * 3600_000);

/**
 * Derive ServiceStatus from renewal date.
 * - past renewal → EXPIRED
 * - <30 days     → EXPIRING
 * - else         → ACTIVE
 */
function statusFromRenewal(renewsAt: Date, override?: ServiceStatus): ServiceStatus {
  if (override) return override;
  const days = (renewsAt.getTime() - now.getTime()) / 86400_000;
  if (days < 0) return 'EXPIRED';
  if (days < 30) return 'EXPIRING';
  return 'ACTIVE';
}

async function createService(
  organizationId: string,
  name: keyof typeof SERVICE_CATALOG | string,
  renewsAt: Date,
  opts: { enabled?: boolean; status?: ServiceStatus; purchasedDaysAgo?: number } = {},
) {
  const cat = SERVICE_CATALOG[name];
  if (!cat) throw new Error(`Unknown service: ${name}`);
  return prisma.organizationService.create({
    data: {
      organizationId,
      name,
      description: cat.description,
      monthlyPrice: cat.price,
      purchasedAt: daysAgo(opts.purchasedDaysAgo ?? 365),
      renewsAt,
      status: statusFromRenewal(renewsAt, opts.status),
      enabled: opts.enabled ?? true,
      lastBilledAt: daysAgo(15),
    },
  });
}

async function main() {
  console.log('🌱 Seeding Tech cybersecurity platform…\n');

  // ─── Clean slate (force-reset already wiped, but be defensive) ─────────────
  await prisma.organizationService.deleteMany();
  await prisma.serviceRequest.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.apiUsage.deleteMany();
  await prisma.orgFeatureFlag.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
  console.log('🧹 Cleared existing data\n');

  // ─── Global Feature Flags ──────────────────────────────────────────────────
  await prisma.featureFlag.createMany({
    data: [
      { key: 'ai_threat_analysis',      value: true,  description: 'AI-powered threat pattern analysis (GPT-4o)' },
      { key: 'auto_incident_response',  value: false, description: 'Automated playbook execution on P1 incidents' },
      { key: 'deception_grid',          value: false, description: 'Deception technology honeypot deployment' },
      { key: 'threat_sharing_isac',     value: true,  description: 'Real-time IOC sharing via FS-ISAC / H-ISAC' },
      { key: 'zero_trust_beta',         value: true,  description: 'Next-gen Zero Trust Network Access v2.0 (beta)' },
      { key: 'siem_ml_correlation',     value: true,  description: 'ML-based SIEM event correlation engine' },
      { key: 'pentest_on_demand',       value: false, description: 'On-demand penetration testing scheduling' },
      { key: 'executive_risk_report',   value: true,  description: 'Auto-generated weekly executive risk briefings' },
    ],
  });
  console.log('🚩 Created 8 global feature flags');

  // ─── Tech (internal SaaS admin org) ────────────────────────────────────────
  const techOrg = await prisma.organization.create({
    data: {
      name: 'Tech', slug: 'tech-internal', plan: 'ENTERPRISE',
      industry: 'Cybersecurity', contractValue: 0, healthScore: 100, csm: 'Internal',
      creditLimit: 99999, ssoEnabled: true, mfaRequired: true,
    },
  });
  const saasAdmin = await prisma.user.create({
    data: {
      name: 'Alex Chen', email: 'admin@platform.com',
      passwordHash: await hash('SaasAdmin1!'),
      role: 'SAAS_ADMIN', mfaEnabled: true,
      organizationId: techOrg.id, lastLoginAt: now,
    },
  });
  console.log(`✅ Tech (internal)  →  ${saasAdmin.email}  [SAAS_ADMIN]\n`);

  // ─── Helper: seed API usage history for last N months ──────────────────────
  async function seedUsage(orgId: string, base: number, variance: number, months = 6) {
    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      await prisma.apiUsage.create({
        data: {
          organizationId: orgId,
          creditsUsed: Math.max(0, base + Math.floor((Math.random() - 0.4) * variance)),
          periodStart: start, periodEnd: end,
        },
      });
    }
  }

  // ─── Spec for each client org ──────────────────────────────────────────────
  type OrgSpec = {
    name: string; slug: string; industry: string; plan: 'FREE' | 'PRO' | 'ENTERPRISE';
    contractValue: number; healthScore: number; csm: string;
    sso: boolean; mfa: boolean;
    adminName: string; adminEmail: string;
    users: Array<{ name: string; email: string; mfa?: boolean }>;
    usage: { base: number; variance: number };
    // Each service includes its renewal in days from now (negative = expired) and optional status override
    services: Array<{ name: keyof typeof SERVICE_CATALOG; renewsIn: number; enabled?: boolean; status?: ServiceStatus }>;
  };

  const orgSpecs: OrgSpec[] = [
    {
      name: 'DataVault Banking', slug: 'datavault-banking', industry: 'Banking', plan: 'ENTERPRISE',
      contractValue: 210000, healthScore: 98, csm: 'Sarah Chen', sso: true, mfa: true,
      adminName: 'James Whitfield', adminEmail: 'jwhitfield@datavault.com',
      users: [
        { name: 'Kevin Okafor', email: 'kokafor@datavault.com', mfa: true },
        { name: 'Laura Metz',   email: 'lmetz@datavault.com',   mfa: true },
        { name: 'Omar Hassan',  email: 'ohassan@datavault.com', mfa: true },
      ],
      usage: { base: 21000, variance: 5000 },
      services: [
        { name: 'SIEM',                 renewsIn: 188 },
        { name: 'SOC-as-a-Service',     renewsIn: 188 },
        { name: 'EDR',                  renewsIn: 92 },
        { name: 'Zero Trust',           renewsIn: 41 },
        { name: 'DLP',                  renewsIn: 14 },              // EXPIRING soon
        { name: 'Threat Intel',         renewsIn: 220 },
        { name: 'Incident Response',    renewsIn: 365 },
      ],
    },
    {
      name: 'Orbital Aerospace', slug: 'orbital-aerospace', industry: 'Aerospace & Defense', plan: 'ENTERPRISE',
      contractValue: 180000, healthScore: 92, csm: 'Marcus Webb', sso: true, mfa: true,
      adminName: 'Rachel Torres', adminEmail: 'rtorres@orbital.aero',
      users: [
        { name: 'SOC Analyst 1', email: 'analyst1@orbital.aero', mfa: true },
        { name: 'SOC Analyst 2', email: 'analyst2@orbital.aero', mfa: true },
        { name: 'SOC Analyst 3', email: 'analyst3@orbital.aero', mfa: true },
      ],
      usage: { base: 18000, variance: 4000 },
      services: [
        { name: 'SIEM',                renewsIn: 140 },
        { name: 'EDR',                 renewsIn: 88 },
        { name: 'Zero Trust',          renewsIn: 22 },               // EXPIRING
        { name: 'Threat Intel',        renewsIn: 250 },
        { name: 'Incident Response',   renewsIn: 300 },
        { name: 'Deception Technology',renewsIn: 175 },
      ],
    },
    {
      name: 'CityGrid Power', slug: 'citygrid-power', industry: 'Energy & Utilities', plan: 'ENTERPRISE',
      contractValue: 145000, healthScore: 88, csm: 'Sarah Chen', sso: true, mfa: true,
      adminName: 'Marcus Bell', adminEmail: 'mbell@citygrid.io',
      users: [
        { name: 'OT Security Eng 1', email: 'ot1@citygrid.io', mfa: true },
        { name: 'OT Security Eng 2', email: 'ot2@citygrid.io', mfa: true },
      ],
      usage: { base: 14500, variance: 3000 },
      services: [
        { name: 'SIEM',                  renewsIn: 95 },
        { name: 'Incident Response',     renewsIn: 95 },
        { name: 'Zero Trust',            renewsIn: 7 },                  // EXPIRING very soon
        { name: 'Threat Intel',          renewsIn: 180 },
        { name: 'Compliance Monitoring', renewsIn: 280 },
      ],
    },
    {
      name: 'Nexus Financial Group', slug: 'nexus-financial', industry: 'Finance', plan: 'ENTERPRISE',
      contractValue: 120000, healthScore: 95, csm: 'Marcus Webb', sso: true, mfa: true,
      adminName: 'Natalie Park', adminEmail: 'npark@nexusfinancial.com',
      users: [
        { name: 'SOC Analyst 1', email: 'socanalyst1@nexusfinancial.com', mfa: true },
        { name: 'SOC Analyst 2', email: 'socanalyst2@nexusfinancial.com', mfa: true },
      ],
      usage: { base: 12000, variance: 2000 },
      services: [
        { name: 'SIEM',                  renewsIn: 210 },
        { name: 'Threat Intel',          renewsIn: 210 },
        { name: 'SOC-as-a-Service',      renewsIn: 210 },
        { name: 'DLP',                   renewsIn: 110 },
        { name: 'Compliance Monitoring', renewsIn: 330 },
      ],
    },
    {
      name: 'MedCure Health Systems', slug: 'medcure-health', industry: 'Healthcare', plan: 'ENTERPRISE',
      contractValue: 95000, healthScore: 85, csm: 'Priya Nair', sso: false, mfa: true,
      adminName: 'Sandra Kim', adminEmail: 'skim@medcure.health',
      users: [
        { name: 'HIPAA Officer 1', email: 'hipaa1@medcure.health', mfa: true },
        { name: 'HIPAA Officer 2', email: 'hipaa2@medcure.health', mfa: true },
      ],
      usage: { base: 9500, variance: 1500 },
      services: [
        { name: 'Vulnerability Mgmt',    renewsIn: 60 },
        { name: 'EDR',                   renewsIn: 60 },
        { name: 'Compliance Monitoring', renewsIn: 60 },
        { name: 'DLP',                   renewsIn: -8, status: 'EXPIRED' },  // EXPIRED!
        { name: 'SIEM',                  renewsIn: 270 },
      ],
    },
    {
      name: 'BlueSky Insurance', slug: 'bluesky-insurance', industry: 'Insurance', plan: 'ENTERPRISE',
      contractValue: 88000, healthScore: 91, csm: 'Priya Nair', sso: true, mfa: false,
      adminName: 'Carlos Rivera', adminEmail: 'crivera@bluesky-ins.com',
      users: [
        { name: 'Compliance Analyst 1', email: 'ca1@bluesky-ins.com' },
        { name: 'Compliance Analyst 2', email: 'ca2@bluesky-ins.com' },
      ],
      usage: { base: 8800, variance: 1200 },
      services: [
        { name: 'SIEM',                  renewsIn: 130 },
        { name: 'DLP',                   renewsIn: 130 },
        { name: 'Compliance Monitoring', renewsIn: 25 },                 // EXPIRING
        { name: 'Threat Intel',          renewsIn: 200 },
      ],
    },
    {
      name: 'Pinnacle Law Partners', slug: 'pinnacle-law', industry: 'Legal', plan: 'PRO',
      contractValue: 52000, healthScore: 90, csm: 'Sarah Chen', sso: false, mfa: false,
      adminName: 'Diana Foster', adminEmail: 'dfoster@pinnaclelaw.com',
      users: [
        { name: 'Legal IT 1', email: 'it1@pinnaclelaw.com' },
        { name: 'Legal IT 2', email: 'it2@pinnaclelaw.com' },
      ],
      usage: { base: 3800, variance: 600 },
      services: [
        { name: 'DLP',                   renewsIn: 78 },
        { name: 'Vulnerability Mgmt',    renewsIn: 78 },
        { name: 'Compliance Monitoring', renewsIn: 78 },
        { name: 'EDR',                   renewsIn: 78 },
      ],
    },
    {
      name: 'Vertex Retail Corp', slug: 'vertex-retail', industry: 'Retail', plan: 'PRO',
      contractValue: 48000, healthScore: 76, csm: 'Marcus Webb', sso: false, mfa: false,
      adminName: 'Henry Walsh', adminEmail: 'hwalsh@vertexretail.com',
      users: [
        { name: 'IT Staff 1', email: 'it1@vertexretail.com' },
        { name: 'IT Staff 2', email: 'it2@vertexretail.com' },
      ],
      usage: { base: 3200, variance: 800 },
      services: [
        { name: 'Cloud Security',     renewsIn: 45 },
        { name: 'DLP',                renewsIn: 45 },
        { name: 'Vulnerability Mgmt', renewsIn: -3, status: 'SUSPENDED', enabled: false }, // SUSPENDED!
      ],
    },
    {
      name: 'NovaTech Manufacturing', slug: 'novatech-mfg', industry: 'Manufacturing', plan: 'PRO',
      contractValue: 40000, healthScore: 82, csm: 'Priya Nair', sso: false, mfa: false,
      adminName: 'Sophia Lee', adminEmail: 'slee@novatech-mfg.com',
      users: [
        { name: 'Plant IT 1', email: 'plantit1@novatech-mfg.com' },
        { name: 'Plant IT 2', email: 'plantit2@novatech-mfg.com' },
      ],
      usage: { base: 2800, variance: 600 },
      services: [
        { name: 'EDR',                renewsIn: 102 },
        { name: 'Cloud Security',     renewsIn: 102 },
        { name: 'Vulnerability Mgmt', renewsIn: 102 },
      ],
    },
    {
      name: 'TerraLogic Supply', slug: 'terralogic-supply', industry: 'Logistics', plan: 'PRO',
      contractValue: 36000, healthScore: 79, csm: 'Marcus Webb', sso: false, mfa: false,
      adminName: 'Finn Murphy', adminEmail: 'fmurphy@terralogic.co',
      users: [
        { name: 'Network Eng 1', email: 'neteng1@terralogic.co' },
        { name: 'Network Eng 2', email: 'neteng2@terralogic.co' },
      ],
      usage: { base: 2400, variance: 500 },
      services: [
        { name: 'SOC-as-a-Service', renewsIn: 165 },
        { name: 'EDR',              renewsIn: 165 },
        { name: 'Cloud Security',   renewsIn: 165 },
      ],
    },
    {
      name: 'Cortex Media Group', slug: 'cortex-media', industry: 'Media & Entertainment', plan: 'PRO',
      contractValue: 35000, healthScore: 88, csm: 'Sarah Chen', sso: false, mfa: false,
      adminName: 'Aiden Scott', adminEmail: 'ascott@cortexmedia.tv',
      users: [
        { name: 'Cloud Eng 1', email: 'cloud1@cortexmedia.tv' },
        { name: 'Cloud Eng 2', email: 'cloud2@cortexmedia.tv' },
      ],
      usage: { base: 2200, variance: 400 },
      services: [
        { name: 'Cloud Security',     renewsIn: 195 },
        { name: 'EDR',                renewsIn: 195 },
        { name: 'Vulnerability Mgmt', renewsIn: 195 },
      ],
    },
    {
      name: 'Ironclad Logistics', slug: 'ironclad-logistics', industry: 'Logistics', plan: 'FREE',
      contractValue: 0, healthScore: 72, csm: 'Priya Nair', sso: false, mfa: false,
      adminName: 'Zoe Grant', adminEmail: 'zgrant@ironclad-log.com',
      users: [{ name: 'IT Admin Trial', email: 'it@ironclad-log.com' }],
      usage: { base: 120, variance: 80 },
      services: [
        { name: 'Vulnerability Mgmt', renewsIn: 5 },  // trial expiring
      ],
    },
  ];

  // ─── Create each org with its admin, users, services, usage ────────────────
  const created: Array<{ id: string; name: string; plan: string; admin: { id: string; email: string } }> = [];
  let serviceCount = 0;

  for (const spec of orgSpecs) {
    const org = await prisma.organization.create({
      data: {
        name: spec.name, slug: spec.slug, plan: spec.plan,
        industry: spec.industry, contractValue: spec.contractValue,
        healthScore: spec.healthScore, csm: spec.csm,
        creditLimit: CREDIT_LIMITS[spec.plan]!,
        ssoEnabled: spec.sso, mfaRequired: spec.mfa,
      },
    });

    // Org admin
    const admin = await prisma.user.create({
      data: {
        name: spec.adminName, email: spec.adminEmail,
        passwordHash: await hash('Admin1234!'),
        role: 'ORG_ADMIN', mfaEnabled: spec.mfa || spec.sso,
        organizationId: org.id,
        lastLoginAt: hoursAgo(Math.floor(Math.random() * 48) + 1),
      },
    });

    // Regular users
    for (const u of spec.users) {
      await prisma.user.create({
        data: {
          name: u.name, email: u.email,
          passwordHash: await hash('User1234!'),
          role: 'USER', mfaEnabled: u.mfa ?? false,
          organizationId: org.id,
        },
      });
    }

    // Services
    for (const s of spec.services) {
      await createService(org.id, s.name, daysFromNow(s.renewsIn), {
        enabled: s.enabled,
        status: s.status,
        purchasedDaysAgo: 365 - Math.max(0, s.renewsIn),
      });
      serviceCount++;
    }

    await seedUsage(org.id, spec.usage.base, spec.usage.variance);
    created.push({ id: org.id, name: org.name, plan: spec.plan, admin: { id: admin.id, email: admin.email } });
    console.log(`✅ ${spec.name.padEnd(28)} [${spec.plan.padEnd(10)} / $${(spec.contractValue/1000).toFixed(0).padStart(3)}K]  →  ${spec.adminEmail}`);
  }
  console.log(`\n📦 Created ${serviceCount} service subscriptions`);

  const byName = (name: string) => created.find((o) => o.name === name)!;
  const datavault = byName('DataVault Banking');
  const orbital   = byName('Orbital Aerospace');
  const citygrid  = byName('CityGrid Power');
  const nexus     = byName('Nexus Financial Group');
  const medcure   = byName('MedCure Health Systems');
  const bluesky   = byName('BlueSky Insurance');
  const vertex    = byName('Vertex Retail Corp');
  const pinnacle  = byName('Pinnacle Law Partners');
  const cortex    = byName('Cortex Media Group');
  const terra     = byName('TerraLogic Supply');
  const novatech  = byName('NovaTech Manufacturing');
  const ironclad  = byName('Ironclad Logistics');

  // ─── Org Feature Flag overrides ────────────────────────────────────────────
  await prisma.orgFeatureFlag.createMany({
    data: [
      { organizationId: datavault.id, key: 'ai_threat_analysis',     value: true  },
      { organizationId: datavault.id, key: 'auto_incident_response',  value: true  },
      { organizationId: datavault.id, key: 'zero_trust_beta',         value: true  },
      { organizationId: datavault.id, key: 'deception_grid',          value: true  },
      { organizationId: orbital.id,   key: 'deception_grid',          value: true  },
      { organizationId: orbital.id,   key: 'ai_threat_analysis',      value: true  },
      { organizationId: nexus.id,     key: 'ai_threat_analysis',      value: true  },
      { organizationId: nexus.id,     key: 'siem_ml_correlation',     value: true  },
      { organizationId: medcure.id,   key: 'auto_incident_response',  value: false },
      { organizationId: citygrid.id,  key: 'zero_trust_beta',         value: true  },
    ],
  });
  console.log('🚩 Org-level feature flag overrides applied');

  // ─── Service Requests / Tickets ────────────────────────────────────────────
  await prisma.serviceRequest.createMany({
    data: [
      // CRITICAL / ESCALATED
      { organizationId: datavault.id, type: 'INCIDENT', status: 'ESCALATED', priority: 'CRITICAL',
        subject: 'Suspicious lateral movement detected in prod trading environment',
        description: 'SIEM triggered 47 correlated alerts indicating lateral movement from compromised service account.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: hoursAgo(2) },
      { organizationId: citygrid.id, type: 'INCIDENT', status: 'ESCALATED', priority: 'CRITICAL',
        subject: 'SCADA network port scan detected — potential OT intrusion',
        description: 'Unauthorized port scanning targeting SCADA control systems on isolated OT network.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: hoursAgo(4) },
      // HIGH
      { organizationId: orbital.id, type: 'INCIDENT', status: 'IN_PROGRESS', priority: 'HIGH',
        subject: 'Privileged account access from unrecognized geolocation (Moscow, RU)',
        description: 'Admin account accessed from Russia. MFA bypassed. Possible credential theft.',
        service: 'Zero Trust', assignedTo: 'Marcus Webb', createdAt: hoursAgo(6) },
      { organizationId: nexus.id, type: 'INCIDENT', status: 'IN_PROGRESS', priority: 'HIGH',
        subject: 'Threat intel feed stale — IOCs not updating for 18 hours',
        description: 'The threat intelligence feed pipeline has failed silently.',
        service: 'Threat Intel', assignedTo: 'Marcus Webb', createdAt: hoursAgo(18) },
      { organizationId: medcure.id, type: 'SUPPORT', status: 'OPEN', priority: 'HIGH',
        subject: 'EDR agent quarantined critical Epic EHR process — patient impact',
        description: 'EDR falsely quarantined Epic on 12 clinical workstations. Active patient care disruption.',
        service: 'EDR', assignedTo: 'Priya Nair', createdAt: hoursAgo(1) },
      // MEDIUM
      { organizationId: nexus.id, type: 'SUPPORT', status: 'IN_PROGRESS', priority: 'MEDIUM',
        subject: 'SIEM correlation rules need tuning for trading desk workloads',
        description: 'High false-positive rate on algorithmic trading processes.',
        service: 'SIEM', assignedTo: 'Marcus Webb', createdAt: daysAgo(2) },
      { organizationId: bluesky.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Add custom DLP policy for PII/PCI fields in claims database',
        description: 'Build DLP rules for insurance claims data: SSN, DOB, policy numbers.',
        service: 'DLP', assignedTo: 'Priya Nair', createdAt: daysAgo(3) },
      { organizationId: vertex.id, type: 'SUPPORT', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Cloud security posture report showing 23 critical misconfigs in AWS',
        description: 'CSPM scan returned 23 critical and 47 high findings in production AWS account.',
        service: 'Cloud Security', assignedTo: 'Marcus Webb', createdAt: daysAgo(1) },
      { organizationId: orbital.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Request integration of SIEM with Lockheed Cyber Kill Chain framework',
        description: 'Custom SIEM dashboards mapped to the Cyber Kill Chain for ITAR compliance.',
        service: 'SIEM', assignedTo: 'Marcus Webb', createdAt: daysAgo(4) },
      { organizationId: novatech.id, type: 'SUPPORT', status: 'IN_PROGRESS', priority: 'MEDIUM',
        subject: 'EDR agent failing to update on 8 factory floor Windows XP machines',
        description: 'Legacy industrial control PCs running Windows XP cannot receive EDR agent updates.',
        service: 'EDR', assignedTo: 'Priya Nair', createdAt: daysAgo(5) },
      // RESOLVED + LOW
      { organizationId: pinnacle.id, type: 'SUPPORT', status: 'RESOLVED', priority: 'MEDIUM',
        subject: 'Generate GDPR compliance report for external audit',
        description: 'Automated compliance report for DLP, data access logs, and breach notifications.',
        service: 'Compliance Monitoring', assignedTo: 'Sarah Chen', createdAt: daysAgo(7), resolvedAt: daysAgo(5) },
      { organizationId: terra.id, type: 'SUPPORT', status: 'RESOLVED', priority: 'LOW',
        subject: 'SOC dashboard not loading for 3 remote warehouse users',
        description: 'VPN routing issue causing SOC portal inaccessibility.',
        service: 'SOC-as-a-Service', assignedTo: 'Marcus Webb', createdAt: daysAgo(3), resolvedAt: daysAgo(2) },
      { organizationId: ironclad.id, type: 'ONBOARDING', status: 'OPEN', priority: 'LOW',
        subject: 'Complete initial vulnerability scan baseline configuration',
        description: 'First-time setup of vulnerability scanning scope, credentialed scan profiles, and templates.',
        service: 'Vulnerability Mgmt', assignedTo: 'Priya Nair', createdAt: daysAgo(6) },
      { organizationId: cortex.id, type: 'SUPPORT', status: 'OPEN', priority: 'LOW',
        subject: 'Cloud security posture report for new Azure Media Services workloads',
        description: 'Extend CSPM coverage to newly deployed Azure Media Services infrastructure.',
        service: 'Cloud Security', assignedTo: 'Sarah Chen', createdAt: daysAgo(2) },
      { organizationId: datavault.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'SIEM ↔ ServiceNow bidirectional integration for incident ticketing',
        description: 'Auto-create ServiceNow P1/P2 tickets from SIEM alerts, sync resolution status back.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: daysAgo(8) },
      { organizationId: medcure.id, type: 'BILLING', status: 'OPEN', priority: 'LOW',
        subject: 'Invoice discrepancy — HIPAA compliance add-on billed twice in October',
        description: 'Duplicate line item for HIPAA compliance monitoring add-on in October invoice.',
        service: 'Compliance Monitoring', assignedTo: 'Priya Nair', createdAt: daysAgo(10) },
      { organizationId: bluesky.id, type: 'ONBOARDING', status: 'RESOLVED', priority: 'LOW',
        subject: 'Onboard 4 new SOC analysts to SIEM console and runbooks',
        description: 'Training and access provisioning for Q4 SOC analyst class.',
        service: 'SIEM', assignedTo: 'Priya Nair', createdAt: daysAgo(14), resolvedAt: daysAgo(10) },
    ],
  });
  console.log('📋 Created 17 service requests\n');

  // ─── Audit logs ─────────────────────────────────────────────────────────────
  await prisma.auditLog.createMany({
    data: [
      { action: 'LOGIN',          performedById: saasAdmin.id,        organizationId: techOrg.id,    metadata: { ip: '10.0.0.1' } },
      { action: 'LOGIN',          performedById: datavault.admin.id,  organizationId: datavault.id,  metadata: { ip: '192.168.10.5' } },
      { action: 'LOGIN',          performedById: orbital.admin.id,    organizationId: orbital.id,    metadata: { ip: '10.50.0.1' } },
      { action: 'ORG_SUSPENDED',  performedById: saasAdmin.id, targetId: ironclad.id,  organizationId: ironclad.id, metadata: { reason: 'Trial conversion pending' } },
      { action: 'IMPERSONATE',    performedById: saasAdmin.id, targetId: vertex.admin.id, organizationId: vertex.id, metadata: { reason: 'Health score investigation TKT-2041' } },
      { action: 'PLAN_UPGRADED',  performedById: saasAdmin.id, targetId: bluesky.id, organizationId: bluesky.id, metadata: { from: 'PRO', to: 'ENTERPRISE' } },
      { action: 'MFA_ENFORCED',   performedById: saasAdmin.id, targetId: medcure.id, organizationId: medcure.id, metadata: { reason: 'HIPAA compliance requirement' } },
      { action: 'SERVICE_DISABLED', performedById: saasAdmin.id, targetId: vertex.id, organizationId: vertex.id, metadata: { service: 'Vulnerability Mgmt', reason: 'Payment overdue 14 days' } },
    ],
  });
  console.log('📝 Created audit trail entries');

  // ─── Summary ────────────────────────────────────────────────────────────────
  const totalACV = orgSpecs.reduce((s, o) => s + o.contractValue, 0);
  console.log('\n' + '─'.repeat(72));
  console.log('🎉 Tech cybersecurity platform seeded with 3-tier RBAC!\n');
  console.log('  Roles  →  SAAS_ADMIN  >  ORG_ADMIN  >  USER\n');
  console.log('  Super Admin');
  console.log('    SAAS_ADMIN  admin@platform.com         SaasAdmin1!\n');
  console.log('  Organization Admins  (all use password "Admin1234!")');
  for (const o of created) {
    console.log(`    ORG_ADMIN   ${o.admin.email.padEnd(34)} [${o.name}]`);
  }
  console.log('\n  Users  →  ~28 USER accounts seeded across orgs (password "User1234!")');
  console.log(`           Examples:  kokafor@datavault.com   ot1@citygrid.io   it1@pinnaclelaw.com`);
  console.log(`\n  Services  →  ${serviceCount} subscriptions  |  ARR $${totalACV.toLocaleString()}  |  MRR $${Math.round(totalACV/12).toLocaleString()}`);
  console.log('─'.repeat(72));
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
