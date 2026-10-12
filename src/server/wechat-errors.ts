import {DomainError} from './domain';
export type WechatFailure='configuration'|'budget'|'transient'|'rejected'|'unknown';
export class WechatServiceError extends DomainError {
  constructor(message:string,public failureKind:WechatFailure,public errorCode?:number){super(message,failureKind==='budget'?429:503);}
}
