export interface AIFile {path:string; revision:number; content:string}
export interface AIRequest {requestId:string; model:string; kind:'chat'|'explain'|'fix'|'refactor'; prompt:string; files:AIFile[]; maxOutputTokens:number}
export interface AIProposal {path:string; baseRevision:number; content:string; explanation:string; diagnostics:string[]}
export const LIMITS:Readonly<{prompt:number;file:number;context:number;request:number;files:number;output:number;response:number}>;
export function safePath(path:unknown):string;
export function safeText(text:unknown,max:number):string;
export function validateRequest(raw:unknown):AIRequest;
export function buildMessages(request:AIRequest):{role:string;content:string}[];
export function validateProposal(text:string,files:AIFile[]):AIProposal;
