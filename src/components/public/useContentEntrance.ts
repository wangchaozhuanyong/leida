'use client';
import {useLayoutEffect,useRef,useState} from 'react';

/** First usable content enters once per read identity; revalidation never hides it. */
export function useContentEntrance(key:string,ready:boolean) {
  const seen=useRef(new Set<string>());
  const [entering,setEntering]=useState('');
  useLayoutEffect(()=>{
    if(!ready||seen.current.has(key)){setEntering('');return;}
    seen.current.add(key);
    if(seen.current.size>20)seen.current.delete(seen.current.values().next().value!);
    setEntering(key);
    const timer=window.setTimeout(()=>setEntering(''),560);
    const stop=()=>{if(document.visibilityState==='hidden')setEntering('');};
    document.addEventListener('visibilitychange',stop);
    return ()=>{window.clearTimeout(timer);document.removeEventListener('visibilitychange',stop);};
  },[key,ready]);
  return ready&&entering===key?'pub-content-enter':'';
}
