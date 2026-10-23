import { z } from "zod";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const MECHANICS = ["free_item", "amount_off", "percent_off", "bundle_price", "catering_promo"] as const;
export const AUDIENCES = ["email_list", "in_store_qr", "email_and_qr", "catering_leads"] as const;

const Evidence = z.object({
  tool_call_id: z.string().describe("The id of the tool call the number came from"),
  field: z.string().describe('Path to the number in that tool result, e.g. "rows[3].sales" or "drink_attach_pct"'),
  value: z.number().describe("The number exactly as the tool returned it"),
  label: z.string().max(120).describe("What the number is, in plain words"),
});

export const Finding = z.object({
  title: z.string().max(100),
  detail: z.string().max(400),
  evidence: z.array(Evidence).min(1).max(6),
});

export const Proposal = z.object({
  title: z.string().max(80).describe('Short name of the offer, e.g. "Free cookie with any footlong after 7 pm"'),
  mechanic: z.enum(MECHANICS),
  item: z.string().max(60).describe("What is free or discounted"),
  qualifying_purchase: z.string().max(80).describe('What the customer must buy, e.g. "any footlong", or "none"'),
  value_usd: z.number().nonnegative().optional().describe("Retail value of the free item, or dollars off"),
  percent_off: z.number().min(0).max(100).optional(),
  days: z.array(z.enum(DAYS)).min(1),
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(1).max(24).describe("Hour the offer ends, 24-hour clock (17 = 5 pm)"),
  duration_weeks: z.number().int().min(1).max(8),
  audience: z.enum(AUDIENCES),
  why: z.string().max(500).describe("Why this store should run it, citing the numbers in evidence"),
  expected_effect: z.string().max(200).describe("What should change and how the owner will see it"),
  confidence: z.enum(["low", "medium", "high"]),
  baseline_key: z.string().optional().describe("Set when this changes one of the standard ideas"),
  evidence: z.array(Evidence).min(1).max(8),
});

export const BaselineDecision = z.object({
  key: z.string(),
  action: z.enum(["keep", "change", "drop"]),
  reason: z.string().max(300),
});

export const Submission = z.object({
  findings: z.array(Finding).max(8),
  proposals: z.array(Proposal).max(5),
  baseline_decisions: z.array(BaselineDecision).max(10).default([]),
});

export type Evidence = z.infer<typeof Evidence>;
export type Finding = z.infer<typeof Finding>;
export type Proposal = z.infer<typeof Proposal>;
export type BaselineDecision = z.infer<typeof BaselineDecision>;
export type Submission = z.infer<typeof Submission>;

const evidenceJson = {
  type: "array",
  items: {
    type: "object",
    properties: {
      tool_call_id: { type: "string" },
      field: { type: "string" },
      value: { type: "number" },
      label: { type: "string" },
    },
    required: ["tool_call_id", "field", "value", "label"],
    additionalProperties: false,
  },
};

/** JSON Schema for the final submit_analysis tool. */
export const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { title: { type: "string" }, detail: { type: "string" }, evidence: evidenceJson },
        required: ["title", "detail", "evidence"],
        additionalProperties: false,
      },
    },
    proposals: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          mechanic: { type: "string", enum: [...MECHANICS] },
          item: { type: "string" },
          qualifying_purchase: { type: "string" },
          value_usd: { type: "number" },
          percent_off: { type: "number" },
          days: { type: "array", items: { type: "string", enum: [...DAYS] } },
          start_hour: { type: "integer" },
          end_hour: { type: "integer" },
          duration_weeks: { type: "integer" },
          audience: { type: "string", enum: [...AUDIENCES] },
          why: { type: "string" },
          expected_effect: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          baseline_key: { type: "string" },
          evidence: evidenceJson,
        },
        required: ["title", "mechanic", "item", "qualifying_purchase", "days", "start_hour", "end_hour", "duration_weeks", "audience", "why", "expected_effect", "confidence", "evidence"],
        additionalProperties: false,
      },
    },
    baseline_decisions: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, action: { type: "string", enum: ["keep", "change", "drop"] }, reason: { type: "string" } },
        required: ["key", "action", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings", "proposals", "baseline_decisions"],
  additionalProperties: false,
};
