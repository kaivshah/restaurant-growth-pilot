/**
 * Parts of the app that are switched off for now and come back later.
 * Both default to off; set the variable to "on" in .env to use them.
 */

/** Looking up a contact (Hunter) when a pitch is written. Off: pitches greet "Hi there" and the owner adds a contact if they like. */
export const contactLookupOn = (env: NodeJS.ProcessEnv = process.env) => (env.CONTACT_LOOKUP ?? "off").toLowerCase() === "on";

/** Sending from Gmail (pitches, follow-ups, customer offers), reply checks and the pipeline. Off: approved drafts are copied and sent by hand. */
export const emailSendingOn = (env: NodeJS.ProcessEnv = process.env) => (env.EMAIL_SENDING ?? "off").toLowerCase() === "on";
