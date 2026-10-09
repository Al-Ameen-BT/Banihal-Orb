import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (pw: string) => bcrypt.hash(pw, 12);

// ─── Cybersecurity service catalog: main services → sub-services ────────────
const SERVICE_CATALOG: Record<string, { price: number; description: string; subs: Array<{ name: string; price: number }> }> = {
  'SIEM': { price: 8000, description: 'Security Information & Event Management with ML correlation', subs: [
    { name: 'Log Ingestion & Retention', price: 2000 },
    { name: 'ML Event Correlation', price: 3000 },
    { name: 'Managed Threat Hunting', price: 3000 },
  ] },
  'SOC-as-a-Service': { price: 15000, description: '24/7 managed Security Operations Center coverage', subs: [
    { name: 'Tier-1 Alert Monitoring', price: 5000 },
    { name: 'Tier-2 Incident Triage', price: 6000 },
    { name: 'Tier-3 Threat Hunting', price: 4000 },
  ] },
  'EDR': { price: 4000, description: 'Endpoint Detection & Response with behavioral analysis', subs: [
    { name: 'Endpoint Agent Management', price: 1500 },
    { name: 'Behavioral Analysis', price: 1500 },
    { name: 'Automated Containment', price: 1000 },
  ] },
  'Threat Intel': { price: 2500, description: 'Real-time threat intelligence feed + IOC enrichment', subs: [
    { name: 'IOC Feed & Enrichment', price: 1500 },
    { name: 'Dark Web Monitoring', price: 1000 },
  ] },
  'Vulnerability Mgmt': { price: 3000, description: 'Continuous vulnerability scanning + remediation guidance', subs: [
    { name: 'Network Scanning', price: 1200 },
    { name: 'Web App Scanning', price: 1000 },
    { name: 'Remediation Guidance', price: 800 },
  ] },
  'Zero Trust': { price: 5000, description: 'Zero Trust Network Access with conditional policies', subs: [
    { name: 'ZTNA Gateway', price: 2500 },
    { name: 'Conditional Access Policies', price: 1500 },
    { name: 'Device Posture Checks', price: 1000 },
  ] },
  'DLP': { price: 3500, description: 'Data Loss Prevention with PII/PCI/PHI detection', subs: [
    { name: 'Endpoint DLP', price: 1500 },
    { name: 'Network DLP', price: 1200 },
    { name: 'Cloud DLP', price: 800 },
  ] },
  'Cloud Security': { price: 4500, description: 'CSPM + CWPP across AWS, Azure, GCP workloads', subs: [
    { name: 'CSPM (Posture)', price: 1800 },
    { name: 'CWPP (Workload)', price: 1700 },
    { name: 'CIEM (Entitlements)', price: 1000 },
  ] },
  'Compliance Monitoring': { price: 2000, description: 'SOC 2, HIPAA, PCI-DSS, GDPR continuous compliance', subs: [
    { name: 'SOC 2', price: 600 },
    { name: 'HIPAA', price: 600 },
    { name: 'PCI-DSS', price: 500 },
    { name: 'GDPR', price: 300 },
  ] },
  'Incident Response': { price: 6000, description: '4-hour IR SLA with forensics and containment', subs: [
    { name: 'Digital Forensics', price: 2500 },
    { name: 'Containment & Eradication', price: 2000 },
    { name: 'Post-Incident Review', price: 1500 },
  ] },
  'Penetration Testing': { price: 4000, description: 'Quarterly external + internal penetration testing', subs: [
    { name: 'External Pentest', price: 1500 },
    { name: 'Internal Pentest', price: 1500 },
    { name: 'Web App Pentest', price: 1000 },
  ] },
  'Deception Technology': { price: 3500, description: 'Honeypot grid for adversary detection', subs: [
    { name: 'Honeypot Grid', price: 2000 },
    { name: 'Decoy Credentials', price: 1500 },
  ] },
};

