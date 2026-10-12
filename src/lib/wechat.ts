/** Safe configuration only. Credentials and recipient identifiers never enter public data. */
export interface WechatSettings {
  appId:string; qrEnabled:boolean; subscriptionsEnabled:boolean;
  envVersion:'release'|'trial'|'develop'; templateId:string;
  templateFields:{title:string;status:string;time:string};
  dailyApiLimit:number; dailyQrLimit:number; dailySendLimit:number;
  version:number; hasSecret:boolean; updatedAt?:string;
  callsToday?:number; codesToday?:number; sendsToday?:number;
  deliveries?:{queued:number;sent:number;rejected:number;unknown:number;cancelled:number};
}
export type WechatGrantState='challenged'|'available'|'reserved'|'consumed'|'rejected'|'revoked'|'unknown';
export interface WechatSubscriptionState {
  configured:boolean; enabled:boolean; state:'unavailable'|'none'|WechatGrantState;
  templateId?:string; acceptedAt?:string;
  lastResult?:'sent'|'rejected'|'unknown'|'cancelled';
}
export interface WechatReader {
  id:string; appId:string; openidHash:string; encryptedOpenid:string;
  status:'active'|'disabled'; createdAt:string; lastLoginAt:string;
  sessions:{hash:string;createdAt:string;expiresAt:string}[];
}
export interface WechatGrant {
  id:string; readerId:string; appId:string; templateId:string; status:WechatGrantState;
  nonceHash:string; nonceExpiresAt:string; requestedAt:string; acceptedAt?:string;
  confirmedNonceHash?:string; deliveryId?:string; updatedAt:string;
}
export interface WechatDelivery {
  id:string; readerId:string; grantId:string; appId:string; templateId:string;
  noticeId:string; publicationId:string; semanticKey:string;
  status:'queued'|'sending'|'sent'|'rejected'|'unknown'|'cancelled';
  createdAt:string; attemptedAt?:string; finishedAt?:string;
  errorCode?:number; reason?:string; attempts:number; jobAttempt?:number;
}
