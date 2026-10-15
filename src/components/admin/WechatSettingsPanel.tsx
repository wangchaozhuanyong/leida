'use client';
import { useState } from 'react';
import type { WechatSettings } from '@/lib/wechat';
import type { SectionProps } from './ReviewSection';
import { Field, Panel } from './common';

const emptySettings: WechatSettings = { appId: '', qrEnabled: false, subscriptionsEnabled: false, envVersion: 'release', templateId: '', templateFields: { title: '', status: '', time: '' }, dailyApiLimit: 0, dailyQrLimit: 0, dailySendLimit: 0, version: 1, hasSecret: false };
export function WechatSettingsPanel({ data, command, busy, preview }: SectionProps) {
  const saved = data.wechat ?? emptySettings;
  const [value, setValue] = useState<WechatSettings>(saved);
  const [secret, setSecret] = useState('');
  const patch = (next: Partial<WechatSettings>) => setValue(previous => ({ ...previous, ...next }));
  const numberField = (name: 'dailyApiLimit' | 'dailyQrLimit' | 'dailySendLimit', label: string) => <Field label={label}><input type="number" min={0} max={name === 'dailyApiLimit' ? 100000 : 10000} step={1} required value={value[name]} onChange={event => patch({ [name]: Number(event.target.value) })} /></Field>;
  return <div className="adm-settings-grid">
    <Panel title="微信小程序连接" description="配置一次后按发布结果运行；网站发布不会等待微信发送">
      <form className="adm-panel-body adm-form-stack" onSubmit={async event => {
        event.preventDefault();
        const { hasSecret: _stored, callsToday: _calls, codesToday: _codes, sendsToday: _sends, deliveries: _deliveries, ...configuration } = value;
        if (await command('settings.wechat', { ...configuration, ...(secret.trim() ? { secret: secret.trim() } : {}) })) setSecret('');
      }}>
        <fieldset disabled={preview || busy}>
          <Field label="小程序编号" hint="填写本人注册的小程序编号，勿使用游客占位。"><input autoComplete="off" maxLength={32} value={value.appId} onChange={event => patch({ appId: event.target.value.trim() })} /></Field>
          <Field label="小程序密钥" hint={saved.hasSecret ? '密钥已保存。留空沿用；更换编号时应重新填写对应密钥。' : '仅在服务端加密保存，不会进入小程序或公开接口。'}><input type="password" autoComplete="new-password" maxLength={256} value={secret} onChange={event => setSecret(event.target.value)} /></Field>
          <Field label="圆码使用版本"><select value={value.envVersion} onChange={event => patch({ envVersion: event.target.value as WechatSettings['envVersion'] })}><option value="release">正式版</option><option value="trial">体验版</option><option value="develop">开发版</option></select></Field>
          <label className="adm-check"><input type="checkbox" checked={value.qrEnabled} onChange={event => patch({ qrEnabled: event.target.checked })} />启用真正小程序码</label>
          <label className="adm-check"><input type="checkbox" checked={value.subscriptionsEnabled} onChange={event => patch({ subscriptionsEnabled: event.target.checked })} />启用微信订阅提醒（次数可累积）</label>
          <Field label="订阅模板编号" hint="从微信后台实际可用模板中填写，不预设虚构模板。"><input autoComplete="off" maxLength={128} value={value.templateId} onChange={event => patch({ templateId: event.target.value.trim() })} /></Field>
          <div className="adm-inline-note">将实际模板中的标题、状态和时间字段对应填入下方。每次用户成功授权增加一次提醒机会，按不同的新预告、完成声明或重要更正使用，不自动增加次数。</div>
          {(['title', 'status', 'time'] as const).map(name => <Field key={name} label={{ title: '标题字段', status: '状态字段', time: '时间字段' }[name]}><input autoComplete="off" maxLength={30} value={value.templateFields[name]} onChange={event => patch({ templateFields: { ...value.templateFields, [name]: event.target.value.trim() } })} /></Field>)}
          {numberField('dailyApiLimit', '每日接口调用上限')}
          {numberField('dailyQrLimit', '每日圆码生成上限')}
          {numberField('dailySendLimit', '每日提醒发送上限')}
          <p className="adm-muted">上限为零时不发起对应调用。登录尝试每分钟最多10次，每日最多占总调用额度的四分之一（不足4次时最多1次）。微信发送失败、拒绝或结果不明分别记录；结果不明不会自动重发。</p>
          <div className="adm-form-actions"><button className="adm-button adm-primary">{busy ? '正在保存' : '保存微信配置'}</button></div>
        </fieldset>
        {preview && <p className="adm-muted">当前为只读样例。真实账号配置需登录管理后台。</p>}
      </form>
    </Panel>
    <Panel title="运行记录" description="只统计实际调用与发送结果，不推算送达人数"><div className="adm-panel-body">
      <dl className="adm-facts"><div><dt>今日接口调用</dt><dd>{saved.callsToday ?? '暂无记录'}</dd></div><div><dt>今日圆码生成</dt><dd>{saved.codesToday ?? '暂无记录'}</dd></div><div><dt>今日发送请求</dt><dd>{saved.sendsToday ?? '暂无记录'}</dd></div></dl>
      {saved.deliveries ? <dl className="adm-facts">{(['queued', 'sent', 'rejected', 'unknown', 'cancelled'] as const).map(state => <div key={state}><dt>{{ queued: '等待发送', sent: '微信返回发送成功', rejected: '微信拒绝', unknown: '结果不明', cancelled: '已取消' }[state]}</dt><dd>{saved.deliveries![state]}</dd></div>)}</dl> : <p className="adm-muted">尚无真实发送记录。</p>}
    </div></Panel>
  </div>;
}
