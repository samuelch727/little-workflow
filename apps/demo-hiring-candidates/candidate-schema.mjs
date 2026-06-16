/**
 * Shared candidate + hiring-post contract for demo-hiring-candidates.
 *
 * Pure data + pure validators so the run script, the stub generator, and the
 * tests all agree on one source of truth for the dataset shape and the allowed
 * vocabularies.
 */

export const SENIORITY = ["Junior", "Mid", "Senior", "Staff", "Principal", "Lead", "Manager"];

export const SOURCES = [
  "LinkedIn",
  "Referral",
  "Job Board",
  "Company Website",
  "Recruiter Outreach",
  "GitHub",
  "Conference",
  "University",
];

export const STATUSES = [
  "Applied",
  "Screening",
  "Phone Screen",
  "Onsite",
  "Offer",
  "Hired",
  "Rejected",
  "Withdrawn",
];

export const LOCATIONS = [
  "San Francisco, CA",
  "New York, NY",
  "Austin, TX",
  "Seattle, WA",
  "Remote (US)",
  "London, UK",
  "Berlin, DE",
  "Toronto, CA",
  "Bangalore, IN",
  "Singapore",
  "Remote (EU)",
];

export const EDUCATION = [
  "High School",
  "Bootcamp",
  "Associate's",
  "Bachelor's",
  "Master's",
  "PhD",
  "Self-taught",
];

/** Approximate target distribution for the applicant funnel (shares sum to ~1.0). */
export const TARGET_DISTRIBUTION = {
  seniority: { Junior: 0.18, Mid: 0.27, Senior: 0.27, Staff: 0.12, Principal: 0.06, Lead: 0.06, Manager: 0.04 },
  source: {
    LinkedIn: 0.32,
    Referral: 0.16,
    "Job Board": 0.16,
    "Company Website": 0.1,
    "Recruiter Outreach": 0.1,
    GitHub: 0.08,
    Conference: 0.04,
    University: 0.04,
  },
  status: {
    Applied: 0.4,
    Screening: 0.18,
    "Phone Screen": 0.14,
    Onsite: 0.1,
    Offer: 0.04,
    Hired: 0.02,
    Rejected: 0.1,
    Withdrawn: 0.02,
  },
};

const STRING_FIELDS = [
  "candidate_id",
  "full_name",
  "email",
  "location",
  "headline",
  "current_company",
  "education",
  "summary",
  "source",
  "seniority",
  "status",
];

const NUMBER_FIELDS = ["years_experience", "desired_salary_usd", "match_score"];

const ENUM_FIELDS = [
  ["location", LOCATIONS],
  ["education", EDUCATION],
  ["source", SOURCES],
  ["seniority", SENIORITY],
  ["status", STATUSES],
];

/** JSON schema for a single candidate. Used as the worker array item schema. */
export const candidateItemSchema = {
  type: "object",
  required: [...STRING_FIELDS, "top_skills", ...NUMBER_FIELDS],
  additionalProperties: false,
  properties: {
    candidate_id: { type: "string" },
    full_name: { type: "string" },
    email: { type: "string" },
    location: { type: "string", enum: LOCATIONS },
    headline: { type: "string" },
    years_experience: { type: "number" },
    current_company: { type: "string" },
    top_skills: { type: "array", items: { type: "string" } },
    education: { type: "string", enum: EDUCATION },
    summary: { type: "string" },
    desired_salary_usd: { type: "number" },
    source: { type: "string", enum: SOURCES },
    seniority: { type: "string", enum: SENIORITY },
    status: { type: "string", enum: STATUSES },
    match_score: { type: "number" },
  },
};

export const candidateArraySchema = {
  type: "array",
  items: candidateItemSchema,
};

/** Input schema for the hiring.candidate.batch workflow (kept permissive). */
export const batchInputSchema = {
  type: "object",
  required: ["count"],
  additionalProperties: true,
  properties: {
    count: { type: "number" },
    startIndex: { type: "number" },
    role_title: { type: "string" },
    role_brief: { type: "string" },
    key_skills: { type: "array", items: { type: "string" } },
    instructions: { type: "string" },
    mix: { type: "object", additionalProperties: true },
  },
};

/** Output schema for the hiring.post.generate workflow. */
export const postSchema = {
  type: "object",
  required: [
    "role_title",
    "company",
    "location",
    "seniority_focus",
    "key_skills",
    "role_brief",
    "hiring_post_markdown",
  ],
  additionalProperties: false,
  properties: {
    role_title: { type: "string" },
    company: { type: "string" },
    location: { type: "string" },
    seniority_focus: { type: "string" },
    key_skills: { type: "array", items: { type: "string" } },
    role_brief: { type: "string" },
    hiring_post_markdown: { type: "string" },
  },
};

const REQUIRED_FIELDS = candidateItemSchema.required;

/**
 * Validate a single candidate against the contract. Returns an array of
 * human-readable problems (empty array means valid). Pure — never throws.
 *
 * @param {unknown} candidate
 * @returns {string[]}
 */
export function validateCandidate(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return ["not an object"];
  }
  const problems = [];

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(candidate, field)) {
      problems.push(`missing field '${field}'`);
    }
  }
  for (const field of STRING_FIELDS) {
    if (Object.hasOwn(candidate, field) && typeof candidate[field] !== "string") {
      problems.push(`field '${field}' is not a string`);
    }
  }
  for (const field of NUMBER_FIELDS) {
    if (Object.hasOwn(candidate, field) && typeof candidate[field] !== "number") {
      problems.push(`field '${field}' is not a number`);
    }
  }

  // top_skills: non-empty array of strings.
  if (Object.hasOwn(candidate, "top_skills")) {
    const skills = candidate.top_skills;
    if (!Array.isArray(skills) || skills.length === 0) {
      problems.push("field 'top_skills' is not a non-empty array");
    } else if (!skills.every((s) => typeof s === "string")) {
      problems.push("field 'top_skills' contains non-string values");
    }
  }

  // Numeric ranges.
  if (typeof candidate.match_score === "number" && (candidate.match_score < 0 || candidate.match_score > 100)) {
    problems.push(`field 'match_score' value ${candidate.match_score} not in 0..100`);
  }
  if (typeof candidate.years_experience === "number" && candidate.years_experience < 0) {
    problems.push(`field 'years_experience' value ${candidate.years_experience} is negative`);
  }

  // Enum membership.
  for (const [field, allowed] of ENUM_FIELDS) {
    const value = candidate[field];
    if (typeof value === "string" && !allowed.includes(value)) {
      problems.push(`field '${field}' value '${value}' not in allowed set`);
    }
  }

  // No unexpected fields.
  for (const key of Object.keys(candidate)) {
    if (!REQUIRED_FIELDS.includes(key)) {
      problems.push(`unexpected field '${key}'`);
    }
  }

  return problems;
}

/**
 * Format a sequential candidate id like CAND-0001.
 *
 * @param {number} index 1-based index.
 * @returns {string}
 */
export function formatCandidateId(index) {
  return `CAND-${String(index).padStart(4, "0")}`;
}
