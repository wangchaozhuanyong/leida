'use client';
import { useState } from 'react';
import type { Notice } from '@/lib/types';
import { compareNotices } from '@/lib/notice-display';
import type { SectionProps } from './ReviewSection';
import { Badge, DateText, Dialog, Empty, Field, Panel, Table } from './common';

export function NoticeEditor({data,command,busy,preview}:SectionProps){
  const [open,setOpen]=useState(false),[confirming,setConfirming]=useState(false),[title,setTitle]=useState(''),[body,setBody]=useState(''),[createdAt,setCreatedAt]=useState(''),[pinned,setPinned]=useState(false),[requestId,setRequestId]=useState(''),[withdrawing,setWithdrawing]=useState<Notice|null>(null);
  const messages=data.notices.filter(n=>n.origin==='admin').sort(compareNotices);
  return <><Panel title="站内信" description="仅展示我们手动发布的公告，不自动收录重置消息，也不发送微信提醒。" aside={<button className="adm-button adm-primary" disabled={preview||busy} onClick={()=>{if(!requestId)setRequestId(crypto.randomUUID());setConfirming(false);setOpen(true);}}>发布站内信</button>}>
    {messages.length?<Table head={['消息','状态','显示日期','操作']}>{messages.map(n=><tr key={n.id}>
      <td className="adm-cell-title">{n.pinned&&n.status==='active'&&<span>置顶 · </span>}{n.title}<small>{n.summary}</small></td>
      <td><Badge value={n.status}>{n.status==='active'?'已发布':'已撤回'}</Badge></td><td><DateText value={n.createdAt}/></td>
      <td>{n.status==='active'?<><button className="adm-text-link" disabled={preview||busy} onClick={()=>void command('notice.pin',{id:n.id,pinned:!n.pinned,expectedPinned:!!n.pinned})}>{n.pinned?'取消置顶':'置顶'}</button>{' '}<button className="adm-text-link" disabled={preview||busy} onClick={()=>setWithdrawing(n)}>撤回</button></>:<span className="adm-muted">已保留记录</span>}</td>
    </tr>)}</Table>:<Empty title="暂无站内信" text="发布上线公告、功能说明或更新消息，让用户在这里查看。"/>}
  </Panel>
  {open&&<Dialog title={confirming?'预览站内信':'发布站内信'} onClose={()=>{if(!busy)setOpen(false);}}><form className="adm-dialog-body adm-form-stack" data-unsaved-changes={!!(title||body||createdAt||pinned)} onSubmit={async e=>{e.preventDefault();if(!confirming){if(!requestId)setRequestId(crypto.randomUUID());setConfirming(true);return;}if(await command('notice.publish',{title,body,pinned,requestId,...(createdAt?{createdAt:new Date(`${createdAt}+08:00`).toISOString()}:{})})){setOpen(false);setTitle('');setBody('');setCreatedAt('');setPinned(false);setRequestId('');}}}>
    {confirming?<>{pinned&&<p>置顶公告</p>}<h3>{title}</h3><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{body}</p><p className="adm-muted">显示日期：{createdAt?`${createdAt.replace('T',' ')} 北京时间`:'使用实际发布时间'}。实际操作时间保留在审计记录。</p><p className="adm-muted">发布后所有读者均可在站内信查看，不发送微信消息。</p></>:<>
      <Field label="标题"><input value={title} required minLength={2} maxLength={80} onChange={e=>{setTitle(e.target.value);setRequestId('');}}/></Field>
      <Field label="正文"><textarea value={body} required minLength={2} maxLength={5000} rows={8} onChange={e=>{setBody(e.target.value);setRequestId('');}}/></Field>
      <Field label="显示日期（北京时间，可留空）"><input type="datetime-local" value={createdAt} max={new Date(Date.now()+8*3600_000).toISOString().slice(0,16)} onChange={e=>{setCreatedAt(e.target.value);setRequestId('');}}/><small>可选择历史日期，留空使用当前时间；实际操作时间保留在审计记录。</small></Field>
      <label><input type="checkbox" checked={pinned} onChange={e=>{setPinned(e.target.checked);setRequestId('');}}/> 置顶这条站内信</label><small className="adm-muted">置顶在普通消息之前；同组按显示日期从新到旧排列。</small>
    </>}
    <div className="adm-dialog-actions"><button type="button" className="adm-button" disabled={busy} onClick={()=>confirming?setConfirming(false):setOpen(false)}>{confirming?'返回修改':'取消'}</button><button className="adm-button adm-primary" disabled={busy||preview}>{busy?'发布中':confirming?'确认发布':'预览'}</button></div>
  </form></Dialog>}
  {withdrawing&&<Dialog title="撤回站内信" onClose={()=>{if(!busy)setWithdrawing(null);}}><div className="adm-dialog-body"><p>撤回「{withdrawing.title}」后，用户端不再显示，后台保留记录。</p><div className="adm-dialog-actions"><button className="adm-button" onClick={()=>setWithdrawing(null)}>取消</button><button className="adm-button adm-primary" disabled={busy||preview} onClick={async()=>{if(await command('notice.withdraw',{id:withdrawing.id}))setWithdrawing(null);}}>确认撤回</button></div></div></Dialog>}
  </>;
}
