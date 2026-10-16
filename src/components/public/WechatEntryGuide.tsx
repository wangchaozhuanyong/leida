'use client';
import {useEffect,useRef,useState} from 'react';

const appName='模钥重置雷达';
const codes=new Map<string,string>();
/** Reuse the existing version-bound mini-program code API; never request a code merely by rendering an entry. */
export async function loadEntryCode(id:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<string> {
  const cached=codes.get(id);if(cached)return cached;
  const response=await fetcher(`/api/v1/wechat/code/${encodeURIComponent(id)}`,{signal,cache:'no-store'});
  if(!response.ok)throw new Error('小程序码暂不可用，请按下方步骤进入。');
  const {data}=await response.json();
  if(data?.publicationId!==id||!['image/png','image/jpeg'].includes(data?.contentType)||typeof data.imageBase64!=='string'||data.imageBase64.length>3000000||!data.imageBase64.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.imageBase64))throw new Error('小程序码暂不可用，请按下方步骤进入。');
  const image=`data:${data.contentType};base64,${data.imageBase64}`;
  if(codes.size>=5)codes.delete(codes.keys().next().value!);
  codes.set(id,image);return image;
}
export function WechatEntryGuide({publicationId,codeAvailable=false}:{publicationId?:string;codeAvailable?:boolean}) {
  const [image,setImage]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{setImage('');setMessage('');setBusy(false);return()=>{const work=controller.current;controller.current=null;work?.abort();};},[publicationId]);
  async function showCode(){
    if(!publicationId||busy)return;
    const work=new AbortController();controller.current=work;setBusy(true);setMessage('');
    const timeout=setTimeout(()=>work.abort(),10000);
    try{const result=await loadEntryCode(publicationId,work.signal);if(controller.current===work&&!work.signal.aborted)setImage(result);}
    catch{if(controller.current===work)setMessage('小程序码暂不可用，请按下方步骤进入。');}
    finally{clearTimeout(timeout);if(controller.current===work)setBusy(false);}
  }
  return <div className="pub-wechat-entry">
    <p>在微信中打开：<strong>{appName}</strong></p>
    <ol><li>打开微信，使用“搜一搜”查找上方名称，选择“小程序”。</li><li>点击底部“提醒”，查看次数并选择要接收的类型。</li><li>按需要开启、增加次数或关闭提醒。</li></ol>
    {publicationId&&codeAvailable&&<>{image?<figure className="pub-mini-entry-code"><img src={image} width="208" height="208" alt="微信扫码进入模钥重置雷达小程序"/><figcaption>扫码进入后，点击底部“提醒”。<br/>同一部手机可按上方步骤从微信查找。</figcaption></figure>:<button className="pub-button full" disabled={busy} onClick={()=>void showCode()}>{busy?'正在获取小程序码…':'显示小程序码'}</button>}</>}
    {message&&<p role="status">{message}</p>}
  </div>;
}
