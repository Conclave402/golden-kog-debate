export interface RouteResult {
    content: string;
    model?: string;
    cost_usd?: number;
}
export type Role = "sound" | "fragile" | "reviewer";
export interface RouteArgs {
    task_type: "risk_debate";
    tier_class: "text";
    complexity: "exec" | "apex";
    context_tokens: number;
    constitutional_flag: false;
    agent_id: "golden-kog";
    payload: {
        role: Role;
        system: string;
        prompt: string;
        max_tokens: number;
    };
}
export interface DebateInput {
    facts_text: string;
    level: string;
    points: number;
    flag_ids: string[];
    unknown: string[];
}
export interface DebateDeps {
    route(args: RouteArgs): Promise<RouteResult>;
    check?(text: string): string[];
    mode?: "off" | "shadow" | "on";
    log?(row: Record<string, unknown>): void;
    timeoutMs?: number;
}
export interface Debate {
    status: "ok" | "rejected" | "timeout" | "off";
    shown: boolean;
    sound: string;
    fragile: string;
    reviewer: string;
    weight: string[];
    unknown: string[];
    tension?: string;
    models: {
        sound?: string;
        fragile?: string;
        reviewer?: string;
    };
    usd: number;
    rejected: string[];
}
/** The one text a failed advocate part is replaced with. */
export declare const NO_CASE = "No case could be written from the measured facts.";
/** Number tokens written the way a reader sees them: digits with an optional decimal part. */
export declare function numbersIn(text: string): string[];
/** Every rule a part must pass, in the order the spec lists them. */
export declare function problemsIn(text: string, factsText: string, role: Role, check?: (text: string) => string[]): string[];
/**
 * Run the debate: two advocates in parallel, then one reviewer.
 * Nothing here reaches the network; every model call goes through deps.route.
 */
export declare function debate(input: DebateInput, deps: DebateDeps): Promise<Debate>;
export default debate;
