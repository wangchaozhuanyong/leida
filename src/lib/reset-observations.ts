import {observedEvidence as evidenceProjection,resetObservations as projection} from '../../miniprogram/utils/reset-observations.js';
import type {Evidence} from './types';
import type {PublicFactsData} from './public-facts';
export interface ResetObservation {
  kind:'automatic_reset';observedAt:string;collectedAt:string;evidenceId:string;
  sourceId:string;sourceName:string;sourceUrl:string;referenceUrl:string;sourceType:'observed';
  eventId:string;publicationId:string;
}
export const resetObservations=projection as (data:PublicFactsData)=>ResetObservation[];
export const observedEvidence=evidenceProjection as (evidence:Evidence,now:string)=>Omit<ResetObservation,'eventId'|'publicationId'>|null;
