/** Provider-neutral input; this package makes no network model call. */
export interface ChoiceContent { state: string; questions: { decision: { type: "choice"; instructions: string; criteria: Record<string, string> } }; }
