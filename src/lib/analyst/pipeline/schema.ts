import { z } from "zod";
import { Proposal } from "../schema";

/**
 * What each stage of the offer pipeline returns. Every number the stages
 * write is checked: cited values against the tool results, calculations
 * recomputed, proposals against the owner's rules.
 */

/** One number the AI worked out from the data, with the working shown so code can redo it. */
export const Calculation = z.object({
  label: z.string().max(120).describe('What the number means, e.g. "3 pm sales as a share of noon sales"'),
  inputs: z
    .array(z.object({ name: z.string().max(10).describe("A short name used in the formula: a, b, c…"), tool_call_id: z.string(), field: z.string(), value: z.number() }))
    .min(1)
    .max(6),
  formula: z.string().max(80).describe('Arithmetic over the input names, e.g. "a / b * 100" or "(a - b) / b * 100"'),
  result: z.number().describe("The formula's result, rounded to 1 decimal"),
});
export type Calculation = z.infer<typeof Calculation>;

export const Diagnosis = z.object({
  findings: z
    .array(
      z.object({
        title: z.string().max(100),
        detail: z.string().max(500).describe("The finding in plain words with its numbers, naming the report it comes from"),
        kind: z.enum(["weakness", "strength", "change", "opportunity"]),
        calculations: z.array(Calculation).max(3).default([]),
        evidence: z.array(z.object({ tool_call_id: z.string(), field: z.string(), value: z.number(), label: z.string().max(120) })).max(6).default([]),
      }),
    )
    .min(3)
    .max(10),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
export type Finding = Diagnosis["findings"][number];

/** A candidate offer: the proposal shape, plus which finding it answers and where the idea came from. */
export const Candidate = Proposal.extend({
  key: z.string().max(10).describe("c1, c2, …"),
  answers_finding: z.number().int().min(1).describe("The 1-based number of the finding this offer acts on"),
  idea_source: z.string().max(80).optional().describe("The archetype it builds on, or 'original'"),
});
export type Candidate = z.infer<typeof Candidate>;

export const Strategy = z.object({ candidates: z.array(Candidate).min(3).max(14) });
export type Strategy = z.infer<typeof Strategy>;

export const Critique = z.object({
  scores: z
    .array(
      z.object({
        key: z.string(),
        expected_lift: z.number().int().min(1).max(5).describe("5 = strong, likely lift on the weakness it targets"),
        cost_efficiency: z.number().int().min(1).max(5).describe("5 = cheap for the store relative to the sales it should bring"),
        fit: z.number().int().min(1).max(5).describe("5 = easy to run at the counter, clear to customers, fits the rules"),
        novelty: z.number().int().min(1).max(5).describe("5 = not something the owner ran or skipped recently"),
        weekly_cost: Calculation.optional().describe("Estimated weekly cost of the giveaway or discount, worked out from the data"),
        verdict: z.enum(["pick", "hold", "drop"]),
        reason: z.string().max(300),
      }),
    )
    .min(1)
    .max(14),
  picked: z.array(z.string()).min(1).max(5).describe("Candidate keys to send to the owner, strongest first, covering attract / grow sales / retain where possible"),
});
export type Critique = z.infer<typeof Critique>;

// JSON Schemas for the submit tools (what the model is shown).
const calculationJson = {
  type: "object",
  properties: {
    label: { type: "string" },
    inputs: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, tool_call_id: { type: "string" }, field: { type: "string" }, value: { type: "number" } }, required: ["name", "tool_call_id", "field", "value"], additionalProperties: false },
    },
    formula: { type: "string" },
    result: { type: "number" },
  },
  required: ["label", "inputs", "formula", "result"],
  additionalProperties: false,
};
const evidenceJson = {
  type: "array",
  items: { type: "object", properties: { tool_call_id: { type: "string" }, field: { type: "string" }, value: { type: "number" }, label: { type: "string" } }, required: ["tool_call_id", "field", "value", "label"], additionalProperties: false },
};

export const DIAGNOSIS_JSON = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          kind: { type: "string", enum: ["weakness", "strength", "change", "opportunity"] },
          calculations: { type: "array", items: calculationJson },
          evidence: evidenceJson,
        },
        required: ["title", "detail", "kind", "calculations", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

import { SUBMIT_SCHEMA } from "../schema";
const proposalJson = (SUBMIT_SCHEMA.properties.proposals as { items: { properties: Record<string, unknown>; required: string[] } }).items;
export const STRATEGY_JSON = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: { ...proposalJson.properties, key: { type: "string" }, answers_finding: { type: "integer" }, idea_source: { type: "string" } },
        required: [...proposalJson.required, "key", "answers_finding"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

export const CRITIQUE_JSON = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          expected_lift: { type: "integer" },
          cost_efficiency: { type: "integer" },
          fit: { type: "integer" },
          novelty: { type: "integer" },
          weekly_cost: calculationJson,
          verdict: { type: "string", enum: ["pick", "hold", "drop"] },
          reason: { type: "string" },
        },
        required: ["key", "expected_lift", "cost_efficiency", "fit", "novelty", "verdict", "reason"],
        additionalProperties: false,
      },
    },
    picked: { type: "array", items: { type: "string" } },
  },
  required: ["scores", "picked"],
  additionalProperties: false,
};