// Plan → base monthly credit limit
const CREDIT_LIMITS: Record<string, number> = { FREE: 500, PRO: 5000, ENTERPRISE: 25000 };

const now = new Date();
const daysFromNow = (d: number) => new Date(now.getTime() + d * 86400_000);
const daysAgo     = (d: number) => new Date(now.getTime() - d * 86400_000);
const hoursAgo    = (h: number) => new Date(now.getTime() - h * 3600_000);

// Derive the domain from a contact email, ignoring generic gmail addresses.
const deriveDomain = (email: string): string | null => {
  const d = email.split('@')[1]?.toLowerCase().trim();
  return !d || d === 'gmail.com' ? null : d;
};

// Short org code embedded in ticket numbers (e.g. "DataVault Banking" → DVB).
// orgCode is @unique, so dedupe within the seed run.
const usedOrgCodes = new Set<string>();
const codeFor = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  let base = (words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? 'ORG').slice(0, 4))
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'ORG';
  let code = base, i = 2;
  while (usedOrgCodes.has(code)) { code = `${base}${i++}`.slice(0, 8); }
  usedOrgCodes.add(code);
  return code;
};

async function main() {
  console.log('🌱 Seeding Tech cybersecurity platform…\n');

  // ─── Clean slate (force-reset already wiped, but be defensive) ─────────────
  await prisma.customerService.deleteMany();
  await prisma.serviceRequest.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.orgFeatureFlag.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.user.deleteMany();
  await prisma.customer.deleteMany();
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

  // Helper: add a service to a customer (per-org — name + price stored directly).
  async function purchase(customerId: string, name: keyof typeof SERVICE_CATALOG, endDate: Date, purchasedDaysAgo: number) {
    const cat = SERVICE_CATALOG[name];
    return prisma.customerService.create({
      data: {
        customerId,
        name,
        description: cat.description,
        monthlyPrice: cat.price,
        purchaseDate: daysAgo(purchasedDaysAgo),
        endDate,
      },
    });
  }

  // ─── Tech (internal SaaS admin org) ────────────────────────────────────────
  // Admins must sit on a domain in ADMIN_DOMAINS or login (which enforces it) will
  // reject them. Use the first configured provider domain, falling back to platform.com.
  const ADMIN_DOMAIN = (process.env.ADMIN_DOMAINS ?? '').split(',')[0]?.trim().toLowerCase() || 'platform.com';
  // Primary ADMINISTRATOR uses a real inbox (gmail) so MFA codes can be received.
  // Requires gmail.com in ADMIN_DOMAINS — see isProviderAdminEmail in auth.service.
  const adminEmail = 'ameen.bt017@gmail.com';
  const superAdminEmail = `superadmin@${ADMIN_DOMAIN}`;

  const techOrg = await prisma.customer.create({
    data: {
      name: 'Tech', slug: `platform-${ADMIN_DOMAIN.replace(/\./g, '-')}`, plan: 'ENTERPRISE',
      industry: 'Cybersecurity', contractValue: 0, healthScore: 100, csm: 'Internal',
      creditLimit: 99999, ssoEnabled: true, mfaRequired: false, // 2FA off by default
      mailId: adminEmail, contactPerson: 'Alex Chen',
      contactNumber: '+1-555-0100', domain: deriveDomain(adminEmail),
      orgCode: codeFor('Tech'),
      // Seeded orgs are pre-approved. `approved` defaults to false so that SELF-
      // registration lands in the admission queue; demo data is not self-registered,
      // and without this every seeded account would be locked out at login.
      approved: true, approvedAt: new Date(),
    },
  });
  const sadmin = await prisma.user.create({
    data: {
      name: 'Alex Chen', email: adminEmail,
      passwordHash: await hash('SaasAdmin1!'),
      role: 'ADMINISTRATOR', mfaEnabled: false, // 2FA off by default; enable from profile
      // Seeded staff are Administration. The row is created by db/b2b.sql, which
      // provision.sh runs before this seed.
      platformRoleId: 'plr_administration',
      emailVerifiedAt: now, // seeded accounts skip the verification round-trip
      customerId: techOrg.id, lastLoginAt: now,
    },
  });
  const administrator = await prisma.user.create({
    data: {
      name: 'Super Admin', email: superAdminEmail,
      passwordHash: await hash('SuperAdmin1!'),
      role: 'ADMINISTRATOR', mfaEnabled: false, // 2FA off by default; enable from profile
      // Seeded staff are Administration. The row is created by db/b2b.sql, which
      // provision.sh runs before this seed.
      platformRoleId: 'plr_administration',
      emailVerifiedAt: now, // seeded accounts skip the verification round-trip
      customerId: techOrg.id, lastLoginAt: now,
    },
  });
  console.log(`✅ Tech (internal)  →  ${sadmin.email}  [ADMINISTRATOR]`);
  console.log(`✅ Tech (internal)  →  ${administrator.email}  [ADMINISTRATOR]\n`);

  // ─── Spec for each client org ──────────────────────────────────────────────
  type OrgSpec = {
    name: string; slug: string; industry: string; plan: 'FREE' | 'PRO' | 'ENTERPRISE';
    contractValue: number; healthScore: number; csm: string;
    sso: boolean; mfa: boolean;
    adminName: string; adminEmail: string;
    users: Array<{ name: string; email: string; mfa?: boolean }>;
    // Each purchased service includes its end date in days from now (negative = expired)
    services: Array<{ name: keyof typeof SERVICE_CATALOG; renewsIn: number }>;
  };

  const orgSpecs: OrgSpec[] = [
    {
      name: 'DataVault Banking', slug: 'datavault-banking', industry: 'Banking', plan: 'ENTERPRISE',
      contractValue: 210000, healthScore: 98, csm: 'Sarah Chen', sso: true, mfa: true,
      adminName: 'James Whitfield', adminEmail: 'mrameen.second05@gmail.com',
      users: [
        { name: 'Kevin Okafor', email: 'ameen@banihaltechnologies.com', mfa: true },
        { name: 'Laura Metz',   email: 'lmetz@datavault.com',   mfa: true },
        { name: 'Omar Hassan',  email: 'ohassan@datavault.com', mfa: true },
      ],
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
      services: [
        { name: 'Vulnerability Mgmt',    renewsIn: 60 },
        { name: 'EDR',                   renewsIn: 60 },
        { name: 'Compliance Monitoring', renewsIn: 60 },
        { name: 'DLP',                   renewsIn: -8 },  // EXPIRED!
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
      services: [
        { name: 'Cloud Security',     renewsIn: 45 },
        { name: 'DLP',                renewsIn: 45 },
        { name: 'Vulnerability Mgmt', renewsIn: -3 }, // EXPIRED!
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
      services: [
        { name: 'Vulnerability Mgmt', renewsIn: 5 },  // trial expiring
      ],
    },
  ];

  // ─── Create each org with its admin, users, services ───────────────────────
  const created: Array<{ id: string; name: string; plan: string; admin: { id: string; email: string } }> = [];
  let serviceCount = 0;

  for (const spec of orgSpecs) {
    const org = await prisma.customer.create({
      data: {
        name: spec.name, slug: spec.slug, plan: spec.plan,
        industry: spec.industry, contractValue: spec.contractValue,
        healthScore: spec.healthScore, csm: spec.csm,
        creditLimit: CREDIT_LIMITS[spec.plan]!,
        ssoEnabled: spec.sso, mfaRequired: false, // 2FA off by default
        mailId: spec.adminEmail, contactPerson: spec.adminName,
        contactNumber: `+1-555-${String(101 + created.length).padStart(4, '0')}`,
        domain: deriveDomain(spec.adminEmail),
        orgCode: codeFor(spec.name),
        approved: true, approvedAt: new Date(),   // see the Tech org above
      },
    });

    // Org admin
    const admin = await prisma.user.create({
      data: {
        name: spec.adminName, email: spec.adminEmail,
        passwordHash: await hash('Admin1234!'),
        role: 'ORG_ADMIN', mfaEnabled: false, // 2FA off by default; enable from profile
        emailVerifiedAt: now, // demo accounts must be able to log in without a real inbox
        customerId: org.id,
        lastLoginAt: hoursAgo(Math.floor(Math.random() * 48) + 1),
      },
    });

    // Regular users
    for (const u of spec.users) {
      await prisma.user.create({
        data: {
          name: u.name, email: u.email,
          passwordHash: await hash('User1234!'),
          role: 'USER', mfaEnabled: false, // 2FA off by default; enable from profile
          emailVerifiedAt: now, // demo accounts must be able to log in without a real inbox
          customerId: org.id,
        },
      });
    }

    // Purchased services
    for (const s of spec.services) {
      await purchase(org.id, s.name, daysFromNow(s.renewsIn), 365 - Math.max(0, s.renewsIn));
      serviceCount++;
    }

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
      { customerId: datavault.id, key: 'ai_threat_analysis',     value: true  },
      { customerId: datavault.id, key: 'auto_incident_response',  value: true  },
      { customerId: datavault.id, key: 'zero_trust_beta',         value: true  },
      { customerId: datavault.id, key: 'deception_grid',          value: true  },
      { customerId: orbital.id,   key: 'deception_grid',          value: true  },
      { customerId: orbital.id,   key: 'ai_threat_analysis',      value: true  },
      { customerId: nexus.id,     key: 'ai_threat_analysis',      value: true  },
      { customerId: nexus.id,     key: 'siem_ml_correlation',     value: true  },
      { customerId: medcure.id,   key: 'auto_incident_response',  value: false },
      { customerId: citygrid.id,  key: 'zero_trust_beta',         value: true  },
    ],
  });
  console.log('🚩 Org-level feature flag overrides applied');

  // ─── Service Requests / Tickets ────────────────────────────────────────────
  await prisma.serviceRequest.createMany({
    data: [
      // CRITICAL / ESCALATED
      { customerId: datavault.id, type: 'INCIDENT', status: 'ESCALATED', priority: 'CRITICAL',
        subject: 'Suspicious lateral movement detected in prod trading environment',
        description: 'SIEM triggered 47 correlated alerts indicating lateral movement from compromised service account.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: hoursAgo(2) },
      { customerId: citygrid.id, type: 'INCIDENT', status: 'ESCALATED', priority: 'CRITICAL',
        subject: 'SCADA network port scan detected — potential OT intrusion',
        description: 'Unauthorized port scanning targeting SCADA control systems on isolated OT network.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: hoursAgo(4) },
      // HIGH
      { customerId: orbital.id, type: 'INCIDENT', status: 'IN_PROGRESS', priority: 'HIGH',
        subject: 'Privileged account access from unrecognized geolocation (Moscow, RU)',
        description: 'Admin account accessed from Russia. MFA bypassed. Possible credential theft.',
        service: 'Zero Trust', assignedTo: 'Marcus Webb', createdAt: hoursAgo(6) },
      { customerId: nexus.id, type: 'INCIDENT', status: 'IN_PROGRESS', priority: 'HIGH',
        subject: 'Threat intel feed stale — IOCs not updating for 18 hours',
        description: 'The threat intelligence feed pipeline has failed silently.',
        service: 'Threat Intel', assignedTo: 'Marcus Webb', createdAt: hoursAgo(18) },
      { customerId: medcure.id, type: 'SUPPORT', status: 'OPEN', priority: 'HIGH',
        subject: 'EDR agent quarantined critical Epic EHR process — patient impact',
        description: 'EDR falsely quarantined Epic on 12 clinical workstations. Active patient care disruption.',
        service: 'EDR', assignedTo: 'Priya Nair', createdAt: hoursAgo(1) },
      // MEDIUM
      { customerId: nexus.id, type: 'SUPPORT', status: 'IN_PROGRESS', priority: 'MEDIUM',
        subject: 'SIEM correlation rules need tuning for trading desk workloads',
        description: 'High false-positive rate on algorithmic trading processes.',
        service: 'SIEM', assignedTo: 'Marcus Webb', createdAt: daysAgo(2) },
      { customerId: bluesky.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Add custom DLP policy for PII/PCI fields in claims database',
        description: 'Build DLP rules for insurance claims data: SSN, DOB, policy numbers.',
        service: 'DLP', assignedTo: 'Priya Nair', createdAt: daysAgo(3) },
      { customerId: vertex.id, type: 'SUPPORT', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Cloud security posture report showing 23 critical misconfigs in AWS',
        description: 'CSPM scan returned 23 critical and 47 high findings in production AWS account.',
        service: 'Cloud Security', assignedTo: 'Marcus Webb', createdAt: daysAgo(1) },
      { customerId: orbital.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'Request integration of SIEM with Lockheed Cyber Kill Chain framework',
        description: 'Custom SIEM dashboards mapped to the Cyber Kill Chain for ITAR compliance.',
        service: 'SIEM', assignedTo: 'Marcus Webb', createdAt: daysAgo(4) },
      { customerId: novatech.id, type: 'SUPPORT', status: 'IN_PROGRESS', priority: 'MEDIUM',
        subject: 'EDR agent failing to update on 8 factory floor Windows XP machines',
        description: 'Legacy industrial control PCs running Windows XP cannot receive EDR agent updates.',
        service: 'EDR', assignedTo: 'Priya Nair', createdAt: daysAgo(5) },
      // RESOLVED + LOW
      { customerId: pinnacle.id, type: 'SUPPORT', status: 'RESOLVED', priority: 'MEDIUM',
        subject: 'Generate GDPR compliance report for external audit',
        description: 'Automated compliance report for DLP, data access logs, and breach notifications.',
        service: 'Compliance Monitoring', assignedTo: 'Sarah Chen', createdAt: daysAgo(7), resolvedAt: daysAgo(5) },
      { customerId: terra.id, type: 'SUPPORT', status: 'RESOLVED', priority: 'LOW',
        subject: 'SOC dashboard not loading for 3 remote warehouse users',
        description: 'VPN routing issue causing SOC portal inaccessibility.',
        service: 'SOC-as-a-Service', assignedTo: 'Marcus Webb', createdAt: daysAgo(3), resolvedAt: daysAgo(2) },
      { customerId: ironclad.id, type: 'ONBOARDING', status: 'OPEN', priority: 'LOW',
        subject: 'Complete initial vulnerability scan baseline configuration',
        description: 'First-time setup of vulnerability scanning scope, credentialed scan profiles, and templates.',
        service: 'Vulnerability Mgmt', assignedTo: 'Priya Nair', createdAt: daysAgo(6) },
      { customerId: cortex.id, type: 'SUPPORT', status: 'OPEN', priority: 'LOW',
        subject: 'Cloud security posture report for new Azure Media Services workloads',
        description: 'Extend CSPM coverage to newly deployed Azure Media Services infrastructure.',
        service: 'Cloud Security', assignedTo: 'Sarah Chen', createdAt: daysAgo(2) },
      { customerId: datavault.id, type: 'FEATURE_REQUEST', status: 'OPEN', priority: 'MEDIUM',
        subject: 'SIEM ↔ ServiceNow bidirectional integration for incident ticketing',
        description: 'Auto-create ServiceNow P1/P2 tickets from SIEM alerts, sync resolution status back.',
        service: 'SIEM', assignedTo: 'Sarah Chen', createdAt: daysAgo(8) },
      { customerId: medcure.id, type: 'BILLING', status: 'OPEN', priority: 'LOW',
        subject: 'Invoice discrepancy — HIPAA compliance add-on billed twice in October',
        description: 'Duplicate line item for HIPAA compliance monitoring add-on in October invoice.',
        service: 'Compliance Monitoring', assignedTo: 'Priya Nair', createdAt: daysAgo(10) },
      { customerId: bluesky.id, type: 'ONBOARDING', status: 'RESOLVED', priority: 'LOW',
        subject: 'Onboard 4 new SOC analysts to SIEM console and runbooks',
        description: 'Training and access provisioning for Q4 SOC analyst class.',
        service: 'SIEM', assignedTo: 'Priya Nair', createdAt: daysAgo(14), resolvedAt: daysAgo(10) },
    ],
  });
  console.log('📋 Created 17 service requests\n');

  // ─── Audit logs ─────────────────────────────────────────────────────────────
  await prisma.auditLog.createMany({
    data: [
      { action: 'LOGIN',          performedById: sadmin.id,           customerId: techOrg.id,    metadata: { ip: '10.0.0.1' } },
      { action: 'LOGIN',          performedById: datavault.admin.id,  customerId: datavault.id,  metadata: { ip: '192.168.10.5' } },
      { action: 'LOGIN',          performedById: orbital.admin.id,    customerId: orbital.id,    metadata: { ip: '10.50.0.1' } },
      { action: 'ORG_SUSPENDED',  performedById: sadmin.id, targetId: ironclad.id,  customerId: ironclad.id, metadata: { reason: 'Trial conversion pending' } },
      { action: 'IMPERSONATE',    performedById: sadmin.id, targetId: vertex.admin.id, customerId: vertex.id, metadata: { reason: 'Health score investigation TKT-2041' } },
      { action: 'PLAN_UPGRADED',  performedById: administrator.id, targetId: bluesky.id, customerId: bluesky.id, metadata: { from: 'PRO', to: 'ENTERPRISE' } },
      { action: 'MFA_ENFORCED',   performedById: administrator.id, targetId: medcure.id, customerId: medcure.id, metadata: { reason: 'HIPAA compliance requirement' } },
      { action: 'SERVICE_DISABLED', performedById: sadmin.id, targetId: vertex.id, customerId: vertex.id, metadata: { service: 'Vulnerability Mgmt', reason: 'Payment overdue 14 days' } },
    ],
  });
  console.log('📝 Created audit trail entries');

  // ─── Summary ────────────────────────────────────────────────────────────────
  const totalACV = orgSpecs.reduce((s, o) => s + o.contractValue, 0);
  console.log('\n' + '─'.repeat(72));
  console.log('🎉 Tech cybersecurity platform seeded with 3-tier RBAC!\n');
  console.log('  Roles  →  ADMINISTRATOR  >  ORG_ADMIN  >  USER\n');
  console.log('  Platform Admins');
  console.log(`    ADMINISTRATOR  ${superAdminEmail.padEnd(28)}SuperAdmin1!`);
  console.log(`    ADMINISTRATOR  ${adminEmail.padEnd(28)}SaasAdmin1!\n`);
  console.log('  Organization Admins  (all use password "Admin1234!")');
  for (const o of created) {
    console.log(`    ORG_ADMIN   ${o.admin.email.padEnd(34)} [${o.name}]`);
  }
  console.log('\n  Users  →  ~28 USER accounts seeded across orgs (password "User1234!")');
  console.log(`           Examples:  ameen@banihaltechnologies.com   ot1@citygrid.io   it1@pinnaclelaw.com`);
  console.log(`\n  Services  →  ${serviceCount} subscriptions  |  ARR $${totalACV.toLocaleString()}  |  MRR $${Math.round(totalACV/12).toLocaleString()}`);
  console.log('─'.repeat(72));
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
