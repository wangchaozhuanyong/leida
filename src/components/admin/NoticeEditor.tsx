'use client';
import { useState } from 'react';
import type { Notice } from '@/lib/types';
import type { SectionProps } from './ReviewSection';
import { Badge, DateText, Dialog, Empty, Field, Panel, Table } from './common';

export function NoticeEditor({data,command,busy,preview,go}:SectionProps){
  const [open,setOpen]=useState(false),[confirming,setConfirming]=useState(false),[title,setTitle]=useState(''),[body,setBody]=useState(''),[requestId,setRequestId]=useState(''),[withdrawing,setWithdrawing]=useState<Notice|null>(null);
  const labels={announcement:'发放预告',result:'完成声明',activity:'活动更新',correction:'重要更正',system:'站内信'};
  return <><Panel title="站内信与自动提醒" description="站内信向所有读者公开展示；自动提醒随关键公告生成。" aside={<button className="adm-button adm-primary" disabled={preview||busy} onClick={()=>{if(!requestId)setRequestId(crypto.randomUUID());setConfirming(false);setOpen(true);}}>发布站内信</button>}>
    {data.notices.length?<Table head={['消息','类型','状态','发布时间','操作']}>{data.notices.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(n=><tr key={n.id}><td className="adm-cell-title">{n.title}<small>{n.summary}</small></td><td>{n.categories.map(c=>labels[c]).join('、')}</td><td><Badge value={n.status}>{n.status==='active'?'已发布':'已撤回'}</Badge></td><td><DateText value={n.createdAt}/></td><td>{n.origin==='admin'?n.status==='active'?<button className="adm-text-link" disabled={preview||busy} onClick={()=>setWithdrawing(n)}>撤回</button>:<span className="adm-muted">已保留记录</span>:<button className="adm-text-link" onClick={()=>go(`events/${n.eventId}`)}>查看关联公告</button>}</td></tr>)}</Table>:<Empty title="暂无消息" text="可以发布站内信，预告、完成与重要更正也会在这里形成自动提醒。"/>}
  </Panel>
  {open&&<Dialog title={confirming?'预览站内信':'发布站内信'} onClose={()=>{if(!busy)setOpen(false);}}><form className="adm-dialog-body adm-form-stack" data-unsaved-changes={!!(title||body)} onSubmit={async e=>{e.preventDefault();if(!confirming){if(!requestId)setRequestId(crypto.randomUUID());setConfirming(true);return;}if(await command('notice.publish',{title,body,requestId})){setOpen(false);setTitle('');setBody('');setRequestId('');}}}>
    {confirming?<><h3>{title}</h3><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{body}</p><p className="adm-muted">发布后所有读者均可在站内信查看，不发送微信消息。</p></>:<><Field label="标题"><input value={title} required minLength={2} maxLength={80} onChange={e=>{setTitle(e.target.value);setRequestId('');}}/></Field><Field label="正文"><textarea value={body} required minLength={2} maxLength={5000} rows={8} onChange={e=>{setBody(e.target.value);setRequestId('');}}/></Field></>}
    <div className="adm-dialog-actions"><button type="button" className="adm-button" disabled={busy} onClick={()=>confirming?setConfirming(false):setOpen(false)}>{confirming?'返回修改':'取消'}</button><button className="adm-button adm-primary" disabled={busy||preview}>{busy?'发布中':confirming?'确认发布':'预览'}</button></div>
  </form></Dialog>}
  {withdrawing&&<Dialog title="撤回站内信" onClose={()=>{if(!busy)setWithdrawing(null);}}><div className="adm-dialog-body"><p>撤回「{withdrawing.title}」后，用户端不再显示，后台保留记录。</p><div className="adm-dialog-actions"><button className="adm-button" onClick={()=>setWithdrawing(null)}>取消</button><button className="adm-button adm-primary" disabled={busy||preview} onClick={async()=>{if(await command('notice.withdraw',{id:withdrawing.id}))setWithdrawing(null);}}>确认撤回</button></div></div></Dialog>}
  </>;
}
